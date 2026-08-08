import { RequestError } from "@octokit/request-error";
import { retry } from "@octokit/plugin-retry";
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
const GitHub = Octokit.plugin(retry);

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
  retried: number;
  retryPending: number;
};

export type RetryNotification = {
  attemptCount: number;
  id: string;
  lastReadAt: string | null;
  subjectUrl: string;
  unread: boolean;
  updatedAt: string;
};

export type GitHubErrorDetails = {
  message: string;
  rateLimitRemaining: string | undefined;
  requestId: string | undefined;
  retryAfter: string | undefined;
  status: number | undefined;
};

export type NotificationAudit = {
  error?: GitHubErrorDetails;
  notification: RetryNotification;
  outcome: "marked_done" | "retained" | "retry_pending";
  pullNumber?: number;
  reason: string;
  repository?: string;
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
  fullScan?: boolean;
  retries?: RetryNotification[];
  since?: string | undefined;
  startedAt?: string;
  token: string;
};

export type TriageResult = {
  audits: NotificationAudit[];
  startedAt: string;
  summary: Summary;
};

export class TriageFailure extends Error {
  readonly originalError: unknown;
  readonly result: TriageResult;

  constructor(originalError: unknown, result: TriageResult) {
    super("Notification triage failed");
    this.name = "TriageFailure";
    this.originalError = originalError;
    this.result = result;
  }
}

export const createEmptySummary = (): Summary => {
  return {
    aiReviewMarkedDone: 0,
    evaluated: 0,
    markedDone: 0,
    notifications: 0,
    pullRequests: 0,
    renovateMarkedDone: 0,
    retained: 0,
    retried: 0,
    retryPending: 0,
  };
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
        console.warn({
          event: "commit_attribution_unavailable",
          sha,
        });
        return undefined;
      }
      throw error;
    }
  });
};

const printSummary = (summary: Summary, fullScan: boolean, since: string | undefined): void => {
  console.log({
    event: "triage_summary",
    fullScan,
    since: since ?? null,
    ...summary,
  });
};

export const formatTriageError = (error: unknown): string => {
  const originalError = error instanceof TriageFailure ? error.originalError : error;
  const details = getGitHubErrorDetails(originalError);
  if (!(originalError instanceof RequestError)) {
    return details.message;
  }

  const reset = originalError.response?.headers["x-ratelimit-reset"];
  const rateLimited = isRateLimited(originalError);

  if (!rateLimited) {
    const requestId = details.requestId === undefined ? "" : ` (request ${details.requestId})`;
    return `GitHub API request failed: ${originalError.status} ${originalError.request.method} ${originalError.request.url}${requestId}`;
  }
  if (details.retryAfter !== undefined) {
    return `GitHub rate limit exceeded; retry after ${details.retryAfter} seconds`;
  }
  if (reset !== undefined && Number.isFinite(Number(reset))) {
    return `GitHub rate limit exceeded; retry after ${new Date(Number(reset) * 1_000).toISOString()}`;
  }
  return "GitHub rate limit exceeded; retry after the limit resets";
};

const getGitHubErrorDetails = (error: unknown): GitHubErrorDetails => {
  if (!(error instanceof RequestError)) {
    return {
      message: error instanceof Error ? error.message : String(error),
      rateLimitRemaining: undefined,
      requestId: undefined,
      retryAfter: undefined,
      status: undefined,
    };
  }

  const retryAfter = error.response?.headers["retry-after"];
  return {
    message: error.message,
    rateLimitRemaining: error.response?.headers["x-ratelimit-remaining"],
    requestId: error.response?.headers["x-github-request-id"],
    retryAfter: retryAfter === undefined ? undefined : String(retryAfter),
    status: error.status,
  };
};

const isRateLimited = (error: RequestError): boolean => {
  return (
    error.status === 429 ||
    error.response?.headers["x-ratelimit-remaining"] === "0" ||
    error.message.toLowerCase().includes("rate limit")
  );
};

const isSystemicError = (error: unknown): boolean => {
  return error instanceof RequestError && (error.status === 401 || isRateLimited(error));
};

export const triageNotifications = async ({
  fullScan = false,
  retries = [],
  since,
  startedAt = new Date().toISOString(),
  token,
}: TriageOptions): Promise<TriageResult> => {
  const effectiveSince = fullScan ? undefined : since;
  const summary = createEmptySummary();
  const audits: NotificationAudit[] = [];

  try {
    const octokit = new GitHub({
      auth: token,
      retry: { retries: 2, retryAfterBaseValue: 100 },
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
    const retryById = new Map(retries.map((notification) => [notification.id, notification]));
    const candidates = new Map<string, { notification: RetryNotification; refresh: boolean }>();
    for (const notification of retries) {
      candidates.set(notification.id, { notification, refresh: true });
    }
    for (const notification of notifications) {
      if (notification.subject.type !== "PullRequest" || notification.subject.url === null) {
        continue;
      }
      candidates.set(notification.id, {
        notification: {
          attemptCount: retryById.get(notification.id)?.attemptCount ?? 0,
          id: notification.id,
          lastReadAt: notification.last_read_at,
          subjectUrl: notification.subject.url,
          unread: notification.unread,
          updatedAt: notification.updated_at,
        },
        refresh: false,
      });
    }

    summary.retried = [...candidates.values()].filter(({ refresh }) => refresh).length;
    for (const candidate of candidates.values()) {
      summary.pullRequests += 1;
      let notification = candidate.notification;
      let coordinates: PullRequestCoordinates | undefined;
      try {
        const threadId = parseThreadId(notification.id);
        if (candidate.refresh) {
          const { data: currentThread } = await octokit.rest.activity.getThread({
            thread_id: threadId,
          });
          if (currentThread.subject.type !== "PullRequest" || currentThread.subject.url === null) {
            audits.push({
              notification,
              outcome: "retained",
              reason: "no_longer_pull_request",
            });
            summary.retained += 1;
            continue;
          }
          notification = {
            ...notification,
            lastReadAt: currentThread.last_read_at,
            subjectUrl: currentThread.subject.url,
            unread: currentThread.unread,
            updatedAt: currentThread.updated_at,
          };
        }

        coordinates = parsePullRequestUrl(notification.subjectUrl);
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
            notification.lastReadAt,
            authenticatedUser.id,
          ));
        if (!isRenovateAutoMerge && !isIgnoredAiReview) {
          audits.push({
            notification,
            outcome: "retained",
            pullNumber,
            reason: "requires_attention",
            repository: `${owner}/${repo}`,
          });
          summary.retained += 1;
          continue;
        }

        const { data: currentThread } = await octokit.rest.activity.getThread({
          thread_id: threadId,
        });
        if (
          currentThread.updated_at !== notification.updatedAt ||
          currentThread.last_read_at !== notification.lastReadAt ||
          currentThread.unread !== notification.unread
        ) {
          audits.push({
            notification,
            outcome: "retained",
            pullNumber,
            reason: "concurrently_updated",
            repository: `${owner}/${repo}`,
          });
          summary.retained += 1;
          console.warn({
            event: "notification_concurrently_updated",
            pullRequestUrl: pullRequest.html_url,
          });
          continue;
        }

        await octokit.rest.activity.markThreadAsDone({
          thread_id: threadId,
        });
        const reason = isRenovateAutoMerge ? "renovate_auto_merge" : "ignored_ai_review";
        audits.push({
          notification,
          outcome: "marked_done",
          pullNumber,
          reason,
          repository: `${owner}/${repo}`,
        });
        summary.markedDone += 1;
        if (isRenovateAutoMerge) {
          summary.renovateMarkedDone += 1;
        } else {
          summary.aiReviewMarkedDone += 1;
        }
        console.log({
          event: "notification_marked_done",
          pullRequestUrl: pullRequest.html_url,
          reason,
        });
      } catch (error) {
        if (isSystemicError(error)) {
          throw error;
        }
        const details = getGitHubErrorDetails(error);
        audits.push({
          error: details,
          notification,
          outcome: "retry_pending",
          reason: "evaluation_failed",
          ...(coordinates === undefined
            ? {}
            : {
                pullNumber: coordinates.pullNumber,
                repository: `${coordinates.owner}/${coordinates.repo}`,
              }),
        });
        summary.retryPending += 1;
        console.error({
          event: "notification_evaluation_failed",
          notificationId: notification.id,
          subjectUrl: notification.subjectUrl,
          ...details,
        });
      }
    }
  } catch (error) {
    throw new TriageFailure(error, { audits, startedAt, summary });
  } finally {
    printSummary(summary, fullScan, effectiveSince);
  }

  return { audits, startedAt, summary };
};
