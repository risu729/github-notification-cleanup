import { describe, expect, test } from "vitest";

import {
  getActivitySuppressionReason as classifyActivities,
  isOpenPullRequestByOtherAuthor,
  isReleasePullRequest,
} from "../src/triage";

const aiReviewerId = 136_622_811;
const brewTestBotId = 1_589_480;
const cloudflareWorkersAndPagesBotId = 73_139_402;
const codeRabbitCommandTargetId = 132_028_505;
const codecovBotId = 22_429_695;
const currentUserId = 79_110_363;
const greptileBotId = 165_735_046;
const greptileCommandTargetId = 140_149_887;
const githubActionsBotId = 41_898_282;
const humanId = 1;
const jdxUserId = 216_188;
const notificationUpdatedAt = "2026-08-04T00:05:00Z";
const miseEnDevBotId = 123_107_610;
const sourceryBotId = 58_596_630;
const sourceryCommandTargetId = 36_609_879;

const comment = (
  actorId: number,
  createdAt: string,
  updatedAt = createdAt,
  body?: string,
): unknown => ({
  actor: { id: actorId },
  body,
  created_at: createdAt,
  event: "commented",
  updated_at: updatedAt,
});

const review = (actorId: number, submittedAt: string): unknown => ({
  event: "reviewed",
  submitted_at: submittedAt,
  user: { id: actorId },
});

const commit = (committedAt: string): unknown => ({
  committer: { date: committedAt },
  event: "committed",
  sha: "abc123",
});

const timelineEvent = (event: string, actorId: number, createdAt: string): unknown => ({
  actor: { id: actorId },
  created_at: createdAt,
  event,
});

const noCommitActors = async (): Promise<number[]> => [];
const hasOnlyIgnoredActivities = async (
  events: unknown[],
  notificationUpdatedAt: string,
  loadCommitActorIds: (sha: string) => Promise<number[] | undefined>,
): Promise<boolean> => {
  const reason = await classifyActivities(
    events,
    notificationUpdatedAt,
    currentUserId,
    "owner",
    loadCommitActorIds,
  );
  return reason !== undefined;
};

describe("release pull request suppression", () => {
  test.each([
    {
      headRef: "release",
      owner: "jdx",
    },
    {
      headRef: "release-please--branches--main--components--mise",
      owner: "jdx",
    },
    {
      headRef: "release-plz-2026-08-03T19-44-40Z",
      owner: "risu729",
    },
    {
      headRef: "release",
      owner: "risu729",
    },
  ])("suppresses $owner release branches", (pullRequest) => {
    expect(isReleasePullRequest(pullRequest)).toBe(true);
  });

  test.each([
    {
      headRef: "release",
      owner: "someone-else",
    },
    {
      headRef: "feature/automate-release",
      owner: "jdx",
    },
  ])("retains non-release match %#", (pullRequest) => {
    expect(isReleasePullRequest(pullRequest)).toBe(false);
  });
});

describe("open pull request suppression by author", () => {
  test("suppresses an open PR by another author", () => {
    expect(
      isOpenPullRequestByOtherAuthor({
        authorId: humanId,
        currentUserId,
        owner: "jdx",
        state: "open",
      }),
    ).toBe(true);
  });

  test.each([
    {
      authorId: currentUserId,
      currentUserId,
      owner: "jdx",
      state: "open",
    },
    {
      authorId: humanId,
      currentUserId,
      owner: "jdx",
      state: "closed",
    },
    {
      authorId: humanId,
      currentUserId,
      owner: "risu729",
      state: "open",
    },
    {
      authorId: undefined,
      currentUserId,
      owner: "jdx",
      state: "open",
    },
  ] as const)("retains non-match %#", (pullRequest) => {
    expect(isOpenPullRequestByOtherAuthor(pullRequest)).toBe(false);
  });
});

describe("bot review notification suppression", () => {
  test("suppresses a configured-bot-only comment within the notification window", async () => {
    const result = await hasOnlyIgnoredActivities(
      [comment(aiReviewerId, "2026-08-04T00:01:00Z")],
      notificationUpdatedAt,
      noCommitActors,
    );

    expect(result).toBe(true);
  });

  test("ignores activity by risu729 around a bot review", async () => {
    const result = await hasOnlyIgnoredActivities(
      [
        comment(currentUserId, "2026-08-04T00:01:00Z"),
        review(aiReviewerId, "2026-08-04T00:02:00Z"),
      ],
      notificationUpdatedAt,
      noCommitActors,
    );

    expect(result).toBe(true);
  });

  test("ignores a cross-reference attributable to risu729", async () => {
    const result = await hasOnlyIgnoredActivities(
      [
        {
          actor: { id: currentUserId },
          created_at: "2026-08-04T00:01:00Z",
          event: "cross-referenced",
        },
        review(aiReviewerId, "2026-08-04T00:02:00Z"),
      ],
      notificationUpdatedAt,
      noCommitActors,
    );

    expect(result).toBe(true);
  });

  test("ignores a cross-reference from a configured bot around a bot review", async () => {
    const result = await hasOnlyIgnoredActivities(
      [
        {
          actor: { id: aiReviewerId },
          created_at: "2026-08-04T00:01:00Z",
          event: "cross-referenced",
        },
        review(aiReviewerId, "2026-08-04T00:02:00Z"),
      ],
      notificationUpdatedAt,
      noCommitActors,
    );

    expect(result).toBe(true);
  });

  test("does not suppress a configured bot cross-reference by itself", async () => {
    const result = await hasOnlyIgnoredActivities(
      [
        {
          actor: { id: aiReviewerId },
          created_at: "2026-08-04T00:01:00Z",
          event: "cross-referenced",
        },
      ],
      notificationUpdatedAt,
      noCommitActors,
    );

    expect(result).toBe(false);
  });

  test.each([
    {
      commandTargetId: codeRabbitCommandTargetId,
      name: "CodeRabbit",
      responseBotId: aiReviewerId,
    },
    {
      commandTargetId: greptileCommandTargetId,
      name: "Greptile",
      responseBotId: greptileBotId,
    },
    {
      commandTargetId: sourceryCommandTargetId,
      name: "Sourcery",
      responseBotId: sourceryBotId,
    },
  ])(
    "ignores a $name command mention around its bot response",
    async ({ commandTargetId, responseBotId }) => {
      const reason = await classifyActivities(
        [
          comment(currentUserId, "2026-08-04T00:00:30Z"),
          timelineEvent("mentioned", commandTargetId, "2026-08-04T00:01:00Z"),
          comment(responseBotId, "2026-08-04T00:02:00Z"),
        ],
        notificationUpdatedAt,
        currentUserId,
        "owner",
        noCommitActors,
      );

      expect(reason).toBe("ignored_bot_review");
    },
  );

  test.each([
    { commandTargetId: codeRabbitCommandTargetId, name: "CodeRabbit" },
    { commandTargetId: greptileCommandTargetId, name: "Greptile" },
    { commandTargetId: sourceryCommandTargetId, name: "Sourcery" },
  ])("does not suppress a $name command mention by itself", async ({ commandTargetId }) => {
    const reason = await classifyActivities(
      [timelineEvent("mentioned", commandTargetId, "2026-08-04T00:01:00Z")],
      notificationUpdatedAt,
      currentUserId,
      "owner",
      noCommitActors,
    );

    expect(reason).toBeUndefined();
  });

  test("retains an unknown mention around a configured bot response", async () => {
    const reason = await classifyActivities(
      [
        timelineEvent("mentioned", humanId, "2026-08-04T00:01:00Z"),
        comment(aiReviewerId, "2026-08-04T00:02:00Z"),
      ],
      notificationUpdatedAt,
      currentUserId,
      "owner",
      noCommitActors,
    );

    expect(reason).toBeUndefined();
  });

  test.each([miseEnDevBotId, brewTestBotId, codecovBotId])(
    "suppresses comments from configured bot %s",
    async (actorId) => {
      const reason = await classifyActivities(
        [comment(actorId, "2026-08-04T00:01:00Z")],
        notificationUpdatedAt,
        currentUserId,
        "owner",
        noCommitActors,
      );

      expect(reason).toBe("ignored_bot_review");
    },
  );

  test.each([miseEnDevBotId, brewTestBotId, codecovBotId])(
    "ignores cross-references from configured bot %s around a bot review",
    async (actorId) => {
      const result = await hasOnlyIgnoredActivities(
        [
          timelineEvent("cross-referenced", actorId, "2026-08-04T00:01:00Z"),
          review(aiReviewerId, "2026-08-04T00:02:00Z"),
        ],
        notificationUpdatedAt,
        noCommitActors,
      );

      expect(result).toBe(true);
    },
  );

  test.each([miseEnDevBotId, brewTestBotId, codecovBotId])(
    "does not suppress configured bot %s cross-references by themselves",
    async (actorId) => {
      const result = await hasOnlyIgnoredActivities(
        [timelineEvent("cross-referenced", actorId, "2026-08-04T00:01:00Z")],
        notificationUpdatedAt,
        noCommitActors,
      );

      expect(result).toBe(false);
    },
  );

  test("retains a cross-reference from another actor", async () => {
    const result = await hasOnlyIgnoredActivities(
      [
        {
          actor: { id: humanId },
          created_at: "2026-08-04T00:01:00Z",
          event: "cross-referenced",
        },
        review(aiReviewerId, "2026-08-04T00:02:00Z"),
      ],
      notificationUpdatedAt,
      noCommitActors,
    );

    expect(result).toBe(false);
  });

  test("retains a human comment immediately before a bot review", async () => {
    const result = await hasOnlyIgnoredActivities(
      [comment(humanId, "2026-08-04T00:01:00Z"), review(aiReviewerId, "2026-08-04T00:02:00Z")],
      notificationUpdatedAt,
      noCommitActors,
    );

    expect(result).toBe(false);
  });

  test("retains a human comment edited after it was read", async () => {
    const result = await hasOnlyIgnoredActivities(
      [
        comment(humanId, "2026-08-03T23:59:00Z", "2026-08-04T00:01:00Z"),
        review(aiReviewerId, "2026-08-04T00:02:00Z"),
      ],
      notificationUpdatedAt,
      noCommitActors,
    );

    expect(result).toBe(false);
  });

  test("retains a human event at the notification timestamp", async () => {
    const result = await hasOnlyIgnoredActivities(
      [comment(humanId, notificationUpdatedAt), review(aiReviewerId, "2026-08-04T00:01:00Z")],
      notificationUpdatedAt,
      noCommitActors,
    );

    expect(result).toBe(false);
  });

  test("ignores human comments older than the notification window", async () => {
    const result = await hasOnlyIgnoredActivities(
      [comment(humanId, "2026-08-03T23:59:00Z"), review(aiReviewerId, "2026-08-04T00:01:00Z")],
      notificationUpdatedAt,
      noCommitActors,
    );

    expect(result).toBe(true);
  });

  test("allows a commit attributable to risu729", async () => {
    const result = await hasOnlyIgnoredActivities(
      [commit("2026-08-04T00:01:00Z"), review(aiReviewerId, "2026-08-04T00:02:00Z")],
      notificationUpdatedAt,
      async () => [currentUserId],
    );

    expect(result).toBe(true);
  });

  test("retains a commit not attributable to risu729", async () => {
    const result = await hasOnlyIgnoredActivities(
      [commit("2026-08-04T00:01:00Z"), review(aiReviewerId, "2026-08-04T00:02:00Z")],
      notificationUpdatedAt,
      async () => [humanId],
    );

    expect(result).toBe(false);
  });

  test("retains a commit that can no longer be fetched", async () => {
    const result = await hasOnlyIgnoredActivities(
      [commit("2026-08-04T00:01:00Z"), review(aiReviewerId, "2026-08-04T00:02:00Z")],
      notificationUpdatedAt,
      async () => undefined,
    );

    expect(result).toBe(false);
  });

  test.each(["renamed", "labeled", "ready_for_review", "future-event"])(
    "ignores attributable current-user %s activity around a bot review",
    async (event) => {
      const result = await hasOnlyIgnoredActivities(
        [
          {
            actor: { id: currentUserId },
            created_at: "2026-08-04T00:01:00Z",
            event,
          },
          review(aiReviewerId, "2026-08-04T00:02:00Z"),
        ],
        notificationUpdatedAt,
        noCommitActors,
      );

      expect(result).toBe(true);
    },
  );

  test("retains unknown activity from another actor", async () => {
    const result = await hasOnlyIgnoredActivities(
      [
        {
          actor: { id: humanId },
          created_at: "2026-08-04T00:01:00Z",
          event: "future-event",
        },
        review(aiReviewerId, "2026-08-04T00:02:00Z"),
      ],
      notificationUpdatedAt,
      noCommitActors,
    );

    expect(result).toBe(false);
  });

  test("suppresses a merge by the authenticated user with supporting self activity", async () => {
    const mergedAt = "2026-08-04T00:02:00Z";
    const reason = await classifyActivities(
      [
        timelineEvent("auto_squash_enabled", currentUserId, "2026-08-04T00:01:00Z"),
        timelineEvent("merged", currentUserId, mergedAt),
        timelineEvent("closed", currentUserId, mergedAt),
        timelineEvent("head_ref_deleted", currentUserId, "2026-08-04T00:02:01Z"),
      ],
      notificationUpdatedAt,
      currentUserId,
      "risu729",
      noCommitActors,
    );

    expect(reason).toBe("merged_by_current_user");
  });

  test("retains a current-user merge with concurrent human activity", async () => {
    const reason = await classifyActivities(
      [
        timelineEvent("merged", currentUserId, "2026-08-04T00:02:00Z"),
        comment(humanId, "2026-08-04T00:03:00Z"),
      ],
      notificationUpdatedAt,
      currentUserId,
      "risu729",
      noCommitActors,
    );

    expect(reason).toBeUndefined();
  });

  test("suppresses a jdx merge and its paired close with supporting bot activity", async () => {
    const mergedAt = "2026-08-04T00:02:00Z";
    const reason = await classifyActivities(
      [
        timelineEvent("ready_for_review", currentUserId, "2026-08-04T00:01:30Z"),
        timelineEvent("merged", jdxUserId, mergedAt),
        timelineEvent("closed", jdxUserId, mergedAt),
        timelineEvent("cross-referenced", miseEnDevBotId, "2026-08-04T00:03:00Z"),
        timelineEvent("cross-referenced", brewTestBotId, "2026-08-04T00:04:00Z"),
      ],
      notificationUpdatedAt,
      currentUserId,
      "jdx",
      noCommitActors,
    );

    expect(reason).toBe("merged_by_ignored_merger");
  });

  test("retains a jdx close without a matching merge", async () => {
    const reason = await classifyActivities(
      [
        review(aiReviewerId, "2026-08-04T00:01:00Z"),
        timelineEvent("closed", jdxUserId, "2026-08-04T00:02:00Z"),
      ],
      notificationUpdatedAt,
      currentUserId,
      "jdx",
      noCommitActors,
    );

    expect(reason).toBeUndefined();
  });

  test("retains a jdx close whose merge has a different timestamp", async () => {
    const reason = await classifyActivities(
      [
        review(aiReviewerId, "2026-08-04T00:01:00Z"),
        timelineEvent("merged", jdxUserId, "2026-08-04T00:02:00Z"),
        timelineEvent("closed", jdxUserId, "2026-08-04T00:03:00Z"),
      ],
      notificationUpdatedAt,
      currentUserId,
      "jdx",
      noCommitActors,
    );

    expect(reason).toBeUndefined();
  });

  test("retains the same merge pair outside jdx", async () => {
    const mergedAt = "2026-08-04T00:02:00Z";
    const reason = await classifyActivities(
      [
        review(aiReviewerId, "2026-08-04T00:01:00Z"),
        timelineEvent("merged", jdxUserId, mergedAt),
        timelineEvent("closed", jdxUserId, mergedAt),
      ],
      notificationUpdatedAt,
      currentUserId,
      "owner",
      noCommitActors,
    );

    expect(reason).toBeUndefined();
  });

  test("requires at least one ignored bot comment or review", async () => {
    const result = await hasOnlyIgnoredActivities(
      [comment(currentUserId, "2026-08-04T00:01:00Z")],
      notificationUpdatedAt,
      noCommitActors,
    );

    expect(result).toBe(false);
  });

  test("ignores activity newer than the notification", async () => {
    const result = await hasOnlyIgnoredActivities(
      [review(aiReviewerId, "2026-08-04T00:04:00Z"), comment(humanId, "2026-08-04T00:06:00Z")],
      notificationUpdatedAt,
      noCommitActors,
    );

    expect(result).toBe(true);
  });

  test("retains activity when the notification timestamp is invalid", async () => {
    const result = await hasOnlyIgnoredActivities(
      [review(aiReviewerId, "2026-08-04T00:01:00Z")],
      "invalid",
      noCommitActors,
    );

    expect(result).toBe(false);
  });
});

describe("Cloudflare deployment notification suppression", () => {
  test("suppresses a Cloudflare Workers and Pages comment", async () => {
    const reason = await classifyActivities(
      [comment(cloudflareWorkersAndPagesBotId, "2026-08-04T00:01:00Z")],
      notificationUpdatedAt,
      currentUserId,
      "owner",
      noCommitActors,
    );

    expect(reason).toBe("cloudflare_deployment_comment");
  });

  test("allows current-user activity around a Cloudflare deployment comment", async () => {
    const reason = await classifyActivities(
      [
        comment(currentUserId, "2026-08-04T00:01:00Z"),
        comment(cloudflareWorkersAndPagesBotId, "2026-08-04T00:02:00Z"),
      ],
      notificationUpdatedAt,
      currentUserId,
      "owner",
      noCommitActors,
    );

    expect(reason).toBe("cloudflare_deployment_comment");
  });

  test("retains a later merge event", async () => {
    const reason = await classifyActivities(
      [
        comment(cloudflareWorkersAndPagesBotId, "2026-08-04T00:01:00Z"),
        {
          actor: { id: humanId },
          created_at: "2026-08-04T00:02:00Z",
          event: "merged",
        },
      ],
      notificationUpdatedAt,
      currentUserId,
      "owner",
      noCommitActors,
    );

    expect(reason).toBeUndefined();
  });

  test("retains another actor's comment", async () => {
    const reason = await classifyActivities(
      [
        comment(humanId, "2026-08-04T00:01:00Z"),
        comment(cloudflareWorkersAndPagesBotId, "2026-08-04T00:02:00Z"),
      ],
      notificationUpdatedAt,
      currentUserId,
      "owner",
      noCommitActors,
    );

    expect(reason).toBeUndefined();
  });
});

describe("jdx PR closer warning suppression", () => {
  const warningBody = `This PR currently has merge conflicts. If this continues for 7 days, it will be closed automatically.

<!-- pr-closer-warning
date: 2026-08-07
head_sha: abc123
-->`;
  const autoCloseBody = `This PR has had merge conflicts for more than 7 days, so it is being closed automatically.

*This comment was generated by an automated workflow.*`;

  const classifyJdxActivities = async (events: unknown[]): Promise<string | undefined> => {
    return await classifyActivities(
      events,
      notificationUpdatedAt,
      currentUserId,
      "jdx",
      noCommitActors,
    );
  };

  test("suppresses a marked warning from GitHub Actions", async () => {
    const reason = await classifyJdxActivities([
      comment(githubActionsBotId, "2026-08-04T00:01:00Z", undefined, warningBody),
    ]);

    expect(reason).toBe("pr_closer_warning");
  });

  test("prioritizes a PR closer warning over a bot review", async () => {
    const reason = await classifyJdxActivities([
      comment(aiReviewerId, "2026-08-04T00:01:00Z"),
      comment(githubActionsBotId, "2026-08-04T00:02:00Z", undefined, warningBody),
    ]);

    expect(reason).toBe("pr_closer_warning");
  });

  test("retains the same marked warning outside jdx", async () => {
    const reason = await classifyActivities(
      [comment(githubActionsBotId, "2026-08-04T00:01:00Z", undefined, warningBody)],
      notificationUpdatedAt,
      currentUserId,
      "risu729",
      noCommitActors,
    );

    expect(reason).toBeUndefined();
  });

  test("retains unmarked GitHub Actions comments", async () => {
    const reason = await classifyJdxActivities([
      comment(githubActionsBotId, "2026-08-04T00:01:00Z", undefined, autoCloseBody),
    ]);

    expect(reason).toBeUndefined();
  });

  test("retains the automatic closure after a warning", async () => {
    const reason = await classifyJdxActivities([
      comment(githubActionsBotId, "2026-08-04T00:01:00Z", undefined, warningBody),
      comment(githubActionsBotId, "2026-08-04T00:02:00Z", undefined, autoCloseBody),
      {
        actor: { id: githubActionsBotId },
        created_at: "2026-08-04T00:02:00Z",
        event: "closed",
      },
    ]);

    expect(reason).toBeUndefined();
  });

  test("retains a warning marker posted by another actor", async () => {
    const reason = await classifyJdxActivities([
      comment(humanId, "2026-08-04T00:01:00Z", undefined, warningBody),
    ]);

    expect(reason).toBeUndefined();
  });
});
