ALTER TABLE cleanup_state RENAME COLUMN force_check_all TO full_scan_requested;
ALTER TABLE cleanup_runs RENAME COLUMN force_check_all TO full_scan;
