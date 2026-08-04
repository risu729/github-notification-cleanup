import { describe, expect, test } from "bun:test";

import { hasOnlyIgnoredActivities as classifyActivities } from "./triage";

const aiReviewerId = 136_622_811;
const currentUserId = 79_110_363;
const humanId = 1;
const lastReadAt = "2026-08-04T00:00:00Z";

const comment = (actorId: number, createdAt: string, updatedAt = createdAt): unknown => ({
  actor: { id: actorId },
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
  return await classifyActivities(events, lastReadAt, currentUserId, loadCommitActorIds);
};

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
