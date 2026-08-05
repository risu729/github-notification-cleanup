import type { TriageResult } from "./triage";

export type CleanupState = {
  forceCheckAll: boolean;
  lastCheckedAt: string | undefined;
};

type CleanupStateRow = {
  force_check_all: number;
  last_checked_at: string | null;
};

type RunRecord = TriageResult & {
  error: string | undefined;
  finishedAt: string;
  force: boolean;
  scheduledAt: string | undefined;
  since: string | undefined;
  status: "failure" | "success";
};

const insertRunStatement = `
  INSERT INTO cleanup_runs (
    scheduled_at,
    started_at,
    finished_at,
    status,
    force_check_all,
    since,
    summary,
    error
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

const prepareRunInsert = (database: D1Database, run: RunRecord): D1PreparedStatement => {
  return database
    .prepare(insertRunStatement)
    .bind(
      run.scheduledAt ?? null,
      run.startedAt,
      run.finishedAt,
      run.status,
      run.force ? 1 : 0,
      run.since ?? null,
      JSON.stringify(run.summary),
      run.error ?? null,
    );
};

export const loadCleanupState = async (database: D1Database): Promise<CleanupState> => {
  const row = await database
    .prepare("SELECT last_checked_at, force_check_all FROM cleanup_state WHERE singleton = 1")
    .first<CleanupStateRow>();
  if (row === null) {
    return { forceCheckAll: false, lastCheckedAt: undefined };
  }

  const lastCheckedAt = row.last_checked_at ?? undefined;
  if (lastCheckedAt !== undefined && !Number.isFinite(Date.parse(lastCheckedAt))) {
    console.warn(JSON.stringify({ event: "notification_state_invalid" }));
    return { forceCheckAll: row.force_check_all === 1, lastCheckedAt: undefined };
  }
  return {
    forceCheckAll: row.force_check_all === 1,
    lastCheckedAt,
  };
};

export const recordSuccessfulRun = async (
  database: D1Database,
  run: Omit<RunRecord, "error" | "finishedAt" | "status">,
): Promise<void> => {
  const finishedAt = new Date().toISOString();
  await database.batch([
    prepareRunInsert(database, {
      ...run,
      error: undefined,
      finishedAt,
      status: "success",
    }),
    database
      .prepare(
        `
          INSERT INTO cleanup_state (singleton, last_checked_at, force_check_all)
          VALUES (1, ?, 0)
          ON CONFLICT (singleton) DO UPDATE SET
            last_checked_at = excluded.last_checked_at,
            force_check_all = 0
        `,
      )
      .bind(run.startedAt),
  ]);
};

export const recordFailedRun = async (
  database: D1Database,
  run: Omit<RunRecord, "finishedAt" | "status">,
): Promise<void> => {
  await prepareRunInsert(database, {
    ...run,
    finishedAt: new Date().toISOString(),
    status: "failure",
  }).run();
};
