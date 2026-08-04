// GitHub notification classification and triage logic shared by the Worker and tests.

import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";

const apiOrigin = "https://api.github.com";
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

type PullRequestCoordinates = {
  owner: string;
  pullNumber: number;
  repo: string;
};

export type Summary = {
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

type CommitActorLoader = (sha: string) => Promise<number[] | undefined>;

type TriageOptions = {
  force?: boolean;
  since?: string | undefined;
  token: string;
};

export type TriageResult = {
  startedAt: string;
  summary: Summary;
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

const getLatestTimestamp = (value: unknown, keys: string[]): string | undefined => {
  let latest: string | undefined;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const key of keys) {
    const timestamp = getString(value, key);
    const time = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
    if (timestamp !== undefined && Number.isFinite(time) && time > latestTime) {
      latest = timestamp;
      latestTime = time;
    }
  }
  return latest;
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
      occurredAt: getLatestTimestamp(comment, ["created_at", "updated_at"]),
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
        (eventName === "commented"
          ? getLatestTimestamp(event, ["created_at", "updated_at"])
          : undefined) ??
        (eventName === "reviewed"
          ? getLatestTimestamp(event, ["submitted_at", "updated_at"])
          : undefined) ??
        getString(event, "created_at") ??
        getString(event["committer"], "date"),
      sha: eventName === "committed" ? getString(event, "sha") : undefined,
    },
  ];
};

const isAtOrAfter = (value: string | undefined, boundary: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp >= Date.parse(boundary) : undefined;
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
      const afterLastRead = isAtOrAfter(activity.occurredAt, activityBoundary);
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
        const commitActorIds = await loadCommitActorIds(activity.sha);
        if (commitActorIds === undefined || !commitActorIds.includes(currentUserId)) {
          return false;
        }
        actorIds = commitActorIds;
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
    try {
      const { data: commit } = await octokit.rest.repos.getCommit({
        owner,
        ref: sha,
        repo,
      });
      return [commit.author?.id, commit.committer?.id].filter(
        (id): id is number => id !== undefined,
      );
    } catch (error) {
      if (error instanceof RequestError && (error.status === 404 || error.status === 422)) {
        console.warn(
          JSON.stringify({
            event: "commit_attribution_unavailable",
            sha,
          }),
        );
        return undefined;
      }
      throw error;
    }
  });
};

const printSummary = (summary: Summary, force: boolean, since: string | undefined): void => {
  console.log(
    JSON.stringify({
      event: "triage_summary",
      force,
      since: since ?? null,
      ...summary,
    }),
  );
};

export const formatTriageError = (error: unknown): string => {
  if (!(error instanceof RequestError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const headers = error.response?.headers;
  const retryAfter = headers?.["retry-after"];
  const reset = headers?.["x-ratelimit-reset"];
  const rateLimited =
    error.status === 429 ||
    headers?.["x-ratelimit-remaining"] === "0" ||
    error.message.toLowerCase().includes("rate limit");

  if (!rateLimited) {
    return `GitHub API request failed: ${error.status} ${error.request.method} ${error.request.url}`;
  }
  if (retryAfter !== undefined) {
    return `GitHub rate limit exceeded; retry after ${retryAfter} seconds`;
  }
  if (reset !== undefined && Number.isFinite(Number(reset))) {
    return `GitHub rate limit exceeded; retry after ${new Date(Number(reset) * 1_000).toISOString()}`;
  }
  return "GitHub rate limit exceeded; retry after the limit resets";
};

export const triageNotifications = async ({
  force = false,
  since,
  token,
}: TriageOptions): Promise<TriageResult> => {
  const effectiveSince = force ? undefined : since;
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
      auth: token,
      userAgent: "github-notification-cleanup",
    });
    const { data: authenticatedUser } = await octokit.rest.users.getAuthenticated();
    const notifications = await octokit.paginate(
      octokit.rest.activity.listNotificationsForAuthenticatedUser,
      {
        all: true,
        per_page: 100,
        since: effectiveSince,
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
        console.warn(
          JSON.stringify({
            event: "notification_concurrently_updated",
            pullRequestUrl: pullRequest.html_url,
          }),
        );
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
      console.log(
        JSON.stringify({
          event: "notification_marked_done",
          pullRequestUrl: pullRequest.html_url,
          reason: isRenovateAutoMerge ? "renovate_auto_merge" : "ignored_ai_review",
        }),
      );
    }
  } finally {
    printSummary(summary, force, effectiveSince);
  }

  return { startedAt, summary };
};
