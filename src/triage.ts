import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";

const apiOrigin = "https://api.github.com";
const brewTestBotId = 1_589_480;
const cloudflareWorkersAndPagesBotId = 73_139_402;
const codeRabbitBotId = 136_622_811;
const githubActionsBotId = 41_898_282;
const greptileBotId = 165_735_046;
const jdxUserId = 216_188;
const miseEnDevBotId = 123_107_610;
const prCloserWarningMarker = "<!-- pr-closer-warning\n";
const sourceryBotId = 58_596_630;
const ignoredBotIds = new Set([
  brewTestBotId,
  codeRabbitBotId,
  greptileBotId,
  miseEnDevBotId,
  sourceryBotId,
]);
const ignoredMergerIdsByOwner = new Map([["jdx", new Set([jdxUserId])]]);
const ignoredOpenPullRequestOwners = new Set(["jdx"]);
const notificationActivityLookbackMilliseconds = 5 * 60 * 1_000;
const maxGitHubRequestsPerNotification = 15;
const renovateBotId = 29_139_614;

type PullRequestCoordinates = {
  owner: string;
  pullNumber: number;
  repo: string;
};

type ReleasePullRequest = {
  headRef: string;
  owner: string;
};

type PullRequest = Awaited<ReturnType<Octokit["rest"]["pulls"]["get"]>>["data"];

type OpenPullRequest = {
  authorId: number | undefined;
  currentUserId: number;
  owner: string;
  state: PullRequest["state"];
};

type SuppressionReason =
  | "cloudflare_deployment_comment"
  | "ignored_bot_review"
  | "merged_by_ignored_merger"
  | "open_pull_request_by_other_author"
  | "pr_closer_warning"
  | "release_pull_request"
  | "renovate_auto_merge"
  | "renovate_merged";

const renovateSuppressionReasons = new Set<string>(["renovate_auto_merge", "renovate_merged"]);

type IgnoredActivityKind =
  | "cloudflare_deployment_comment"
  | "current_user"
  | "ignored_bot_review"
  | "ignored_bot_reference"
  | "ignored_merge"
  | "pr_closer_warning";

type SuppressionRuleContext = {
  coordinates: PullRequestCoordinates;
  currentUserId: number;
  notificationUpdatedAt: string;
  octokit: Octokit;
  pullRequest: PullRequest;
};

type SuppressionRule = {
  evaluate: (
    context: SuppressionRuleContext,
  ) => SuppressionReason | undefined | Promise<SuppressionReason | undefined>;
};

export type Summary = {
  botReviewMarkedDone: number;
  cloudflareDeploymentMarkedDone: number;
  evaluated: number;
  markedDone: number;
  mergeMarkedDone: number;
  notifications: number;
  openPullRequestMarkedDone: number;
  prCloserWarningMarkedDone: number;
  pullRequests: number;
  releaseMarkedDone: number;
  renovateMarkedDone: number;
  retained: number;
  retried: number;
  retryExhausted: number;
  retryPending: number;
};

export type Notification = {
  attemptCount: number;
  id: string;
  lastReadAt: string | null;
  subjectUrl: string;
  unread: boolean;
  updatedAt: string;
};

export type NotificationDiscovery = {
  notifications: Notification[];
  startedAt: string;
  summary: Summary;
};

export type GitHubErrorDetails = {
  message: string;
  method: string | undefined;
  rateLimitRemaining: string | undefined;
  requestId: string | undefined;
  retryAfter: string | undefined;
  status: number | undefined;
  url: string | undefined;
};

export type NotificationAudit = {
  error?: GitHubErrorDetails;
  notification: Notification;
  outcome: "marked_done" | "retained" | "retry_pending";
  pullNumber?: number;
  reason: string;
  repository?: string;
};

type TimelineActivity = {
  actorIds: number[];
  body: string | undefined;
  event: string;
  isReviewActivity: boolean;
  occurredAt: string | undefined;
  sha: string | undefined;
};

type CommitActorLoader = (sha: string) => Promise<number[] | undefined>;

type DiscoverOptions = {
  fullScan: boolean;
  retries: Notification[];
  since: string | undefined;
  startedAt: string;
  token: string;
};

type TriageOptions = {
  notifications: Notification[];
  startedAt: string;
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

class RequestBudgetExceeded extends Error {
  constructor() {
    super(`Notification evaluation exceeded ${maxGitHubRequestsPerNotification} GitHub requests`);
    this.name = "RequestBudgetExceeded";
  }
}

const createGitHub = (token: string, requestBudget?: number): Octokit => {
  const github = new Octokit({
    auth: token,
    userAgent: "github-notification-cleanup",
  });
  if (requestBudget !== undefined) {
    let requests = 0;
    github.hook.before("request", () => {
      requests += 1;
      if (requests > requestBudget) {
        throw new RequestBudgetExceeded();
      }
    });
  }
  return github;
};

export const createEmptySummary = (): Summary => {
  return {
    botReviewMarkedDone: 0,
    cloudflareDeploymentMarkedDone: 0,
    evaluated: 0,
    markedDone: 0,
    mergeMarkedDone: 0,
    notifications: 0,
    openPullRequestMarkedDone: 0,
    prCloserWarningMarkedDone: 0,
    pullRequests: 0,
    releaseMarkedDone: 0,
    renovateMarkedDone: 0,
    retained: 0,
    retried: 0,
    retryExhausted: 0,
    retryPending: 0,
  };
};

export const isReleasePullRequest = ({ headRef, owner }: ReleasePullRequest): boolean => {
  const isSuppressedOwner = owner === "jdx" || owner === "risu729";
  return isSuppressedOwner && headRef.startsWith("release");
};

const getRenovateSuppressionReason = (pullRequest: PullRequest): SuppressionReason | undefined => {
  if (pullRequest.user?.id !== renovateBotId) {
    return undefined;
  }
  if (pullRequest.auto_merge !== null) {
    return "renovate_auto_merge";
  }
  if (pullRequest.merged_by?.id === renovateBotId) {
    return "renovate_merged";
  }
  return undefined;
};

export const isOpenPullRequestByOtherAuthor = ({
  authorId,
  currentUserId,
  owner,
  state,
}: OpenPullRequest): boolean => {
  return (
    ignoredOpenPullRequestOwners.has(owner) &&
    state === "open" &&
    authorId !== undefined &&
    authorId !== currentUserId
  );
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
        body: undefined,
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
          body: undefined,
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
      body: getString(comment, "body"),
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
      body: getString(event, "body"),
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

const isWithinNotificationActivityWindow = (
  value: string | undefined,
  notificationUpdatedAt: string,
): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  const notificationTimestamp = Date.parse(notificationUpdatedAt);
  if (!Number.isFinite(timestamp) || !Number.isFinite(notificationTimestamp)) {
    return undefined;
  }
  return (
    timestamp >= notificationTimestamp - notificationActivityLookbackMilliseconds &&
    timestamp <= notificationTimestamp
  );
};

export const getActivitySuppressionReason = async (
  events: unknown[],
  notificationUpdatedAt: string,
  currentUserId: number,
  owner: string,
  loadCommitActorIds: CommitActorLoader,
): Promise<SuppressionReason | undefined> => {
  const activities = events.flatMap((event) => getTimelineActivities(event));
  const ignoredMergeKeys = new Set(
    activities.flatMap((activity) => {
      const [actorId] = activity.actorIds;
      if (
        isWithinNotificationActivityWindow(activity.occurredAt, notificationUpdatedAt) !== true ||
        activity.actorIds.length !== 1 ||
        actorId === undefined ||
        activity.event !== "merged" ||
        activity.occurredAt === undefined ||
        !isIgnoredMerger(owner, actorId)
      ) {
        return [];
      }
      return [getMergeKey(actorId, activity.occurredAt)];
    }),
  );
  let foundIgnoredBotReview = false;
  let foundCloudflareDeploymentComment = false;
  let foundIgnoredMerge = false;
  let foundPrCloserWarning = false;
  for (const activity of activities) {
    const withinNotificationWindow = isWithinNotificationActivityWindow(
      activity.occurredAt,
      notificationUpdatedAt,
    );
    if (withinNotificationWindow === false) {
      continue;
    }
    if (withinNotificationWindow === undefined) {
      return undefined;
    }

    if (activity.event === "committed") {
      if (activity.sha === undefined) {
        return undefined;
      }
      const commitActorIds = await loadCommitActorIds(activity.sha);
      if (commitActorIds === undefined || !commitActorIds.includes(currentUserId)) {
        return undefined;
      }
    } else {
      const actorIds = activity.actorIds;
      const [actorId] = actorIds;
      if (actorIds.length !== 1 || actorId === undefined) {
        return undefined;
      }
      let ignoredActivityKind = getIgnoredActivityKind(activity, actorId, currentUserId, owner);
      if (
        activity.event === "closed" &&
        activity.occurredAt !== undefined &&
        isIgnoredMerger(owner, actorId) &&
        ignoredMergeKeys.has(getMergeKey(actorId, activity.occurredAt))
      ) {
        ignoredActivityKind = "ignored_merge";
      }
      if (ignoredActivityKind === undefined) {
        return undefined;
      }
      if (ignoredActivityKind === "ignored_bot_review") {
        foundIgnoredBotReview = true;
      }
      if (ignoredActivityKind === "ignored_merge" && activity.event === "merged") {
        foundIgnoredMerge = true;
      }
      if (ignoredActivityKind === "cloudflare_deployment_comment") {
        foundCloudflareDeploymentComment = true;
      }
      if (ignoredActivityKind === "pr_closer_warning") {
        foundPrCloserWarning = true;
      }
    }
  }

  if (foundPrCloserWarning) {
    return "pr_closer_warning";
  }
  if (foundCloudflareDeploymentComment) {
    return "cloudflare_deployment_comment";
  }
  if (foundIgnoredMerge) {
    return "merged_by_ignored_merger";
  }
  if (foundIgnoredBotReview) {
    return "ignored_bot_review";
  }
  return undefined;
};

const getIgnoredActivityKind = (
  activity: TimelineActivity,
  actorId: number,
  currentUserId: number,
  owner: string,
): IgnoredActivityKind | undefined => {
  if (actorId === currentUserId) {
    return "current_user";
  }
  if (actorId === cloudflareWorkersAndPagesBotId && activity.event === "commented") {
    return "cloudflare_deployment_comment";
  }
  if (ignoredBotIds.has(actorId) && activity.isReviewActivity) {
    return "ignored_bot_review";
  }
  if (ignoredBotIds.has(actorId) && activity.event === "cross-referenced") {
    return "ignored_bot_reference";
  }
  if (isIgnoredMerger(owner, actorId) && activity.event === "merged") {
    return "ignored_merge";
  }
  if (
    owner === "jdx" &&
    actorId === githubActionsBotId &&
    activity.event === "commented" &&
    activity.body?.includes(prCloserWarningMarker) === true
  ) {
    return "pr_closer_warning";
  }
  return undefined;
};

const isIgnoredMerger = (owner: string, actorId: number): boolean => {
  return ignoredMergerIdsByOwner.get(owner)?.has(actorId) === true;
};

const getMergeKey = (actorId: number, occurredAt: string): string => {
  return JSON.stringify([actorId, occurredAt]);
};

const loadActivitySuppressionReason = async (
  octokit: Octokit,
  coordinates: PullRequestCoordinates,
  notificationUpdatedAt: string,
  currentUserId: number,
): Promise<SuppressionReason | undefined> => {
  const { owner, pullNumber, repo } = coordinates;
  const events = await octokit.paginate(octokit.rest.issues.listEventsForTimeline, {
    issue_number: pullNumber,
    owner,
    per_page: 100,
    repo,
  });
  return await getActivitySuppressionReason(
    events,
    notificationUpdatedAt,
    currentUserId,
    owner,
    async (sha) => {
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
    },
  );
};

const suppressionRulesByPriority: SuppressionRule[] = [
  {
    evaluate: ({ pullRequest }) => getRenovateSuppressionReason(pullRequest),
  },
  {
    evaluate: ({ coordinates, pullRequest }) => {
      const releasePullRequest = isReleasePullRequest({
        headRef: pullRequest.head.ref,
        owner: coordinates.owner,
      });
      if (releasePullRequest) {
        return "release_pull_request";
      }
      return undefined;
    },
  },
  {
    evaluate: ({ coordinates, currentUserId, pullRequest }) => {
      const openPullRequestByOtherAuthor = isOpenPullRequestByOtherAuthor({
        authorId: pullRequest.user?.id,
        currentUserId,
        owner: coordinates.owner,
        state: pullRequest.state,
      });
      if (openPullRequestByOtherAuthor) {
        return "open_pull_request_by_other_author";
      }
      return undefined;
    },
  },
  {
    evaluate: async ({
      coordinates,
      currentUserId,
      notificationUpdatedAt,
      octokit,
      pullRequest,
    }) => {
      const reason = await loadActivitySuppressionReason(
        octokit,
        coordinates,
        notificationUpdatedAt,
        currentUserId,
      );
      if (reason === "merged_by_ignored_merger" && pullRequest.user?.id !== currentUserId) {
        return undefined;
      }
      return reason;
    },
  },
];

const getSuppressionReason = async (
  context: SuppressionRuleContext,
): Promise<SuppressionReason | undefined> => {
  for (const rule of suppressionRulesByPriority) {
    const reason = await rule.evaluate(context);
    if (reason !== undefined) {
      return reason;
    }
  }
  return undefined;
};

export const printSummary = (
  summary: Summary,
  source: "discovery" | "queue",
  fullScan = false,
  since?: string,
): void => {
  console.log({
    event: "triage_summary",
    fullScan,
    since: since ?? null,
    source,
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
      method: undefined,
      rateLimitRemaining: undefined,
      requestId: undefined,
      retryAfter: undefined,
      status: undefined,
      url: undefined,
    };
  }

  const retryAfter = error.response?.headers["retry-after"];
  return {
    message: error.message,
    method: error.request.method,
    rateLimitRemaining: error.response?.headers["x-ratelimit-remaining"],
    requestId: error.response?.headers["x-github-request-id"],
    retryAfter: retryAfter === undefined ? undefined : String(retryAfter),
    status: error.status,
    url: error.request.url,
  };
};

const isRateLimited = (error: RequestError): boolean => {
  return (
    error.status === 429 ||
    error.response?.headers["x-ratelimit-remaining"] === "0" ||
    error.message.toLowerCase().includes("rate limit")
  );
};

export const getRetryDelaySeconds = (attempts: number, retryAfter?: string): number => {
  const requestedDelay = retryAfter === undefined ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(requestedDelay) && requestedDelay >= 0) {
    return Math.min(Math.ceil(requestedDelay), 24 * 60 * 60);
  }
  return Math.min(10 * 60 * 2 ** Math.max(attempts - 1, 0), 6 * 60 * 60);
};

export const discoverNotifications = async ({
  fullScan,
  retries,
  since,
  startedAt,
  token,
}: DiscoverOptions): Promise<NotificationDiscovery> => {
  const effectiveSince = fullScan ? undefined : since;
  const summary = createEmptySummary();
  const octokit = createGitHub(token);
  const notifications = await octokit.paginate(
    octokit.rest.activity.listNotificationsForAuthenticatedUser,
    {
      all: true,
      per_page: 100,
      since: effectiveSince,
    },
  );
  summary.notifications = notifications.length;
  summary.retried = retries.length;
  const retryById = new Map(retries.map((notification) => [notification.id, notification]));
  const candidates = new Map<string, Notification>();
  for (const notification of retries) {
    candidates.set(notification.id, notification);
  }
  for (const notification of notifications) {
    if (notification.subject.type !== "PullRequest" || notification.subject.url === null) {
      continue;
    }
    candidates.set(notification.id, {
      attemptCount: retryById.get(notification.id)?.attemptCount ?? 0,
      id: notification.id,
      lastReadAt: notification.last_read_at,
      subjectUrl: notification.subject.url,
      unread: notification.unread,
      updatedAt: notification.updated_at,
    });
  }
  summary.pullRequests = candidates.size;
  return { notifications: [...candidates.values()], startedAt, summary };
};

const triageNotification = async (
  notification: Notification,
  currentUserId: number,
  token: string,
): Promise<NotificationAudit> => {
  let currentNotification = notification;
  let coordinates: PullRequestCoordinates | undefined;
  try {
    const octokit = createGitHub(token, maxGitHubRequestsPerNotification);
    const threadId = parseThreadId(currentNotification.id);
    const { data: initialThread } = await octokit.rest.activity.getThread({
      thread_id: threadId,
    });
    if (initialThread.subject.type !== "PullRequest" || initialThread.subject.url === null) {
      return {
        notification: currentNotification,
        outcome: "retained",
        reason: "no_longer_pull_request",
      };
    }
    currentNotification = {
      ...currentNotification,
      lastReadAt: initialThread.last_read_at,
      subjectUrl: initialThread.subject.url,
      unread: initialThread.unread,
      updatedAt: initialThread.updated_at,
    };

    coordinates = parsePullRequestUrl(currentNotification.subjectUrl);
    const { owner, pullNumber, repo } = coordinates;
    const { data: pullRequest } = await octokit.rest.pulls.get({
      owner,
      pull_number: pullNumber,
      repo,
    });

    const suppressionReason = await getSuppressionReason({
      coordinates,
      currentUserId,
      notificationUpdatedAt: currentNotification.updatedAt,
      octokit,
      pullRequest,
    });
    if (suppressionReason === undefined) {
      return {
        notification: currentNotification,
        outcome: "retained",
        pullNumber,
        reason: "requires_attention",
        repository: `${owner}/${repo}`,
      };
    }

    const { data: currentThread } = await octokit.rest.activity.getThread({
      thread_id: threadId,
    });
    if (
      currentThread.updated_at !== currentNotification.updatedAt ||
      currentThread.last_read_at !== currentNotification.lastReadAt ||
      currentThread.unread !== currentNotification.unread
    ) {
      console.warn({
        event: "notification_concurrently_updated",
        pullRequestUrl: pullRequest.html_url,
      });
      return {
        notification: currentNotification,
        outcome: "retained",
        pullNumber,
        reason: "concurrently_updated",
        repository: `${owner}/${repo}`,
      };
    }

    await octokit.rest.activity.markThreadAsDone({
      thread_id: threadId,
    });
    console.log({
      event: "notification_marked_done",
      pullRequestUrl: pullRequest.html_url,
      reason: suppressionReason,
    });
    return {
      notification: currentNotification,
      outcome: "marked_done",
      pullNumber,
      reason: suppressionReason,
      repository: `${owner}/${repo}`,
    };
  } catch (error) {
    if (error instanceof RequestBudgetExceeded) {
      return {
        notification: currentNotification,
        outcome: "retained",
        reason: "evaluation_budget_exceeded",
        ...(coordinates === undefined
          ? {}
          : {
              pullNumber: coordinates.pullNumber,
              repository: `${coordinates.owner}/${coordinates.repo}`,
            }),
      };
    }
    const details = getGitHubErrorDetails(error);
    console.error({
      event: "notification_evaluation_failed",
      notificationId: currentNotification.id,
      subjectUrl: currentNotification.subjectUrl,
      ...details,
    });
    return {
      error: details,
      notification: currentNotification,
      outcome: "retry_pending",
      reason: "evaluation_failed",
      ...(coordinates === undefined
        ? {}
        : {
            pullNumber: coordinates.pullNumber,
            repository: `${coordinates.owner}/${coordinates.repo}`,
          }),
    };
  }
};

export const triageNotifications = async ({
  notifications,
  startedAt,
  token,
}: TriageOptions): Promise<TriageResult> => {
  const summary = createEmptySummary();
  summary.notifications = notifications.length;
  summary.pullRequests = notifications.length;
  summary.retried = notifications.filter((notification) => notification.attemptCount > 0).length;
  const audits: NotificationAudit[] = [];

  try {
    const octokit = createGitHub(token);
    const { data: authenticatedUser } = await octokit.rest.users.getAuthenticated();
    for (const notification of notifications) {
      const audit = await triageNotification(notification, authenticatedUser.id, token);
      audits.push(audit);
      if (audit.outcome === "marked_done") {
        summary.evaluated += 1;
        summary.markedDone += 1;
        if (renovateSuppressionReasons.has(audit.reason)) {
          summary.renovateMarkedDone += 1;
        } else if (audit.reason === "release_pull_request") {
          summary.releaseMarkedDone += 1;
        } else if (audit.reason === "open_pull_request_by_other_author") {
          summary.openPullRequestMarkedDone += 1;
        } else if (audit.reason === "pr_closer_warning") {
          summary.prCloserWarningMarkedDone += 1;
        } else if (audit.reason === "cloudflare_deployment_comment") {
          summary.cloudflareDeploymentMarkedDone += 1;
        } else if (audit.reason === "merged_by_ignored_merger") {
          summary.mergeMarkedDone += 1;
        } else {
          summary.botReviewMarkedDone += 1;
        }
      } else if (audit.outcome === "retained") {
        if (audit.reason !== "no_longer_pull_request") {
          summary.evaluated += 1;
        }
        summary.retained += 1;
      } else {
        summary.retryPending += 1;
      }
    }
  } catch (error) {
    throw new TriageFailure(error, { audits, startedAt, summary });
  } finally {
    printSummary(summary, "queue");
  }

  return { audits, startedAt, summary };
};
