import { formatTriageError, triageNotifications } from "./triage";

const forceKey = "force-check-all";
const stateKey = "notification-state";

type NotificationState = {
  lastCheckedAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

export const parseNotificationState = (value: unknown): NotificationState | undefined => {
  if (
    !isRecord(value) ||
    typeof value["lastCheckedAt"] !== "string" ||
    !Number.isFinite(Date.parse(value["lastCheckedAt"]))
  ) {
    return undefined;
  }
  return { lastCheckedAt: value["lastCheckedAt"] };
};

const loadState = async (state: KVNamespace): Promise<NotificationState | undefined> => {
  let value: unknown;
  try {
    value = await state.get<unknown>(stateKey, "json");
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "notification_state_malformed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return undefined;
  }

  if (value === null) {
    return undefined;
  }
  const parsed = parseNotificationState(value);
  if (parsed === undefined) {
    console.warn(JSON.stringify({ event: "notification_state_invalid" }));
  }
  return parsed;
};

export const runNotificationCleanup = async (env: Env, force = false): Promise<void> => {
  const forceRequested = force || (await env.STATE.get(forceKey)) !== null;
  const state = forceRequested ? undefined : await loadState(env.STATE);
  const result = await triageNotifications({
    force: forceRequested,
    since: state?.lastCheckedAt,
    token: env.GH_TOKEN,
  });
  await env.STATE.put(
    stateKey,
    `${JSON.stringify({ lastCheckedAt: result.startedAt }, undefined, 2)}\n`,
  );
  if (forceRequested) {
    await env.STATE.delete(forceKey);
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
