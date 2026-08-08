import { v7 as uuidv7 } from "uuid";

import {
  createEmptySummary,
  formatTriageError,
  triageNotifications,
  TriageFailure,
} from "./triage";
import { loadCleanupState, loadPendingRetries, recordCompletedRun, recordFailedRun } from "./state";

type CleanupOptions = {
  fullScan?: boolean;
  scheduledAt?: string;
};

export const runNotificationCleanup = async (
  env: Env,
  { fullScan = false, scheduledAt }: CleanupOptions = {},
): Promise<void> => {
  const startedAt = new Date().toISOString();
  const runId = uuidv7();
  let since: string | undefined;

  try {
    const state = await loadCleanupState(env.DB);
    fullScan ||= state.fullScanRequested;
    since = fullScan ? undefined : state.lastCheckedAt;
    const retries = await loadPendingRetries(env.DB, startedAt);
    const result = await triageNotifications({
      fullScan,
      retries,
      since,
      startedAt,
      token: env.GH_TOKEN,
    });
    await recordCompletedRun(env.DB, {
      ...result,
      fullScan,
      runId,
      scheduledAt,
      since,
    });
  } catch (error) {
    const result =
      error instanceof TriageFailure
        ? error.result
        : { audits: [], startedAt, summary: createEmptySummary() };
    const message = formatTriageError(error);
    try {
      await recordFailedRun(env.DB, {
        ...result,
        error: message,
        fullScan,
        runId,
        scheduledAt,
        since,
      });
    } catch (storageError) {
      console.error({
        event: "triage_run_record_failed",
        message: storageError instanceof Error ? storageError.message : String(storageError),
      });
    }
    throw error;
  }
};

export default {
  async scheduled(controller, env): Promise<void> {
    const scheduledAt = new Date(controller.scheduledTime).toISOString();
    try {
      await runNotificationCleanup(env, { scheduledAt });
    } catch (error) {
      console.error({
        event: "triage_failed",
        message: formatTriageError(error),
        scheduledAt,
      });
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
