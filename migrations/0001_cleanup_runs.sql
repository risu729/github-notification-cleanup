CREATE TABLE cleanup_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_checked_at TEXT,
  force_check_all INTEGER NOT NULL DEFAULT 0 CHECK (force_check_all IN (0, 1))
);

INSERT INTO cleanup_state (singleton) VALUES (1);

CREATE TABLE cleanup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
  force_check_all INTEGER NOT NULL CHECK (force_check_all IN (0, 1)),
  since TEXT,
  summary TEXT NOT NULL CHECK (json_valid(summary)),
  error TEXT
);

CREATE INDEX cleanup_runs_started_at ON cleanup_runs (started_at DESC);
