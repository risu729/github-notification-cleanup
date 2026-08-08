import type { NotificationAudit, RetryNotification, TriageResult } from "./triage";

export type CleanupState = {
  fullScanRequested: boolean;
  lastCheckedAt: string | undefined;
};

type CleanupStateRow = {
  full_scan_requested: number;
  last_checked_at: string | null;
};

type RetryRow = {
  attempt_count: number;
  last_read_at: string | null;
  notification_id: string;
  notification_updated_at: string;
  subject_url: string;
  unread: number;
};

type RunRecord = TriageResult & {
  error: string | undefined;
  finishedAt: string;
  fullScan: boolean;
  runId: string;
  scheduledAt: string | undefined;
  since: string | undefined;
  status: "failure" | "partial" | "success";
};

const insertRunStatement = `
  INSERT INTO cleanup_runs (
    id,
    scheduled_at,
    started_at,
    finished_at,
    status,
    full_scan,
    since,
    summary,
    error
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const prepareRunInsert = (database: D1Database, run: RunRecord): D1PreparedStatement => {
  return database
    .prepare(insertRunStatement)
    .bind(
      run.runId,
      run.scheduledAt ?? null,
      run.startedAt,
      run.finishedAt,
      run.status,
      run.fullScan ? 1 : 0,
      run.since ?? null,
      JSON.stringify(run.summary),
      run.error ?? null,
    );
};

const prepareAuditInsert = (
  database: D1Database,
  runId: string,
  createdAt: string,
  audit: NotificationAudit,
): D1PreparedStatement => {
  return database
    .prepare(
      `
        INSERT INTO cleanup_run_notifications (
          run_id,
          notification_id,
          subject_url,
          repository,
          pull_number,
          outcome,
          reason,
          error_status,
          error_message,
          github_request_id,
          retry_after,
          rate_limit_remaining,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .bind(
      runId,
      audit.notification.id,
      audit.notification.subjectUrl,
      audit.repository ?? null,
      audit.pullNumber ?? null,
      audit.outcome,
      audit.reason,
      audit.error?.status ?? null,
      audit.error?.message ?? null,
      audit.error?.requestId ?? null,
      audit.error?.retryAfter ?? null,
      audit.error?.rateLimitRemaining ?? null,
      createdAt,
    );
};

const getNextRetryAt = (attemptCount: number, now: Date): string => {
  const delayMinutes = Math.min(10 * 2 ** (attemptCount - 1), 24 * 60);
  return new Date(now.getTime() + delayMinutes * 60_000).toISOString();
};

const prepareRetryUpdate = (
  database: D1Database,
  audit: NotificationAudit,
  now: Date,
): D1PreparedStatement => {
  if (audit.outcome !== "retry_pending" || audit.error === undefined) {
    return database
      .prepare("DELETE FROM notification_retries WHERE notification_id = ?")
      .bind(audit.notification.id);
  }

  const attemptCount = audit.notification.attemptCount + 1;
  const timestamp = now.toISOString();
  return database
    .prepare(
      `
        INSERT INTO notification_retries (
          notification_id,
          subject_url,
          notification_updated_at,
          last_read_at,
          unread,
          attempt_count,
          next_retry_at,
          last_error_status,
          last_error_message,
          github_request_id,
          retry_after,
          rate_limit_remaining,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (notification_id) DO UPDATE SET
          subject_url = excluded.subject_url,
          notification_updated_at = excluded.notification_updated_at,
          last_read_at = excluded.last_read_at,
          unread = excluded.unread,
          attempt_count = excluded.attempt_count,
          next_retry_at = excluded.next_retry_at,
          last_error_status = excluded.last_error_status,
          last_error_message = excluded.last_error_message,
          github_request_id = excluded.github_request_id,
          retry_after = excluded.retry_after,
          rate_limit_remaining = excluded.rate_limit_remaining,
          updated_at = excluded.updated_at
      `,
    )
    .bind(
      audit.notification.id,
      audit.notification.subjectUrl,
      audit.notification.updatedAt,
      audit.notification.lastReadAt,
      audit.notification.unread ? 1 : 0,
      attemptCount,
      getNextRetryAt(attemptCount, now),
      audit.error.status ?? null,
      audit.error.message,
      audit.error.requestId ?? null,
      audit.error.retryAfter ?? null,
      audit.error.rateLimitRemaining ?? null,
      timestamp,
      timestamp,
    );
};

export const loadCleanupState = async (database: D1Database): Promise<CleanupState> => {
  const row = await database
    .prepare("SELECT last_checked_at, full_scan_requested FROM cleanup_state WHERE singleton = 1")
    .first<CleanupStateRow>();
  if (row === null) {
    return { fullScanRequested: false, lastCheckedAt: undefined };
  }

  const lastCheckedAt = row.last_checked_at ?? undefined;
  if (lastCheckedAt !== undefined && !Number.isFinite(Date.parse(lastCheckedAt))) {
    console.warn({ event: "notification_state_invalid" });
    return { fullScanRequested: row.full_scan_requested === 1, lastCheckedAt: undefined };
  }
  return {
    fullScanRequested: row.full_scan_requested === 1,
    lastCheckedAt,
  };
};

export const loadPendingRetries = async (
  database: D1Database,
  now: string,
): Promise<RetryNotification[]> => {
  const { results } = await database
    .prepare(
      `
        SELECT
          notification_id,
          subject_url,
          notification_updated_at,
          last_read_at,
          unread,
          attempt_count
        FROM notification_retries
        WHERE next_retry_at <= ?
        ORDER BY next_retry_at
        LIMIT 100
      `,
    )
    .bind(now)
    .all<RetryRow>();

  return results.map((row) => ({
    attemptCount: row.attempt_count,
    id: row.notification_id,
    lastReadAt: row.last_read_at,
    subjectUrl: row.subject_url,
    unread: row.unread === 1,
    updatedAt: row.notification_updated_at,
  }));
};

export const recordCompletedRun = async (
  database: D1Database,
  run: Omit<RunRecord, "error" | "finishedAt" | "status">,
): Promise<void> => {
  const now = new Date();
  const finishedAt = now.toISOString();
  const status = run.summary.retryPending > 0 ? "partial" : "success";
  await database.batch([
    prepareRunInsert(database, {
      ...run,
      error: undefined,
      finishedAt,
      status,
    }),
    ...run.audits.flatMap((audit) => [
      prepareAuditInsert(database, run.runId, finishedAt, audit),
      prepareRetryUpdate(database, audit, now),
    ]),
    database
      .prepare(
        `
          INSERT INTO cleanup_state (singleton, last_checked_at, full_scan_requested)
          VALUES (1, ?, 0)
          ON CONFLICT (singleton) DO UPDATE SET
            last_checked_at = excluded.last_checked_at,
            full_scan_requested = 0
        `,
      )
      .bind(run.startedAt),
  ]);
};

export const recordFailedRun = async (
  database: D1Database,
  run: Omit<RunRecord, "finishedAt" | "status">,
): Promise<void> => {
  const now = new Date();
  const finishedAt = now.toISOString();
  await database.batch([
    prepareRunInsert(database, {
      ...run,
      finishedAt,
      status: "failure",
    }),
    ...run.audits.flatMap((audit) => [
      prepareAuditInsert(database, run.runId, finishedAt, audit),
      prepareRetryUpdate(database, audit, now),
    ]),
  ]);
};
