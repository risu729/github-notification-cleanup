import { Octokit } from "@octokit/rest";
import { afterEach, describe, expect, test, vi } from "vitest";

import { isFailedCheckNotification } from "../src/checks";

const octokit = new Octokit({ auth: "test" });
const candidate = {
  repository: "external/project",
  subjectTitle: "External CI",
  subjectType: "CheckSuite",
  subjectUrl: "https://api.github.com/notifications/threads/1",
};

afterEach(() => {
  vi.restoreAllMocks();
});

test.each([
  "CI workflow run failed for main branch",
  "CI workflow run, Attempt #2 failed for feature branch",
])("recognizes the generated Actions failure title: %s", async (subjectTitle) => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const result = await isFailedCheckNotification({ ...candidate, subjectTitle }, octokit);
  expect(result).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

test.each([
  "CI workflow run succeeded for main branch",
  "CI workflow run cancelled for main branch",
  "CI workflow run, Attempt #2 queued for feature branch",
  "failed tests workflow run succeeded for main branch",
])("retains an unproven failure: %s", async (subjectTitle) => {
  const result = await isFailedCheckNotification({ ...candidate, subjectTitle }, octokit);
  expect(result).toBe(false);
});

describe.each(["check-suites", "check-runs"])("%s", (resource) => {
  test.each([
    { conclusion: "failure", expected: true },
    { conclusion: "timed_out", expected: true },
    { conclusion: "startup_failure", expected: true },
    { conclusion: "success", expected: false },
    { conclusion: "neutral", expected: false },
    { conclusion: "cancelled", expected: false },
    { conclusion: null, expected: false },
  ])("classifies completed conclusion $conclusion", async ({ conclusion, expected }) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ conclusion, status: "completed" }));
    const notification = {
      ...candidate,
      subjectUrl: `https://api.github.com/repos/external/project/${resource}/700`,
    };

    await expect(isFailedCheckNotification(notification, octokit)).resolves.toBe(expected);
    expect(fetch).toHaveBeenCalled();
  });

  test("retains an incomplete check", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ conclusion: "failure", status: "in_progress" }),
    );
    await expect(
      isFailedCheckNotification(
        {
          ...candidate,
          subjectUrl: `https://api.github.com/repos/external/project/${resource}/700`,
        },
        octokit,
      ),
    ).resolves.toBe(false);
  });
});

test.each([
  "https://example.com/repos/external/project/check-suites/700",
  "https://api.github.com/repos/different/project/check-suites/700",
  "https://api.github.com/repos/external/project/check-runs/9007199254740992",
])("does not fetch an unrelated or invalid check URL: %s", async (subjectUrl) => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const result = await isFailedCheckNotification({ ...candidate, subjectUrl }, octokit);
  expect(result).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

test("does not classify a PR conversation from its title", async () => {
  await expect(
    isFailedCheckNotification(
      {
        ...candidate,
        subjectTitle: "CI workflow run failed for main branch",
        subjectType: "PullRequest",
      },
      octokit,
    ),
  ).resolves.toBe(false);
});

test("propagates a transient Checks API failure for the Queue retry", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ message: "unavailable" }, { status: 503 }),
  );
  await expect(
    isFailedCheckNotification(
      {
        ...candidate,
        subjectUrl: "https://api.github.com/repos/external/project/check-suites/700",
      },
      octokit,
    ),
  ).rejects.toMatchObject({ status: 503 });
});
