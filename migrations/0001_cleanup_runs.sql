CREATE TABLE cleanup_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_checked_at TEXT,
  full_scan_requested INTEGER NOT NULL DEFAULT 0 CHECK (full_scan_requested IN (0, 1))
);

INSERT INTO cleanup_state (singleton) VALUES (1);

CREATE TABLE cleanup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
  full_scan INTEGER NOT NULL CHECK (full_scan IN (0, 1)),
  since TEXT,
  summary TEXT NOT NULL CHECK (json_valid(summary)),
  error TEXT
);

CREATE INDEX cleanup_runs_started_at ON cleanup_runs (started_at DESC);
