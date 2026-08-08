import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runNotificationCleanup } from "../src";
import type { Summary } from "../src/triage";

type CleanupRunRow = {
  error: string | null;
  full_scan: number;
  scheduled_at: string | null;
  since: string | null;
  status: "failure" | "partial" | "success";
  summary: string;
};

type CleanupStateRow = {
  full_scan_requested: number;
  last_checked_at: string | null;
};

const response = (body: unknown, status = 200, headers?: HeadersInit): Response => {
  return Response.json(body, headers === undefined ? { status } : { headers, status });
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
    "SELECT last_checked_at, full_scan_requested FROM cleanup_state WHERE singleton = 1",
  ).first<CleanupStateRow>();
};

const loadRuns = async (): Promise<CleanupRunRow[]> => {
  const { results } = await env.DB.prepare(
    `
      SELECT status, full_scan, since, scheduled_at, summary, error
      FROM cleanup_runs
      ORDER BY id
    `,
  ).all<CleanupRunRow>();
  return results;
};

const pullNotification = (id: string, pullNumber: number): Record<string, unknown> => {
  return {
    id,
    last_read_at: "2026-08-03T00:00:00Z",
    subject: {
      type: "PullRequest",
      url: `https://api.github.com/repos/owner/repo/pulls/${pullNumber}`,
    },
    unread: false,
    updated_at: "2026-08-04T00:00:00Z",
  };
};

const requestFullScan = async (): Promise<void> => {
  await env.DB.prepare(
    "UPDATE cleanup_state SET full_scan_requested = 1 WHERE singleton = 1",
  ).run();
};

describe("scheduled Worker state", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM cleanup_run_notifications"),
      env.DB.prepare("DELETE FROM notification_retries"),
      env.DB.prepare("DELETE FROM cleanup_runs"),
      env.DB.prepare(
        "UPDATE cleanup_state SET last_checked_at = NULL, full_scan_requested = 0 WHERE singleton = 1",
      ),
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("stores a successful run and advances the checkpoint", async () => {
    mockGitHub();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runNotificationCleanup(env, { scheduledAt: "2026-08-04T00:00:00Z" });

    expect(log).toHaveBeenCalledWith({
      aiReviewMarkedDone: 0,
      evaluated: 0,
      event: "triage_summary",
      fullScan: false,
      markedDone: 0,
      notifications: 0,
      pullRequests: 0,
      renovateMarkedDone: 0,
      retained: 0,
      retried: 0,
      retryPending: 0,
      since: null,
    });
    const state = await loadState();
    expect(Date.parse(state?.last_checked_at ?? "invalid")).not.toBeNaN();
    const [run] = await loadRuns();
    expect(run).toMatchObject({
      error: null,
      full_scan: 0,
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
      retried: 0,
      retryPending: 0,
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
      full_scan: 0,
      since: previousCheckpoint,
      status: "failure",
    });
    expect(run?.error).toContain("GitHub API request failed: 500");
  });

  test("records an item failure, advances the checkpoint, and continues", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const pathname = new URL(url).pathname;
      if (pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      if (pathname === "/notifications") {
        return response([pullNotification("1", 1), pullNotification("2", 2)]);
      }
      if (pathname === "/repos/owner/repo/pulls/2") {
        return response({
          auto_merge: null,
          html_url: "https://github.com/owner/repo/pull/2",
          user: { id: 1 },
        });
      }
      if (pathname === "/repos/owner/repo/issues/2/timeline") {
        return response([]);
      }
      return response({ message: "failure" }, 500, {
        "x-github-request-id": "request-123",
        "x-ratelimit-remaining": "4999",
      });
    });

    await runNotificationCleanup(env);

    const [run] = await loadRuns();
    expect(run?.status).toBe("partial");
    expect(JSON.parse(run?.summary ?? "null")).toMatchObject<Summary>({
      aiReviewMarkedDone: 0,
      evaluated: 1,
      markedDone: 0,
      notifications: 2,
      pullRequests: 2,
      renovateMarkedDone: 0,
      retained: 1,
      retried: 0,
      retryPending: 1,
    });
    const state = await loadState();
    expect(Date.parse(state?.last_checked_at ?? "invalid")).not.toBeNaN();
    const audits = await env.DB.prepare(
      `
        SELECT notification_id, outcome, error_status, github_request_id
        FROM cleanup_run_notifications
        ORDER BY notification_id
      `,
    ).all<{
      error_status: number | null;
      github_request_id: string | null;
      notification_id: string;
      outcome: string;
    }>();
    expect(audits.results).toEqual([
      {
        error_status: 500,
        github_request_id: "request-123",
        notification_id: "1",
        outcome: "retry_pending",
      },
      {
        error_status: null,
        github_request_id: null,
        notification_id: "2",
        outcome: "retained",
      },
    ]);
    const retry = await env.DB.prepare(
      `
        SELECT notification_id, attempt_count, last_error_status
        FROM notification_retries
      `,
    ).first<{ attempt_count: number; last_error_status: number; notification_id: string }>();
    expect(retry).toMatchObject({
      attempt_count: 1,
      last_error_status: 500,
      notification_id: "1",
    });
  });

  test("retries a queued notification and removes it after evaluation", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const pathname = new URL(url).pathname;
      if (pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      if (pathname === "/notifications") {
        return response([]);
      }
      if (pathname === "/notifications/threads/1") {
        return response({
          id: "1",
          last_read_at: "2026-08-03T00:00:00Z",
          subject: {
            type: "PullRequest",
            url: "https://api.github.com/repos/owner/repo/pulls/1",
          },
          unread: false,
          updated_at: "2026-08-04T00:00:00Z",
        });
      }
      if (pathname === "/repos/owner/repo/pulls/1") {
        return response({
          auto_merge: null,
          html_url: "https://github.com/owner/repo/pull/1",
          user: { id: 1 },
        });
      }
      if (pathname === "/repos/owner/repo/issues/1/timeline") {
        return response([]);
      }
      return response({ message: "unexpected test request" }, 500);
    });
    await env.DB.prepare(
      `
        INSERT INTO notification_retries (
          notification_id,
          subject_url,
          notification_updated_at,
          last_read_at,
          unread,
          attempt_count,
          next_retry_at,
          last_error_message,
          created_at,
          updated_at
        ) VALUES ('1', ?, ?, ?, 0, 1, ?, 'failure', ?, ?)
      `,
    )
      .bind(
        "https://api.github.com/repos/owner/repo/pulls/1",
        "2026-08-04T00:00:00Z",
        "2026-08-03T00:00:00Z",
        "2026-08-04T00:00:00Z",
        "2026-08-04T00:00:00Z",
        "2026-08-04T00:00:00Z",
      )
      .run();

    await runNotificationCleanup(env);

    const [run] = await loadRuns();
    expect(run?.status).toBe("success");
    expect(JSON.parse(run?.summary ?? "null")).toMatchObject({
      evaluated: 1,
      notifications: 0,
      pullRequests: 1,
      retained: 1,
      retried: 1,
      retryPending: 0,
    });
    const retry = await env.DB.prepare("SELECT * FROM notification_retries").first();
    expect(retry).toBeNull();
  });

  test("retains a queued full-scan request after failure", async () => {
    await requestFullScan();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ message: "failure" }, 500));

    await expect(runNotificationCleanup(env)).rejects.toThrow();

    await expect(loadState()).resolves.toMatchObject({ full_scan_requested: 1 });
    const [run] = await loadRuns();
    expect(run).toMatchObject({ full_scan: 1, since: null, status: "failure" });
  });

  test("consumes a queued full-scan request after success", async () => {
    mockGitHub();
    await requestFullScan();

    await runNotificationCleanup(env);

    await expect(loadState()).resolves.toMatchObject({ full_scan_requested: 0 });
    const [run] = await loadRuns();
    expect(run).toMatchObject({ full_scan: 1, since: null, status: "success" });
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

    expect(warning).toHaveBeenCalledWith({ event: "notification_state_invalid" });
    const [run] = await loadRuns();
    expect(run?.since).toBeNull();
    const state = await loadState();
    expect(Date.parse(state?.last_checked_at ?? "invalid")).not.toBeNaN();
  });
});
