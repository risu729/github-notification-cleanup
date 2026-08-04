import { formatTriageError, triageNotifications } from "./triage";
import { forceCheckKey, loadNotificationState, saveNotificationState } from "./state";

export { parseNotificationState } from "./state";

export const runNotificationCleanup = async (env: Env, force = false): Promise<void> => {
  const forceRequested = force || (await env.STATE.get(forceCheckKey)) !== null;
  const state = forceRequested ? undefined : await loadNotificationState(env.STATE);
  const result = await triageNotifications({
    force: forceRequested,
    since: state?.lastCheckedAt,
    token: env.GH_TOKEN,
  });
  await saveNotificationState(env.STATE, result.startedAt);
  if (forceRequested) {
    await env.STATE.delete(forceCheckKey);
  }
};

export default {
  async scheduled(controller, env): Promise<void> {
    try {
      await runNotificationCleanup(env);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "triage_failed",
          message: formatTriageError(error),
          scheduledTime: new Date(controller.scheduledTime).toISOString(),
        }),
      );
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
