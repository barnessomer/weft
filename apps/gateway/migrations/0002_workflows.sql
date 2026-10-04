-- B8 workflows: continuous sync (ProcessRevision), landing (LandChange), revert (RevertOperation),
-- selection (BestOfN). The ordered log (land/revert/op log/submit queue) stays in the repo DO;
-- D1 indexes what the workflows produce across repos.

-- Per-repo workflow config (JSON): {"tests":{"command":[...]|"sh string","timeout_s":900},
--   "resolver":{"kind":"llm","model":"@cf/..."}|{"kind":"command","argv":[...]}|null,
--   "layers":["git","mergiraf","resolver"], "allow_hosts":["registry.npmjs.org"], "instance":"standard-1"}
ALTER TABLE artifacts_repos ADD COLUMN config TEXT;

-- Risk tier decides auto-land vs human approval in BestOfN: low = auto, medium|high = approval.
ALTER TABLE tasks ADD COLUMN risk TEXT NOT NULL DEFAULT 'low';

-- ProcessRevision results per pushed revision.
ALTER TABLE revisions ADD COLUMN onto_sha TEXT;      -- trunk sha the revision was rebased onto
ALTER TABLE revisions ADD COLUMN rebased_sha TEXT;   -- result (pushed to the fork's refs/heads/weft/rebased)
ALTER TABLE revisions ADD COLUMN layer TEXT;         -- none | git | mergiraf | resolver (deepest layer needed)
ALTER TABLE revisions ADD COLUMN workflow_id TEXT;   -- ProcessRevision instance id
ALTER TABLE revisions ADD COLUMN processed_at INTEGER;

-- Trunk operations performed by the workflows (mirrors the repo DO's `ops`, plus git before/after).
CREATE TABLE landings (
  op_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- land | revert
  change_id TEXT,
  task TEXT,
  before_sha TEXT NOT NULL,              -- trunk before (CAS expected value)
  after_sha TEXT NOT NULL,               -- trunk after
  seq INTEGER,                           -- WCP log seq of the land/revert record
  status TEXT NOT NULL,                  -- landed | reverted (land rows) | done (revert rows)
  layer TEXT,
  requested_by TEXT,
  workflow_id TEXT,
  reverts_op_id TEXT,                    -- revert rows: the land op they undo
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX landings_by_change ON landings (change_id);
CREATE INDEX landings_by_repo ON landings (repo, created_at);
