#!/usr/bin/env bun
//MISE description="Triage pull request notifications."
//MISE env={GH_TOKEN={required="Set GH_TOKEN to a classic PAT with the notifications scope"}}
//USAGE flag "--force" env="FORCE_CHECK_ALL" help="Recheck every read and unread pull request notification"

import { mkdir } from "node:fs/promises";

import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";

const apiOrigin = "https://api.github.com";
const cachePath = ".cache/notification-state.json";
const codeRabbitBotId = 136_622_811;
const greptileBotId = 165_735_046;
const sourceryBotId = 58_596_630;
const ignoredAiReviewerIds = new Set([codeRabbitBotId, greptileBotId, sourceryBotId]);
const ignoredReviewEvents = new Set([
  "commented",
  "commit-commented",
  "line-commented",
  "reviewed",
]);
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
  aiReviewMarkedDone: number;
  evaluated: number;
  markedDone: number;
  notifications: number;
  pullRequests: number;
  renovateMarkedDone: number;
  retained: number;
};

type TimelineActivity = {
  actorIds: number[];
  event: string;
  isReviewActivity: boolean;
  occurredAt: string | undefined;
  sha: string | undefined;
};

type CommitActorLoader = (sha: string) => Promise<number[]>;

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
  return typeof value === "object" && value !== null;
};

const getString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === "string" ? field : undefined;
};

const getUserId = (value: unknown): number | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = value["id"];
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
};

const getTimelineActivities = (event: unknown): TimelineActivity[] => {
  if (!isRecord(event)) {
    return [
      {
        actorIds: [],
        event: "unknown",
        isReviewActivity: false,
        occurredAt: undefined,
        sha: undefined,
      },
    ];
  }

  const eventName = getString(event, "event") ?? "unknown";
  const comments = event["comments"];
  if (eventName === "line-commented" || eventName === "commit-commented") {
    if (!Array.isArray(comments) || comments.length === 0) {
      return [
        {
          actorIds: [],
          event: eventName,
          isReviewActivity: true,
          occurredAt: undefined,
          sha: undefined,
        },
      ];
    }
    return comments.map((comment) => ({
      actorIds: [getUserId(isRecord(comment) ? comment["user"] : undefined)].filter(
        (id): id is number => id !== undefined,
      ),
      event: eventName,
      isReviewActivity: true,
      occurredAt: getString(comment, "created_at"),
      sha: undefined,
    }));
  }

  const isReviewActivity = eventName === "commented" || eventName === "reviewed";
  const actorId = getUserId(eventName === "reviewed" ? event["user"] : event["actor"]);
  return [
    {
      actorIds: actorId === undefined ? [] : [actorId],
      event: eventName,
      isReviewActivity,
      occurredAt:
        getString(event, "created_at") ??
        getString(event, "submitted_at") ??
        getString(event["committer"], "date"),
      sha: eventName === "committed" ? getString(event, "sha") : undefined,
    },
  ];
};

const isAfter = (value: string | undefined, boundary: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp > Date.parse(boundary) : undefined;
};

export const hasOnlyIgnoredActivities = async (
  events: unknown[],
  lastReadAt: string | null,
  currentUserId: number,
  loadCommitActorIds: CommitActorLoader,
): Promise<boolean> => {
  const activityBoundary = lastReadAt ?? "1970-01-01T00:00:00Z";
  const ignoredActorIds = new Set([currentUserId, ...ignoredAiReviewerIds]);
  let foundIgnoredAiReview = false;
  for (const event of events) {
    for (const activity of getTimelineActivities(event)) {
      const afterLastRead = isAfter(activity.occurredAt, activityBoundary);
      if (afterLastRead === false) {
        continue;
      }
      if (afterLastRead === undefined) {
        return false;
      }

      let actorIds = activity.actorIds;
      if (activity.event === "committed") {
        if (activity.sha === undefined) {
          return false;
        }
        actorIds = await loadCommitActorIds(activity.sha);
        if (!actorIds.includes(currentUserId)) {
          return false;
        }
      } else {
        const [actorId] = actorIds;
        if (
          actorIds.length !== 1 ||
          actorId === undefined ||
          (activity.event === "cross-referenced"
            ? actorId !== currentUserId
            : !ignoredReviewEvents.has(activity.event) || !ignoredActorIds.has(actorId))
        ) {
          return false;
        }
      }

      if (
        activity.isReviewActivity &&
        actorIds.some((actorId) => ignoredAiReviewerIds.has(actorId))
      ) {
        foundIgnoredAiReview = true;
      }
    }
  }

  return foundIgnoredAiReview;
};

const hasOnlyIgnoredReviewActivity = async (
  octokit: Octokit,
  coordinates: PullRequestCoordinates,
  lastReadAt: string | null,
  currentUserId: number,
): Promise<boolean> => {
  const { owner, pullNumber, repo } = coordinates;
  const events = await octokit.paginate(octokit.rest.issues.listEventsForTimeline, {
    issue_number: pullNumber,
    owner,
    per_page: 100,
    repo,
  });
  return await hasOnlyIgnoredActivities(events, lastReadAt, currentUserId, async (sha) => {
    const { data: commit } = await octokit.rest.repos.getCommit({
      owner,
      ref: sha,
      repo,
    });
    return [commit.author?.id, commit.committer?.id].filter((id): id is number => id !== undefined);
  });
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
  console.log(`  checked since: ${since ?? "all read and unread notifications"}`);
  console.log(`  notifications parsed: ${summary.notifications}`);
  console.log(`  pull request notifications: ${summary.pullRequests}`);
  console.log(`  pull requests evaluated: ${summary.evaluated}`);
  console.log(`  notifications marked done: ${summary.markedDone}`);
  console.log(`    Renovate auto-merge: ${summary.renovateMarkedDone}`);
  console.log(`    ignored AI review activity: ${summary.aiReviewMarkedDone}`);
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
  const force = Bun.env["usage_force"] === "true";
  const state = force ? undefined : await loadState();
  const since = state?.lastCheckedAt;
  const startedAt = new Date().toISOString();
  const summary: Summary = {
    aiReviewMarkedDone: 0,
    evaluated: 0,
    markedDone: 0,
    notifications: 0,
    pullRequests: 0,
    renovateMarkedDone: 0,
    retained: 0,
  };

  try {
    const octokit = new Octokit({
      auth: Bun.env["GH_TOKEN"],
      userAgent: "github-notification-cleanup",
    });
    const { data: authenticatedUser } = await octokit.rest.users.getAuthenticated();
    const notifications = await octokit.paginate(
      octokit.rest.activity.listNotificationsForAuthenticatedUser,
      {
        all: true,
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
      const coordinates = parsePullRequestUrl(notification.subject.url);
      const { owner, pullNumber, repo } = coordinates;
      const { data: pullRequest } = await octokit.rest.pulls.get({
        owner,
        pull_number: pullNumber,
        repo,
      });
      summary.evaluated += 1;

      const isRenovateAutoMerge =
        pullRequest.user?.id === renovateBotId && pullRequest.auto_merge !== null;
      const isIgnoredAiReview =
        !isRenovateAutoMerge &&
        (await hasOnlyIgnoredReviewActivity(
          octokit,
          coordinates,
          notification.last_read_at,
          authenticatedUser.id,
        ));
      if (!isRenovateAutoMerge && !isIgnoredAiReview) {
        summary.retained += 1;
        continue;
      }

      const threadId = parseThreadId(notification.id);
      const { data: currentThread } = await octokit.rest.activity.getThread({
        thread_id: threadId,
      });
      if (
        currentThread.updated_at !== notification.updated_at ||
        currentThread.last_read_at !== notification.last_read_at ||
        currentThread.unread !== notification.unread
      ) {
        summary.retained += 1;
        console.warn(`Retained concurrently updated notification: ${pullRequest.html_url}`);
        continue;
      }

      await octokit.rest.activity.markThreadAsDone({
        thread_id: threadId,
      });
      summary.markedDone += 1;
      if (isRenovateAutoMerge) {
        summary.renovateMarkedDone += 1;
      } else {
        summary.aiReviewMarkedDone += 1;
      }
      console.log(`Marked done: ${pullRequest.html_url}`);
    }

    await saveState({ lastCheckedAt: startedAt });
  } finally {
    printSummary(summary, force, since);
  }
};

if (import.meta.main) {
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
}
