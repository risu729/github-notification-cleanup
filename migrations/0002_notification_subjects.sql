ALTER TABLE cleanup_run_notifications
  ADD COLUMN subject_type TEXT NOT NULL DEFAULT 'PullRequest';

ALTER TABLE cleanup_run_notifications
  ADD COLUMN subject_title TEXT NOT NULL DEFAULT '';

ALTER TABLE notification_retries
  ADD COLUMN subject_type TEXT NOT NULL DEFAULT 'PullRequest';

ALTER TABLE notification_retries
  ADD COLUMN subject_title TEXT NOT NULL DEFAULT '';

ALTER TABLE notification_retries
  ADD COLUMN repository TEXT;
