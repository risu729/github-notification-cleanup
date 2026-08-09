import { v7 as uuidv7 } from "uuid";

import {
  createEmptySummary,
  discoverNotifications,
  formatTriageError,
  getRetryDelaySeconds,
  type Notification,
  type NotificationAudit,
  printSummary,
  triageNotifications,
  TriageFailure,
} from "./triage";
import { loadCleanupState, loadPendingRetries, recordCompletedRun, recordFailedRun } from "./state";

type DiscoveryOptions = {
  fullScan?: boolean;
  scheduledAt?: string;
};

const queueBatchSize = 100;

const enqueueNotifications = async (
  queue: Queue<Notification>,
  notifications: Notification[],
): Promise<void> => {
  for (let index = 0; index < notifications.length; index += queueBatchSize) {
    const batch = notifications.slice(index, index + queueBatchSize);
    await queue.sendBatch(batch.map((body) => ({ body, contentType: "json" })));
  }
};

export const discoverAndEnqueueNotifications = async (
  env: Env,
  { fullScan = false, scheduledAt }: DiscoveryOptions = {},
): Promise<void> => {
  const startedAt = new Date().toISOString();
  const runId = uuidv7();
  let since: string | undefined;

  try {
    const state = await loadCleanupState(env.DB);
    fullScan ||= state.fullScanRequested;
    since = fullScan ? undefined : state.lastCheckedAt;
    const retries = await loadPendingRetries(env.DB, startedAt);
    const result = await discoverNotifications({
      fullScan,
      retries,
      since,
      startedAt,
      token: env.GH_TOKEN,
    });
    await enqueueNotifications(env.NOTIFICATION_QUEUE, result.notifications);
    await recordCompletedRun(
      env.DB,
      {
        ...result,
        audits: [],
        fullScan,
        runId,
        scheduledAt,
        since,
      },
      {
        advanceCheckpoint: true,
        migratedRetryIds: retries.map((notification) => notification.id),
      },
    );
    printSummary(result.summary, "discovery", fullScan, since);
  } catch (error) {
    const message = formatTriageError(error);
    try {
      await recordFailedRun(env.DB, {
        audits: [],
        error: message,
        fullScan,
        runId,
        scheduledAt,
        since,
        startedAt,
        summary: createEmptySummary(),
      });
    } catch (storageError) {
      console.error({
        event: "discovery_run_record_failed",
        message: storageError instanceof Error ? storageError.message : String(storageError),
      });
    }
    throw error;
  }
};

const processNotificationBatch = async (
  batch: MessageBatch<Notification>,
  env: Env,
): Promise<void> => {
  const startedAt = new Date().toISOString();
  const runId = uuidv7();
  const notifications = batch.messages.map((message) => ({
    ...message.body,
    attemptCount: message.body.attemptCount + message.attempts - 1,
  }));

  let result;
  try {
    result = await triageNotifications({ notifications, startedAt, token: env.GH_TOKEN });
  } catch (error) {
    const failedResult =
      error instanceof TriageFailure
        ? error.result
        : { audits: [], startedAt, summary: createEmptySummary() };
    await recordFailedRun(env.DB, {
      ...failedResult,
      error: formatTriageError(error),
      fullScan: false,
      runId,
      scheduledAt: undefined,
      since: undefined,
    });
    const attempts = Math.max(...batch.messages.map((message) => message.attempts));
    batch.retryAll({ delaySeconds: getRetryDelaySeconds(attempts) });
    return;
  }

  await recordCompletedRun(env.DB, {
    ...result,
    fullScan: false,
    runId,
    scheduledAt: undefined,
    since: undefined,
  });
  for (const [index, message] of batch.messages.entries()) {
    const audit = result.audits[index];
    if (audit?.outcome === "retry_pending") {
      message.retry({
        delaySeconds: getRetryDelaySeconds(message.attempts, audit.error?.retryAfter),
      });
    } else {
      message.ack();
    }
  }
};

const recordExhaustedBatch = async (batch: MessageBatch<Notification>, env: Env): Promise<void> => {
  const startedAt = new Date().toISOString();
  const notifications = batch.messages.map((message) => ({
    ...message.body,
    attemptCount: message.body.attemptCount + message.attempts - 1,
  }));
  const summary = createEmptySummary();
  summary.notifications = notifications.length;
  summary.pullRequests = notifications.length;
  summary.retained = notifications.length;
  summary.retryExhausted = notifications.length;
  const audits: NotificationAudit[] = notifications.map((notification) => ({
    notification,
    outcome: "retained",
    reason: "retry_exhausted",
  }));
  await recordCompletedRun(env.DB, {
    audits,
    fullScan: false,
    runId: uuidv7(),
    scheduledAt: undefined,
    since: undefined,
    startedAt,
    summary,
  });
  batch.ackAll();
  printSummary(summary, "queue");
};

export default {
  async queue(batch, env): Promise<void> {
    if (batch.queue === env.DEAD_LETTER_QUEUE_NAME) {
      await recordExhaustedBatch(batch, env);
    } else {
      await processNotificationBatch(batch, env);
    }
  },
  async scheduled(controller, env): Promise<void> {
    const scheduledAt = new Date(controller.scheduledTime).toISOString();
    try {
      await discoverAndEnqueueNotifications(env, { scheduledAt });
    } catch (error) {
      console.error({
        event: "notification_discovery_failed",
        message: formatTriageError(error),
        scheduledAt,
      });
      throw error;
    }
  },
} satisfies ExportedHandler<Env, Notification>;
