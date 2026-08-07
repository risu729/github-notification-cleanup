import {
  createEmptySummary,
  formatTriageError,
  triageNotifications,
  TriageFailure,
} from "./triage";
import { loadCleanupState, recordFailedRun, recordSuccessfulRun } from "./state";

type CleanupOptions = {
  fullScan?: boolean;
  scheduledAt?: string;
};

export const runNotificationCleanup = async (
  env: Env,
  { fullScan = false, scheduledAt }: CleanupOptions = {},
): Promise<void> => {
  const startedAt = new Date().toISOString();
  let since: string | undefined;

  try {
    const state = await loadCleanupState(env.DB);
    fullScan ||= state.fullScanRequested;
    since = fullScan ? undefined : state.lastCheckedAt;
    const result = await triageNotifications({
      fullScan,
      since,
      startedAt,
      token: env.GH_TOKEN,
    });
    await recordSuccessfulRun(env.DB, {
      ...result,
      fullScan,
      scheduledAt,
      since,
    });
  } catch (error) {
    const result =
      error instanceof TriageFailure ? error.result : { startedAt, summary: createEmptySummary() };
    const message = formatTriageError(error);
    try {
      await recordFailedRun(env.DB, {
        ...result,
        error: message,
        fullScan,
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
