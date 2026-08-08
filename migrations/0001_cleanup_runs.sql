CREATE TABLE cleanup_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_checked_at TEXT,
  full_scan_requested INTEGER NOT NULL DEFAULT 0 CHECK (full_scan_requested IN (0, 1))
);

INSERT INTO cleanup_state (singleton) VALUES (1);

CREATE TABLE cleanup_runs (
  id TEXT PRIMARY KEY,
  scheduled_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failure')),
  full_scan INTEGER NOT NULL CHECK (full_scan IN (0, 1)),
  since TEXT,
  summary TEXT NOT NULL CHECK (json_valid(summary)),
  error TEXT
);

CREATE INDEX cleanup_runs_started_at ON cleanup_runs (started_at DESC);

CREATE TABLE cleanup_run_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES cleanup_runs(id) ON DELETE CASCADE,
  notification_id TEXT NOT NULL,
  subject_url TEXT NOT NULL,
  repository TEXT,
  pull_number INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('marked_done', 'retained', 'retry_pending')),
  reason TEXT NOT NULL,
  error_status INTEGER,
  error_message TEXT,
  error_method TEXT,
  error_url TEXT,
  github_request_id TEXT,
  retry_after TEXT,
  rate_limit_remaining TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, notification_id)
);

CREATE INDEX cleanup_run_notifications_run_id
  ON cleanup_run_notifications (run_id);

CREATE TABLE notification_retries (
  notification_id TEXT PRIMARY KEY,
  subject_url TEXT NOT NULL,
  notification_updated_at TEXT NOT NULL,
  last_read_at TEXT,
  unread INTEGER NOT NULL CHECK (unread IN (0, 1)),
  attempt_count INTEGER NOT NULL,
  next_retry_at TEXT NOT NULL,
  last_error_status INTEGER,
  last_error_message TEXT NOT NULL,
  last_error_method TEXT,
  last_error_url TEXT,
  github_request_id TEXT,
  retry_after TEXT,
  rate_limit_remaining TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX notification_retries_next_retry_at
  ON notification_retries (next_retry_at);
