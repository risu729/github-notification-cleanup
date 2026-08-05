import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runNotificationCleanup } from "../src";
import type { Summary } from "../src/triage";

type CleanupRunRow = {
  error: string | null;
  force_check_all: number;
  scheduled_at: string | null;
  since: string | null;
  status: "failure" | "success";
  summary: string;
};

type CleanupStateRow = {
  force_check_all: number;
  last_checked_at: string | null;
};

const response = (body: unknown, status = 200): Response => {
  return Response.json(body, { status });
};

const mockGitHub = (notifications: unknown[] = []): void => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
    const pathname = new URL(url).pathname;
    if (pathname === "/user") {
      return response({ id: 79_110_363, login: "risu729" });
    }
    if (pathname === "/notifications") {
      return response(notifications);
    }
    return response({ message: "unexpected test request" }, 500);
  });
};

const loadState = async (): Promise<CleanupStateRow | null> => {
  return await env.DB.prepare(
    "SELECT last_checked_at, force_check_all FROM cleanup_state WHERE singleton = 1",
  ).first<CleanupStateRow>();
};

const loadRuns = async (): Promise<CleanupRunRow[]> => {
  const { results } = await env.DB.prepare(
    `
      SELECT status, force_check_all, since, scheduled_at, summary, error
      FROM cleanup_runs
      ORDER BY id
    `,
  ).all<CleanupRunRow>();
  return results;
};

const requestFullCheck = async (): Promise<void> => {
  await env.DB.prepare("UPDATE cleanup_state SET force_check_all = 1 WHERE singleton = 1").run();
};

describe("scheduled Worker state", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM cleanup_runs"),
      env.DB.prepare(
        "UPDATE cleanup_state SET last_checked_at = NULL, force_check_all = 0 WHERE singleton = 1",
      ),
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("stores a successful run and advances the checkpoint", async () => {
    mockGitHub();

    await runNotificationCleanup(env, { scheduledAt: "2026-08-04T00:00:00Z" });

    const state = await loadState();
    expect(Date.parse(state?.last_checked_at ?? "invalid")).not.toBeNaN();
    const [run] = await loadRuns();
    expect(run).toMatchObject({
      error: null,
      force_check_all: 0,
      scheduled_at: "2026-08-04T00:00:00Z",
      since: null,
      status: "success",
    });
    expect(JSON.parse(run?.summary ?? "null")).toMatchObject<Summary>({
      aiReviewMarkedDone: 0,
      evaluated: 0,
      markedDone: 0,
      notifications: 0,
      pullRequests: 0,
      renovateMarkedDone: 0,
      retained: 0,
    });
  });

  test("records a failed run without advancing the checkpoint", async () => {
    const previousCheckpoint = "2026-08-04T00:00:00Z";
    await env.DB.prepare("UPDATE cleanup_state SET last_checked_at = ? WHERE singleton = 1")
      .bind(previousCheckpoint)
      .run();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ message: "failure" }, 500));

    await expect(runNotificationCleanup(env)).rejects.toThrow();

    await expect(loadState()).resolves.toMatchObject({ last_checked_at: previousCheckpoint });
    const [run] = await loadRuns();
    expect(run).toMatchObject({
      force_check_all: 0,
      since: previousCheckpoint,
      status: "failure",
    });
    expect(run?.error).toContain("GitHub API request failed: 500");
  });

  test("records the partial summary when a run fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const pathname = new URL(url).pathname;
      if (pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      if (pathname === "/notifications") {
        return response([
          {
            id: "1",
            subject: {
              type: "PullRequest",
              url: "https://api.github.com/repos/owner/repo/pulls/1",
            },
          },
        ]);
      }
      return response({ message: "failure" }, 500);
    });

    await expect(runNotificationCleanup(env)).rejects.toThrow();

    const [run] = await loadRuns();
    expect(JSON.parse(run?.summary ?? "null")).toMatchObject<Summary>({
      aiReviewMarkedDone: 0,
      evaluated: 0,
      markedDone: 0,
      notifications: 1,
      pullRequests: 1,
      renovateMarkedDone: 0,
      retained: 0,
    });
  });

  test("retains a queued full-check request after failure", async () => {
    await requestFullCheck();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ message: "failure" }, 500));

    await expect(runNotificationCleanup(env)).rejects.toThrow();

    await expect(loadState()).resolves.toMatchObject({ force_check_all: 1 });
    const [run] = await loadRuns();
    expect(run).toMatchObject({ force_check_all: 1, since: null, status: "failure" });
  });

  test("consumes a queued full-check request after success", async () => {
    mockGitHub();
    await requestFullCheck();

    await runNotificationCleanup(env);

    await expect(loadState()).resolves.toMatchObject({ force_check_all: 0 });
    const [run] = await loadRuns();
    expect(run).toMatchObject({ force_check_all: 1, since: null, status: "success" });
  });

  test("preserves earlier run history", async () => {
    mockGitHub();

    await runNotificationCleanup(env);
    await runNotificationCleanup(env);

    const runs = await loadRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]?.since).toBeNull();
    expect(Date.parse(runs[1]?.since ?? "invalid")).not.toBeNaN();
  });

  test("falls back to a full scan for an invalid checkpoint", async () => {
    mockGitHub();
    await env.DB.prepare("UPDATE cleanup_state SET last_checked_at = ? WHERE singleton = 1")
      .bind("invalid")
      .run();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await runNotificationCleanup(env);

    expect(
      warning.mock.calls.some(([message]) =>
        String(message).includes("notification_state_invalid"),
      ),
    ).toBe(true);
    const [run] = await loadRuns();
    expect(run?.since).toBeNull();
    const state = await loadState();
    expect(Date.parse(state?.last_checked_at ?? "invalid")).not.toBeNaN();
  });
});
