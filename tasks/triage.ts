#!/usr/bin/env bun
//MISE description="Triage unread Renovate notifications."
//MISE env={GH_TOKEN={required="Set GH_TOKEN to a classic PAT with the notifications scope"}}
//USAGE flag "--force" env="FORCE_CHECK_ALL" help="Recheck every unread pull request notification"

import { mkdir } from "node:fs/promises";

import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";

const apiOrigin = "https://api.github.com";
const cachePath = ".cache/notification-state.json";
const renovateBotId = 29_139_614;

type NotificationState = {
  lastCheckedAt: string;
};

type PullRequestCoordinates = {
  owner: string;
  pullNumber: number;
  repo: string;
};

type Summary = {
  evaluated: number;
  markedDone: number;
  notifications: number;
  pullRequests: number;
  retained: number;
};

const parsePullRequestUrl = (subjectUrl: string): PullRequestCoordinates => {
  const url = new URL(subjectUrl);
  const match = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(url.pathname);

  if (url.origin !== apiOrigin || match === null) {
    throw new Error(`Refusing unexpected pull request URL: ${url}`);
  }

  const owner = match[1];
  const repo = match[2];
  const pullNumber = Number(match[3]);
  if (owner === undefined || repo === undefined || !Number.isSafeInteger(pullNumber)) {
    throw new Error(`GitHub returned an invalid pull request URL: ${url}`);
  }

  return { owner, pullNumber, repo };
};

const parseThreadId = (id: string): number => {
  const threadId = Number(id);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(threadId)) {
    throw new Error(`GitHub returned an invalid notification ID: ${id}`);
  }
  return threadId;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const loadState = async (): Promise<NotificationState | undefined> => {
  const file = Bun.file(cachePath);
  if (!(await file.exists())) {
    return undefined;
  }

  let value: unknown;
  try {
    value = await file.json();
  } catch {
    console.warn("Ignoring malformed notification state JSON");
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value["lastCheckedAt"] !== "string" ||
    !Number.isFinite(Date.parse(value["lastCheckedAt"]))
  ) {
    console.warn("Ignoring invalid notification state");
    return undefined;
  }
  return { lastCheckedAt: value["lastCheckedAt"] };
};

const saveState = async (state: NotificationState): Promise<void> => {
  await mkdir(".cache", { recursive: true });
  await Bun.write(cachePath, `${JSON.stringify(state, undefined, 2)}\n`);
};

const printSummary = (summary: Summary, force: boolean, since: string | undefined): void => {
  console.log("Summary:");
  console.log(`  force recheck: ${force}`);
  console.log(`  checked since: ${since ?? "all unread notifications"}`);
  console.log(`  notifications parsed: ${summary.notifications}`);
  console.log(`  pull request notifications: ${summary.pullRequests}`);
  console.log(`  pull requests evaluated: ${summary.evaluated}`);
  console.log(`  notifications marked done: ${summary.markedDone}`);
  console.log(`  notifications retained: ${summary.retained}`);
};

const rateLimitMessage = (error: RequestError): string | undefined => {
  const headers = error.response?.headers;
  const retryAfter = headers?.["retry-after"];
  const reset = headers?.["x-ratelimit-reset"];
  const rateLimited =
    error.status === 429 ||
    headers?.["x-ratelimit-remaining"] === "0" ||
    error.message.toLowerCase().includes("rate limit");

  if (!rateLimited) {
    return undefined;
  }
  if (retryAfter !== undefined) {
    return `GitHub rate limit exceeded; retry after ${retryAfter} seconds`;
  }
  if (reset !== undefined && Number.isFinite(Number(reset))) {
    return `GitHub rate limit exceeded; retry after ${new Date(Number(reset) * 1_000).toISOString()}`;
  }
  return "GitHub rate limit exceeded; retry after the limit resets";
};

const main = async (): Promise<void> => {
  const token = Bun.env["GH_TOKEN"];
  if (!token) {
    throw new Error("GH_TOKEN is required");
  }

  const force = Bun.env["usage_force"] === "true";
  const state = force ? undefined : await loadState();
  const since = state?.lastCheckedAt;
  const startedAt = new Date().toISOString();
  const summary: Summary = {
    evaluated: 0,
    markedDone: 0,
    notifications: 0,
    pullRequests: 0,
    retained: 0,
  };

  try {
    const octokit = new Octokit({
      auth: token,
      userAgent: "github-notification-cleanup",
    });
    const notifications = await octokit.paginate(
      octokit.rest.activity.listNotificationsForAuthenticatedUser,
      {
        all: false,
        per_page: 100,
        since,
      },
    );
    summary.notifications = notifications.length;

    for (const notification of notifications) {
      if (notification.subject.type !== "PullRequest" || notification.subject.url === null) {
        continue;
      }

      summary.pullRequests += 1;
      const { owner, pullNumber, repo } = parsePullRequestUrl(notification.subject.url);
      const { data: pullRequest } = await octokit.rest.pulls.get({
        owner,
        pull_number: pullNumber,
        repo,
      });
      summary.evaluated += 1;

      if (pullRequest.user?.id !== renovateBotId || pullRequest.auto_merge === null) {
        summary.retained += 1;
        continue;
      }

      await octokit.rest.activity.markThreadAsDone({
        thread_id: parseThreadId(notification.id),
      });
      summary.markedDone += 1;
      console.log(`Marked done: ${pullRequest.html_url}`);
    }

    await saveState({ lastCheckedAt: startedAt });
  } finally {
    printSummary(summary, force, since);
  }
};

try {
  await main();
} catch (error) {
  if (error instanceof RequestError) {
    const message = rateLimitMessage(error);
    if (message !== undefined) {
      console.error(message);
    } else {
      console.error(
        `GitHub API request failed: ${error.status} ${error.request.method} ${error.request.url}`,
      );
    }
    process.exitCode = 1;
  } else {
    throw error;
  }
}
