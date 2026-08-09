import { describe, expect, test } from "vitest";

import {
  getActivitySuppressionReason as classifyActivities,
  isOpenPullRequestByOtherAuthor,
  isReleasePullRequest,
} from "../src/triage";

const aiReviewerId = 136_622_811;
const currentUserId = 79_110_363;
const githubActionsBotId = 41_898_282;
const humanId = 1;
const lastReadAt = "2026-08-04T00:00:00Z";

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

const noCommitActors = async (): Promise<number[]> => [];
const hasOnlyIgnoredActivities = async (
  events: unknown[],
  lastReadAt: string | null,
  loadCommitActorIds: (sha: string) => Promise<number[] | undefined>,
): Promise<boolean> => {
  const reason = await classifyActivities(
    events,
    lastReadAt,
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
  ])("retains non-match %#", (pullRequest) => {
    expect(isOpenPullRequestByOtherAuthor(pullRequest)).toBe(false);
  });
});

describe("AI review notification suppression", () => {
  test("suppresses an AI-only comment after the thread was read", async () => {
    const result = await hasOnlyIgnoredActivities(
      [comment(aiReviewerId, "2026-08-04T00:01:00Z")],
      lastReadAt,
      noCommitActors,
    );

    expect(result).toBe(true);
  });

  test("ignores activity by risu729 around an AI review", async () => {
    const result = await hasOnlyIgnoredActivities(
      [
        comment(currentUserId, "2026-08-04T00:01:00Z"),
        review(aiReviewerId, "2026-08-04T00:02:00Z"),
      ],
      lastReadAt,
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
      lastReadAt,
      noCommitActors,
    );

    expect(result).toBe(true);
  });

  test("retains a cross-reference from an AI reviewer", async () => {
    const result = await hasOnlyIgnoredActivities(
      [
        {
          actor: { id: aiReviewerId },
          created_at: "2026-08-04T00:01:00Z",
          event: "cross-referenced",
        },
        review(aiReviewerId, "2026-08-04T00:02:00Z"),
      ],
      lastReadAt,
      noCommitActors,
    );

    expect(result).toBe(false);
  });

  test("retains a human comment immediately before an AI review", async () => {
    const result = await hasOnlyIgnoredActivities(
      [comment(humanId, "2026-08-04T00:01:00Z"), review(aiReviewerId, "2026-08-04T00:02:00Z")],
      lastReadAt,
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
      lastReadAt,
      noCommitActors,
    );

    expect(result).toBe(false);
  });

  test("retains a human event with the same timestamp as the read boundary", async () => {
    const result = await hasOnlyIgnoredActivities(
      [comment(humanId, lastReadAt), review(aiReviewerId, "2026-08-04T00:01:00Z")],
      lastReadAt,
      noCommitActors,
    );

    expect(result).toBe(false);
  });

  test("ignores human comments that were already read", async () => {
    const result = await hasOnlyIgnoredActivities(
      [comment(humanId, "2026-08-03T23:59:00Z"), review(aiReviewerId, "2026-08-04T00:01:00Z")],
      lastReadAt,
      noCommitActors,
    );

    expect(result).toBe(true);
  });

  test("allows a commit attributable to risu729", async () => {
    const result = await hasOnlyIgnoredActivities(
      [commit("2026-08-04T00:01:00Z"), review(aiReviewerId, "2026-08-04T00:02:00Z")],
      lastReadAt,
      async () => [currentUserId],
    );

    expect(result).toBe(true);
  });

  test("retains a commit not attributable to risu729", async () => {
    const result = await hasOnlyIgnoredActivities(
      [commit("2026-08-04T00:01:00Z"), review(aiReviewerId, "2026-08-04T00:02:00Z")],
      lastReadAt,
      async () => [humanId],
    );

    expect(result).toBe(false);
  });

  test("retains a commit that can no longer be fetched", async () => {
    const result = await hasOnlyIgnoredActivities(
      [commit("2026-08-04T00:01:00Z"), review(aiReviewerId, "2026-08-04T00:02:00Z")],
      lastReadAt,
      async () => undefined,
    );

    expect(result).toBe(false);
  });

  test("retains unknown activity", async () => {
    const result = await hasOnlyIgnoredActivities(
      [
        {
          actor: { id: currentUserId },
          created_at: "2026-08-04T00:01:00Z",
          event: "future-event",
        },
        review(aiReviewerId, "2026-08-04T00:02:00Z"),
      ],
      lastReadAt,
      noCommitActors,
    );

    expect(result).toBe(false);
  });

  test("requires at least one ignored AI comment or review", async () => {
    const result = await hasOnlyIgnoredActivities(
      [comment(currentUserId, "2026-08-04T00:01:00Z")],
      lastReadAt,
      noCommitActors,
    );

    expect(result).toBe(false);
  });

  test("checks the full timeline when a thread has never been read", async () => {
    const result = await hasOnlyIgnoredActivities(
      [review(aiReviewerId, "2026-08-04T00:01:00Z")],
      null,
      noCommitActors,
    );

    expect(result).toBe(true);
  });

  test("retains any human activity when a thread has never been read", async () => {
    const result = await hasOnlyIgnoredActivities(
      [comment(humanId, "2026-08-03T23:59:00Z"), review(aiReviewerId, "2026-08-04T00:01:00Z")],
      null,
      noCommitActors,
    );

    expect(result).toBe(false);
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
    return await classifyActivities(events, lastReadAt, currentUserId, "jdx", noCommitActors);
  };

  test("suppresses a marked warning from GitHub Actions", async () => {
    const reason = await classifyJdxActivities([
      comment(githubActionsBotId, "2026-08-04T00:01:00Z", undefined, warningBody),
    ]);

    expect(reason).toBe("pr_closer_warning");
  });

  test("prioritizes a PR closer warning over an AI review", async () => {
    const reason = await classifyJdxActivities([
      comment(aiReviewerId, "2026-08-04T00:01:00Z"),
      comment(githubActionsBotId, "2026-08-04T00:02:00Z", undefined, warningBody),
    ]);

    expect(reason).toBe("pr_closer_warning");
  });

  test("retains the same marked warning outside jdx", async () => {
    const reason = await classifyActivities(
      [comment(githubActionsBotId, "2026-08-04T00:01:00Z", undefined, warningBody)],
      lastReadAt,
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
