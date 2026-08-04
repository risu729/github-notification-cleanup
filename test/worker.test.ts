import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runNotificationCleanup } from "../src";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

const response = (body: unknown, status = 200): Response => {
  return Response.json(body, { status });
};

const mockGitHub = (notifications: unknown[] = []): void => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
    const pathname = new URL(url).pathname;
    if (pathname === "/user") {
      return response({ id: 79_110_363, login: "risu729" });
    }
    if (pathname === "/notifications") {
      return response(notifications);
    }
    return response({ message: "unexpected test request" }, 500);
  });
};

describe("scheduled Worker state", () => {
  beforeEach(async () => {
    await Promise.all([
      env.STATE.delete("force-check-all"),
      env.STATE.delete("notification-state"),
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("stores the successful check time as JSON", async () => {
    mockGitHub();

    await runNotificationCleanup(env);

    const state = await env.STATE.get<{ lastCheckedAt: string }>("notification-state", "json");
    expect(state).not.toBeNull();
    expect(Date.parse(state?.lastCheckedAt ?? "invalid")).not.toBeNaN();
  });

  test("does not advance the state after a GitHub API failure", async () => {
    const previousState = { lastCheckedAt: "2026-08-04T00:00:00Z" };
    await env.STATE.put("notification-state", JSON.stringify(previousState));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ message: "failure" }, 500));

    await expect(runNotificationCleanup(env)).rejects.toThrow();

    await expect(
      env.STATE.get<{ lastCheckedAt: string }>("notification-state", "json"),
    ).resolves.toEqual(previousState);
  });

  test("retains a queued full-check request after failure", async () => {
    await env.STATE.put("force-check-all", "true");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ message: "failure" }, 500));

    await expect(runNotificationCleanup(env)).rejects.toThrow();

    await expect(env.STATE.get("force-check-all")).resolves.toBe("true");
  });

  test("consumes a queued full-check request after success", async () => {
    mockGitHub();
    await env.STATE.put("force-check-all", "true");

    await runNotificationCleanup(env);

    await expect(env.STATE.get("force-check-all")).resolves.toBeNull();
  });
});
