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

const pullRequest = (
  pullNumber: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  auto_merge: null,
  head: { ref: `pull-${pullNumber}` },
  html_url: `https://github.com/owner/repo/pull/${pullNumber}`,
  title: `Pull request ${pullNumber}`,
  user: { id: 1 },
  ...overrides,
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
      botReviewMarkedDone: 0,
      cloudflareDeploymentMarkedDone: 0,
      evaluated: 0,
      markedDone: 0,
      mergeMarkedDone: 0,
      notifications: 2,
      openPullRequestMarkedDone: 0,
      prCloserWarningMarkedDone: 0,
      pullRequests: 1,
      releaseMarkedDone: 0,
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
        return response(
          pullRequest(1, {
            auto_merge: {},
            user: { id: 29_139_614 },
          }),
        );
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

  test("marks a jdx release pull request notification done and acknowledges it", async () => {
    const releaseNotification: Notification = {
      ...notification("1", 787),
      subjectUrl: "https://api.github.com/repos/jdx/usage/pulls/787",
    };
    const releaseThread = {
      ...thread("1", 787),
      subject: {
        type: "PullRequest",
        url: releaseNotification.subjectUrl,
      },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      const pathname = new URL(url).pathname;
      if (pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      if (pathname === "/notifications/threads/1" && method === "GET") {
        return response(releaseThread);
      }
      if (pathname === "/repos/jdx/usage/pulls/787") {
        return response(
          pullRequest(787, {
            head: { ref: "release" },
            html_url: "https://github.com/jdx/usage/pull/787",
            title: "chore: release v5.1.0",
            user: { id: 216_188 },
          }),
        );
      }
      if (pathname === "/notifications/threads/1" && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return response({ message: "unexpected test request" }, 500);
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = queueBatch([releaseNotification]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.explicitAcks).toEqual(["message-0"]);
    expect(queueResult.retryMessages).toEqual([]);
    const audit = await env.DB.prepare(
      "SELECT outcome, reason FROM cleanup_run_notifications WHERE notification_id = '1'",
    ).first<{ outcome: string; reason: string }>();
    expect(audit).toEqual({ outcome: "marked_done", reason: "release_pull_request" });
    const [run] = await loadRuns();
    expect(JSON.parse(run?.summary ?? "null")).toMatchObject({ releaseMarkedDone: 1 });
  });

  test("marks a jdx PR closer warning done and acknowledges it", async () => {
    const warningNotification: Notification = {
      ...notification("1", 11_686),
      subjectUrl: "https://api.github.com/repos/jdx/mise/pulls/11686",
    };
    const warningThread = {
      ...thread("1", 11_686),
      subject: {
        type: "PullRequest",
        url: warningNotification.subjectUrl,
      },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      const pathname = new URL(url).pathname;
      if (pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      if (pathname === "/notifications/threads/1" && method === "GET") {
        return response(warningThread);
      }
      if (pathname === "/repos/jdx/mise/pulls/11686") {
        return response(
          pullRequest(11_686, {
            html_url: "https://github.com/jdx/mise/pull/11686",
            user: { id: 79_110_363 },
          }),
        );
      }
      if (pathname === "/repos/jdx/mise/issues/11686/timeline") {
        return response([
          {
            actor: { id: 41_898_282 },
            body: "Warning\n\n<!-- pr-closer-warning\ndate: 2026-08-04\nhead_sha: abc123\n-->",
            created_at: "2026-08-04T00:01:00Z",
            event: "commented",
          },
        ]);
      }
      if (pathname === "/notifications/threads/1" && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return response({ message: "unexpected test request" }, 500);
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = queueBatch([warningNotification]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.explicitAcks).toEqual(["message-0"]);
    expect(queueResult.retryMessages).toEqual([]);
    const audit = await env.DB.prepare(
      "SELECT outcome, reason FROM cleanup_run_notifications WHERE notification_id = '1'",
    ).first<{ outcome: string; reason: string }>();
    expect(audit).toEqual({ outcome: "marked_done", reason: "pr_closer_warning" });
    const [run] = await loadRuns();
    expect(JSON.parse(run?.summary ?? "null")).toMatchObject({
      prCloserWarningMarkedDone: 1,
    });
  });

  test("marks a Cloudflare deployment comment done and acknowledges it", async () => {
    const deploymentNotification: Notification = {
      ...notification("1", 560),
      subjectUrl: "https://api.github.com/repos/unsw-ajc-society/ajcsoc-website/pulls/560",
    };
    const deploymentThread = {
      ...thread("1", 560),
      subject: {
        type: "PullRequest",
        url: deploymentNotification.subjectUrl,
      },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      const pathname = new URL(url).pathname;
      if (pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      if (pathname === "/notifications/threads/1" && method === "GET") {
        return response(deploymentThread);
      }
      if (pathname === "/repos/unsw-ajc-society/ajcsoc-website/pulls/560") {
        return response(
          pullRequest(560, {
            html_url: "https://github.com/unsw-ajc-society/ajcsoc-website/pull/560",
            user: { id: 29_139_614 },
          }),
        );
      }
      if (pathname === "/repos/unsw-ajc-society/ajcsoc-website/issues/560/timeline") {
        return response([
          {
            actor: { id: 73_139_402 },
            body: "## Deploying with Cloudflare Workers",
            created_at: "2026-08-04T00:01:00Z",
            event: "commented",
          },
        ]);
      }
      if (pathname === "/notifications/threads/1" && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return response({ message: "unexpected test request" }, 500);
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = queueBatch([deploymentNotification]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.explicitAcks).toEqual(["message-0"]);
    expect(queueResult.retryMessages).toEqual([]);
    const audit = await env.DB.prepare(
      "SELECT outcome, reason FROM cleanup_run_notifications WHERE notification_id = '1'",
    ).first<{ outcome: string; reason: string }>();
    expect(audit).toEqual({ outcome: "marked_done", reason: "cloudflare_deployment_comment" });
    const [run] = await loadRuns();
    expect(JSON.parse(run?.summary ?? "null")).toMatchObject({
      cloudflareDeploymentMarkedDone: 1,
    });
  });

  test("marks a jdx merge with its paired close done and acknowledges it", async () => {
    const mergeNotification: Notification = {
      ...notification("1", 11_550),
      subjectUrl: "https://api.github.com/repos/jdx/mise/pulls/11550",
    };
    const mergeThread = {
      ...thread("1", 11_550),
      subject: {
        type: "PullRequest",
        url: mergeNotification.subjectUrl,
      },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      const pathname = new URL(url).pathname;
      if (pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      if (pathname === "/notifications/threads/1" && method === "GET") {
        return response(mergeThread);
      }
      if (pathname === "/repos/jdx/mise/pulls/11550") {
        return response(
          pullRequest(11_550, {
            html_url: "https://github.com/jdx/mise/pull/11550",
            state: "closed",
            user: { id: 79_110_363 },
          }),
        );
      }
      if (pathname === "/repos/jdx/mise/issues/11550/timeline") {
        return response([
          {
            actor: { id: 216_188 },
            created_at: "2026-08-04T00:01:00Z",
            event: "merged",
          },
          {
            actor: { id: 216_188 },
            created_at: "2026-08-04T00:01:00Z",
            event: "closed",
          },
        ]);
      }
      if (pathname === "/notifications/threads/1" && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return response({ message: "unexpected test request" }, 500);
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = queueBatch([mergeNotification]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.explicitAcks).toEqual(["message-0"]);
    expect(queueResult.retryMessages).toEqual([]);
    const audit = await env.DB.prepare(
      "SELECT outcome, reason FROM cleanup_run_notifications WHERE notification_id = '1'",
    ).first<{ outcome: string; reason: string }>();
    expect(audit).toEqual({ outcome: "marked_done", reason: "merged_by_ignored_merger" });
    const [run] = await loadRuns();
    expect(JSON.parse(run?.summary ?? "null")).toMatchObject({ mergeMarkedDone: 1 });
  });

  test("retains the same merge pair outside jdx", async () => {
    const mergeNotification: Notification = {
      ...notification("1", 11_550),
      subjectUrl: "https://api.github.com/repos/owner/mise/pulls/11550",
    };
    const mergeThread = {
      ...thread("1", 11_550),
      subject: {
        type: "PullRequest",
        url: mergeNotification.subjectUrl,
      },
    };
    let markedDone = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      const pathname = new URL(url).pathname;
      if (pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      if (pathname === "/notifications/threads/1" && method === "GET") {
        return response(mergeThread);
      }
      if (pathname === "/repos/owner/mise/pulls/11550") {
        return response(
          pullRequest(11_550, {
            html_url: "https://github.com/owner/mise/pull/11550",
            state: "closed",
            user: { id: 79_110_363 },
          }),
        );
      }
      if (pathname === "/repos/owner/mise/issues/11550/timeline") {
        return response([
          {
            actor: { id: 216_188 },
            created_at: "2026-08-04T00:01:00Z",
            event: "merged",
          },
          {
            actor: { id: 216_188 },
            created_at: "2026-08-04T00:01:00Z",
            event: "closed",
          },
        ]);
      }
      if (pathname === "/notifications/threads/1" && method === "DELETE") {
        markedDone = true;
        return new Response(null, { status: 204 });
      }
      return response({ message: "unexpected test request" }, 500);
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = queueBatch([mergeNotification]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.explicitAcks).toEqual(["message-0"]);
    expect(queueResult.retryMessages).toEqual([]);
    expect(markedDone).toBe(false);
    const audit = await env.DB.prepare(
      "SELECT outcome, reason FROM cleanup_run_notifications WHERE notification_id = '1'",
    ).first<{ outcome: string; reason: string }>();
    expect(audit).toEqual({ outcome: "retained", reason: "requires_attention" });
    const [run] = await loadRuns();
    expect(JSON.parse(run?.summary ?? "null")).toMatchObject({
      markedDone: 0,
      mergeMarkedDone: 0,
    });
  });

  test("retains an unmarked jdx GitHub Actions comment", async () => {
    const warningNotification: Notification = {
      ...notification("1", 11_686),
      subjectUrl: "https://api.github.com/repos/jdx/mise/pulls/11686",
    };
    const warningThread = {
      ...thread("1", 11_686),
      subject: {
        type: "PullRequest",
        url: warningNotification.subjectUrl,
      },
    };
    let markedDone = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      const pathname = new URL(url).pathname;
      if (pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      if (pathname === "/notifications/threads/1" && method === "GET") {
        return response(warningThread);
      }
      if (pathname === "/repos/jdx/mise/pulls/11686") {
        return response(
          pullRequest(11_686, {
            html_url: "https://github.com/jdx/mise/pull/11686",
            user: { id: 79_110_363 },
          }),
        );
      }
      if (pathname === "/repos/jdx/mise/issues/11686/timeline") {
        return response([
          {
            actor: { id: 41_898_282 },
            body: "This PR will be closed automatically.",
            created_at: "2026-08-04T00:01:00Z",
            event: "commented",
          },
        ]);
      }
      if (pathname === "/notifications/threads/1" && method === "DELETE") {
        markedDone = true;
        return new Response(null, { status: 204 });
      }
      return response({ message: "unexpected test request" }, 500);
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = queueBatch([warningNotification]);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.explicitAcks).toEqual(["message-0"]);
    expect(queueResult.retryMessages).toEqual([]);
    expect(markedDone).toBe(false);
    const audit = await env.DB.prepare(
      "SELECT outcome, reason FROM cleanup_run_notifications WHERE notification_id = '1'",
    ).first<{ outcome: string; reason: string }>();
    expect(audit).toEqual({ outcome: "retained", reason: "requires_attention" });
    const [run] = await loadRuns();
    expect(JSON.parse(run?.summary ?? "null")).toMatchObject({
      prCloserWarningMarkedDone: 0,
    });
  });

  test("marks ready and draft jdx PRs by other authors done", async () => {
    const notifications = [
      {
        ...notification("1", 1),
        subjectUrl: "https://api.github.com/repos/jdx/mise/pulls/1",
      },
      {
        ...notification("2", 2),
        subjectUrl: "https://api.github.com/repos/jdx/mise/pulls/2",
      },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      const pathname = new URL(url).pathname;
      if (pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      const threadMatch = /^\/notifications\/threads\/(\d+)$/.exec(pathname);
      if (threadMatch !== null && method === "GET") {
        const id = threadMatch[1] ?? "0";
        const pullNumber = Number(id);
        return response({
          ...thread(id, pullNumber),
          subject: {
            type: "PullRequest",
            url: notifications[pullNumber - 1]?.subjectUrl,
          },
        });
      }
      const pullMatch = /^\/repos\/jdx\/mise\/pulls\/(\d+)$/.exec(pathname);
      if (pullMatch !== null) {
        const pullNumber = Number(pullMatch[1]);
        return response(
          pullRequest(pullNumber, {
            draft: pullNumber === 2,
            html_url: `https://github.com/jdx/mise/pull/${pullNumber}`,
            state: "open",
            user: { id: 1 },
          }),
        );
      }
      if (threadMatch !== null && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return response({ message: "unexpected test request" }, 500);
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = queueBatch(notifications);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.explicitAcks).toEqual(["message-0", "message-1"]);
    expect(queueResult.retryMessages).toEqual([]);
    const { results: audits } = await env.DB.prepare(
      "SELECT outcome, reason FROM cleanup_run_notifications ORDER BY notification_id",
    ).all<{ outcome: string; reason: string }>();
    expect(audits).toEqual([
      { outcome: "marked_done", reason: "open_pull_request_by_other_author" },
      { outcome: "marked_done", reason: "open_pull_request_by_other_author" },
    ]);
    const [run] = await loadRuns();
    expect(JSON.parse(run?.summary ?? "null")).toMatchObject({
      openPullRequestMarkedDone: 2,
    });
  });

  test("retains pull requests outside the open other-author policy", async () => {
    const candidates = [
      { author: { id: 79_110_363 }, id: "1", owner: "jdx", state: "open" },
      { author: { id: 1 }, id: "2", owner: "jdx", state: "closed" },
      { author: null, id: "3", owner: "jdx", state: "open" },
      { author: { id: 1 }, id: "4", owner: "someone-else", state: "open" },
    ] as const;
    const notifications = candidates.map((candidate) => ({
      ...notification(candidate.id, Number(candidate.id)),
      subjectUrl: `https://api.github.com/repos/${candidate.owner}/mise/pulls/${candidate.id}`,
    }));
    const markedDoneIds: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      const pathname = new URL(url).pathname;
      if (pathname === "/user") {
        return response({ id: 79_110_363, login: "risu729" });
      }
      const threadMatch = /^\/notifications\/threads\/(\d+)$/.exec(pathname);
      if (threadMatch !== null && method === "GET") {
        const id = threadMatch[1] ?? "0";
        const pullNumber = Number(id);
        return response({
          ...thread(id, pullNumber),
          subject: {
            type: "PullRequest",
            url: notifications[pullNumber - 1]?.subjectUrl,
          },
        });
      }
      const pullMatch = /^\/repos\/[^/]+\/mise\/pulls\/(\d+)$/.exec(pathname);
      if (pullMatch !== null) {
        const pullNumber = Number(pullMatch[1]);
        const candidate = candidates[pullNumber - 1];
        if (candidate !== undefined) {
          return response(
            pullRequest(pullNumber, {
              html_url: `https://github.com/${candidate.owner}/mise/pull/${pullNumber}`,
              state: candidate.state,
              user: candidate.author,
            }),
          );
        }
      }
      if (/^\/repos\/[^/]+\/mise\/issues\/\d+\/timeline$/.test(pathname)) {
        return response([]);
      }
      if (threadMatch !== null && method === "DELETE") {
        markedDoneIds.push(threadMatch[1] ?? "0");
        return new Response(null, { status: 204 });
      }
      return response({ message: "unexpected test request" }, 500);
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const batch = queueBatch(notifications);
    const context = createExecutionContext();

    await worker.queue(batch, env);

    const queueResult = await getQueueResult(batch, context);
    expect(queueResult.explicitAcks).toEqual(["message-0", "message-1", "message-2", "message-3"]);
    expect(queueResult.retryMessages).toEqual([]);
    expect(markedDoneIds).toEqual([]);
    const { results: audits } = await env.DB.prepare(
      "SELECT outcome, reason FROM cleanup_run_notifications ORDER BY notification_id",
    ).all<{ outcome: string; reason: string }>();
    expect(audits).toEqual([
      { outcome: "retained", reason: "requires_attention" },
      { outcome: "retained", reason: "requires_attention" },
      { outcome: "retained", reason: "requires_attention" },
      { outcome: "retained", reason: "requires_attention" },
    ]);
    const [run] = await loadRuns();
    expect(JSON.parse(run?.summary ?? "null")).toMatchObject({
      markedDone: 0,
      openPullRequestMarkedDone: 0,
      retained: 4,
    });
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
        return response(pullRequest(2));
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
        return response(pullRequest(1));
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
