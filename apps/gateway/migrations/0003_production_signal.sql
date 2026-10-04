-- B13 production-signal detector. `landings` remains the source of truth for what can
-- be reverted; these tables only retain the bounded error window and one trigger per land op.
CREATE TABLE production_errors (
  event_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  stack TEXT NOT NULL,
  script TEXT,
  status INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX production_errors_by_repo_time ON production_errors (repo, occurred_at);

CREATE TABLE production_reverts (
  land_op_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  triggered_at INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  sample_stack TEXT NOT NULL,
  workflow_id TEXT
);
