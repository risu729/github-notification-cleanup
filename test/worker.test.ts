import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import worker, { discoverAndEnqueueNotifications } from "../src";
import type { Notification, Summary } from "../src/triage";

type CleanupRunRow = {
  error: string | null;
  full_scan: number;
  id: string;
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

const notification = (id: string, pullNumber: number): Notification => ({
  attemptCount: 0,
  id,
  lastReadAt: "2026-08-03T00:00:00Z",
  subjectUrl: `https://api.github.com/repos/owner/repo/pulls/${pullNumber}`,
  unread: false,
  updatedAt: "2026-08-04T00:00:00Z",
});

const apiNotification = (id: string, pullNumber: number): Record<string, unknown> => ({
  id,
  last_read_at: "2026-08-03T00:00:00Z",
  subject: {
    type: "PullRequest",
    url: `https://api.github.com/repos/owner/repo/pulls/${pullNumber}`,
  },
  unread: false,
  updated_at: "2026-08-04T00:00:00Z",
});

const thread = (id: string, pullNumber: number): Record<string, unknown> => ({
  id,
  last_read_at: "2026-08-03T00:00:00Z",
  subject: {
    type: "PullRequest",
    url: `https://api.github.com/repos/owner/repo/pulls/${pullNumber}`,
  },
  unread: false,
  updated_at: "2026-08-04T00:00:00Z",
});

const loadState = async (): Promise<CleanupStateRow | null> => {
  return await env.DB.prepare(
    "SELECT last_checked_at, full_scan_requested FROM cleanup_state WHERE singleton = 1",
  ).first<CleanupStateRow>();
};

const loadRuns = async (): Promise<CleanupRunRow[]> => {
  const { results } = await env.DB.prepare(
    `
      SELECT id, status, full_scan, since, scheduled_at, summary, error
      FROM cleanup_runs
      ORDER BY started_at
    `,
  ).all<CleanupRunRow>();
  return results;
};

const queueBatch = (
  notifications: Notification[],
  attempts = 1,
  queueName = "github-notification-cleanup-notifications",
): MessageBatch<Notification> => {
  return createMessageBatch(
    queueName,
    notifications.map((body, index) => ({
      attempts,
      body,
      id: `message-${index}`,
      timestamp: new Date("2026-08-04T00:00:00Z"),
    })),
  );
};

describe("notification discovery", () => {
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

  test("enqueues pull requests and advances the checkpoint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response([
        apiNotification("1", 1),
        { ...apiNotification("2", 2), subject: { type: "Issue" } },
      ]),
    );
    const sendBatch = vi.spyOn(env.NOTIFICATION_QUEUE, "sendBatch").mockResolvedValue({
      metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await discoverAndEnqueueNotifications(env, { scheduledAt: "2026-08-04T00:00:00Z" });

    expect(sendBatch).toHaveBeenCalledWith([{ body: notification("1", 1), contentType: "json" }]);
    const state = await loadState();
    expect(Date.parse(state?.last_checked_at ?? "invalid")).not.toBeNaN();
    const [run] = await loadRuns();
    expect(run).toMatchObject({
      error: null,
      scheduled_at: "2026-08-04T00:00:00Z",
      status: "success",
    });
    expect(JSON.parse(run?.summary ?? "null")).toMatchObject<Summary>({
      aiReviewMarkedDone: 0,
      evaluated: 0,
      markedDone: 0,
      notifications: 2,
      pullRequests: 1,
      renovateMarkedDone: 0,
      retained: 0,
      retried: 0,
      retryExhausted: 0,
      retryPending: 0,
    });
  });

  test("migrates due D1 retries into the Queue", async () => {
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
        ) VALUES ('1', ?, ?, ?, 0, 7, ?, 'failure', ?, ?)
      `,
    )
      .bind(
        notification("1", 1).subjectUrl,
        notification("1", 1).updatedAt,
        notification("1", 1).lastReadAt,
        "2026-08-03T00:00:00Z",
        "2026-08-03T00:00:00Z",
        "2026-08-03T00:00:00Z",
      )
      .run();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response([]));
    const sendBatch = vi.spyOn(env.NOTIFICATION_QUEUE, "sendBatch").mockResolvedValue({
      metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await discoverAndEnqueueNotifications(env);

    expect(sendBatch).toHaveBeenCalledWith([
      {
        body: { ...notification("1", 1), attemptCount: 7 },
        contentType: "json",
      },
    ]);
    await expect(env.DB.prepare("SELECT * FROM notification_retries").first()).resolves.toBeNull();
  });

  test("records a failed discovery without advancing the checkpoint", async () => {
    const previousCheckpoint = "2026-08-04T00:00:00Z";
    await env.DB.prepare("UPDATE cleanup_state SET last_checked_at = ? WHERE singleton = 1")
      .bind(previousCheckpoint)
      .run();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ message: "failure" }, 500));

    await expect(discoverAndEnqueueNotifications(env)).rejects.toThrow();

    await expect(loadState()).resolves.toMatchObject({ last_checked_at: previousCheckpoint });
    const [run] = await loadRuns();
    expect(run).toMatchObject({
      error: expect.stringContaining("GitHub API request failed: 500"),
      status: "failure",
    });
  });

  test("does not advance the checkpoint when publishing fails", async () => {
    const previousCheckpoint = "2026-08-04T00:00:00Z";
    await env.DB.prepare("UPDATE cleanup_state SET last_checked_at = ? WHERE singleton = 1")
      .bind(previousCheckpoint)
      .run();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response([apiNotification("1", 1)]));
    vi.spyOn(env.NOTIFICATION_QUEUE, "sendBatch").mockRejectedValue(new Error("queue unavailable"));

    await expect(discoverAndEnqueueNotifications(env)).rejects.toThrow("queue unavailable");

    await expect(loadState()).resolves.toMatchObject({ last_checked_at: previousCheckpoint });
  });
});

describe("notification Queue consumer", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM cleanup_run_notifications"),
      env.DB.prepare("DELETE FROM cleanup_runs"),
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("marks an auto-merge Renovate notification done and acknowledges it", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      const pathname = new URL(url).pathname;
      if (pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      if (pathname === "/notifications/threads/1" && method === "GET") {
        return response(thread("1", 1));
      }
      if (pathname === "/repos/owner/repo/pulls/1") {
        return response({
          auto_merge: {},
          html_url: "https://github.com/owner/repo/pull/1",
          user: { id: 29_139_614 },
        });
      }
      if (pathname === "/notifications/threads/1" && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return response({ message: "unexpected test request" }, 500);
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = queueBatch([notification("1", 1)]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.explicitAcks).toEqual(["message-0"]);
    expect(queueResult.retryMessages).toEqual([]);
    const audit = await env.DB.prepare(
      "SELECT outcome, reason FROM cleanup_run_notifications WHERE notification_id = '1'",
    ).first<{ outcome: string; reason: string }>();
    expect(audit).toEqual({ outcome: "marked_done", reason: "renovate_auto_merge" });
  });

  test("records and retries a transient notification failure", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      if (new URL(url).pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      return response({ message: "failure" }, 500, {
        "retry-after": "90",
        "x-github-request-id": "request-123",
      });
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = queueBatch([notification("1", 1)]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.explicitAcks).toEqual([]);
    expect(queueResult.retryMessages).toEqual([{ msgId: "message-0" }]);
    const audit = await env.DB.prepare(
      `
        SELECT outcome, error_status, github_request_id
        FROM cleanup_run_notifications
        WHERE notification_id = '1'
      `,
    ).first<{ error_status: number; github_request_id: string; outcome: string }>();
    expect(audit).toEqual({
      error_status: 500,
      github_request_id: "request-123",
      outcome: "retry_pending",
    });
  });

  test("acknowledges a retained message while retrying another message in its batch", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const pathname = new URL(url).pathname;
      if (pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      if (pathname === "/notifications/threads/1") {
        return response({ message: "failure" }, 500);
      }
      if (pathname === "/notifications/threads/2") {
        return response(thread("2", 2));
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
      return response({ message: "unexpected test request" }, 500);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = queueBatch([notification("1", 1), notification("2", 2)]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.explicitAcks).toEqual(["message-1"]);
    expect(queueResult.retryMessages).toEqual([{ msgId: "message-0" }]);
  });

  test("retains a thread that is no longer a pull request", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const pathname = new URL(url).pathname;
      if (pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      if (pathname === "/notifications/threads/1") {
        return response({
          ...thread("1", 1),
          subject: {
            type: "Issue",
            url: "https://api.github.com/repos/owner/repo/issues/1",
          },
        });
      }
      return response({ message: "unexpected test request" }, 500);
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = queueBatch([notification("1", 1)]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.explicitAcks).toEqual(["message-0"]);
    expect(queueResult.retryMessages).toEqual([]);
    const audit = await env.DB.prepare(
      "SELECT outcome, reason FROM cleanup_run_notifications WHERE notification_id = '1'",
    ).first<{ outcome: string; reason: string }>();
    expect(audit).toEqual({ outcome: "retained", reason: "no_longer_pull_request" });
  });

  test("retains an evaluation that reaches its GitHub request budget", async () => {
    const timeline = [
      ...Array.from({ length: 14 }, (_, index) => ({
        committer: { date: `2026-08-04T00:${String(index + 1).padStart(2, "0")}:00Z` },
        event: "committed",
        sha: `commit-${index}`,
      })),
      {
        event: "reviewed",
        submitted_at: "2026-08-04T00:20:00Z",
        user: { id: 136_622_811 },
      },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const pathname = new URL(url).pathname;
      if (pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      if (pathname === "/notifications/threads/1") {
        return response(thread("1", 1));
      }
      if (pathname === "/repos/owner/repo/pulls/1") {
        return response({
          auto_merge: null,
          html_url: "https://github.com/owner/repo/pull/1",
          user: { id: 1 },
        });
      }
      if (pathname === "/repos/owner/repo/issues/1/timeline") {
        return response(timeline);
      }
      if (pathname.startsWith("/repos/owner/repo/commits/")) {
        return response({ author: { id: 79_110_363 }, committer: { id: 79_110_363 } });
      }
      return response({ message: "unexpected test request" }, 500);
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = queueBatch([notification("1", 1)]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.explicitAcks).toEqual(["message-0"]);
    expect(queueResult.retryMessages).toEqual([]);
    const audit = await env.DB.prepare(
      "SELECT outcome, reason FROM cleanup_run_notifications WHERE notification_id = '1'",
    ).first<{ outcome: string; reason: string }>();
    expect(audit).toEqual({
      outcome: "retained",
      reason: "evaluation_budget_exceeded",
    });
  });

  test("records and acknowledges exhausted messages from the dead-letter queue", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = queueBatch([notification("1", 1)], 1, "github-notification-cleanup-failures");
    const context = createExecutionContext();

    await worker.queue(batch, env);

    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.ackAll).toBe(true);
    const audit = await env.DB.prepare(
      "SELECT outcome, reason FROM cleanup_run_notifications WHERE notification_id = '1'",
    ).first<{ outcome: string; reason: string }>();
    expect(audit).toEqual({ outcome: "retained", reason: "retry_exhausted" });
    const [run] = await loadRuns();
    expect(JSON.parse(run?.summary ?? "null")).toMatchObject({
      retried: 0,
      retryExhausted: 1,
    });
  });
});
