export const forceCheckKey = "force-check-all";
export const notificationStateKey = "notification-state";

export type NotificationState = {
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

export const loadNotificationState = async (
  state: KVNamespace,
): Promise<NotificationState | undefined> => {
  let value: unknown;
  try {
    value = await state.get<unknown>(notificationStateKey, "json");
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

export const saveNotificationState = async (
  state: KVNamespace,
  lastCheckedAt: string,
): Promise<void> => {
  await state.put(notificationStateKey, `${JSON.stringify({ lastCheckedAt }, undefined, 2)}\n`);
};
