-- Weft cross-repo index (design §7: D1 for tasks/changes/evidence). The per-repo ordered
-- log stays in the RepoCoordinator Durable Object; D1 indexes what lives across repos and
-- outside the log: Artifacts trunks/forks, candidate changes, revisions (pushes), evidence.

-- Weft repo -> Artifacts trunk repository.
CREATE TABLE artifacts_repos (
  repo TEXT PRIMARY KEY,                 -- Weft repo (Registry / RepoCoordinator name)
  namespace TEXT NOT NULL,               -- Artifacts namespace
  trunk TEXT NOT NULL,                   -- Artifacts repo name holding trunk
  default_branch TEXT NOT NULL,
  remote TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (namespace, trunk)
);

-- Tasks (intent). Candidate count is a monotonic counter: candidate n gets fork weft-<repo>-<task>-<n>.
CREATE TABLE tasks (
  repo TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- open | landed | closed
  candidates INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, id)
);

-- Changes (candidates): stable Change-Id, one Artifacts fork each.
CREATE TABLE changes (
  id TEXT PRIMARY KEY,                   -- Change-Id (I + 40 hex)
  repo TEXT NOT NULL,
  task TEXT NOT NULL,
  n INTEGER NOT NULL,
  agent TEXT,
  namespace TEXT NOT NULL,
  fork TEXT NOT NULL,                    -- Artifacts repo name of the fork
  remote TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  base_sha TEXT,                         -- trunk sha the fork started from (first push's `before`)
  head_sha TEXT,                         -- latest pushed sha
  status TEXT NOT NULL DEFAULT 'open',   -- open | landed | abandoned
  subscription_id TEXT,                  -- Queues event subscription for this fork's `pushed`
  subscription_status TEXT NOT NULL,     -- active | pending | failed | deleted
  subscription_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (repo, task, n),
  UNIQUE (namespace, fork)
);
CREATE INDEX changes_by_task ON changes (repo, task);
CREATE INDEX changes_by_subscription ON changes (subscription_status);

-- Revisions: every observed push to a change's fork (WCP `checkpoint`).
CREATE TABLE revisions (
  change_id TEXT NOT NULL REFERENCES changes (id),
  sha TEXT NOT NULL,
  ref TEXT NOT NULL,
  before_sha TEXT NOT NULL,
  commits INTEGER NOT NULL,
  subject TEXT,
  trailer_change_id TEXT,                -- Change-Id trailer found on the head commit (if any)
  seq INTEGER,                           -- WCP log seq of the checkpoint event
  status TEXT NOT NULL DEFAULT 'recorded', -- recorded | queued | processing | processed | failed (B8)
  pushed_at TEXT,                        -- Artifacts eventTimestamp
  received_at INTEGER NOT NULL,
  PRIMARY KEY (change_id, sha)
);

-- Evidence per revision (tests, previews, screenshots, review verdicts, cost...). Written by B8+.
CREATE TABLE evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id TEXT NOT NULL REFERENCES changes (id),
  sha TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- test | preview | screenshot | review | cost | transcript | ...
  status TEXT NOT NULL,                  -- pending | pass | fail | info
  uri TEXT,
  data TEXT,                             -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX evidence_by_revision ON evidence (change_id, sha);

-- Artifacts event intake log + idempotency (redelivered/duplicate events share a key).
CREATE TABLE artifact_events (
  key TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  namespace TEXT,
  repo_name TEXT,
  status TEXT NOT NULL,                  -- received | recorded | trunk | unmatched | ignored | error
  change_id TEXT,
  seq INTEGER,
  event_ts TEXT,
  received_at INTEGER NOT NULL,
  latency_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX artifact_events_by_repo ON artifact_events (namespace, repo_name, received_at);
