-- B10 evidence: previews, screenshots, review agent, risk classification.
--
-- Acceptance criteria the review agent scores each candidate against (JSON array of strings,
-- set by `POST /v1/repos/{repo}/tasks/{task}/candidates {acceptance: [...]}`). NULL = the
-- reviewer falls back to the task title + the candidate's commit subjects.
ALTER TABLE tasks ADD COLUMN acceptance TEXT;

-- Evidence lookups by kind (BestOfN reads the newest `review`/`risk` row per revision).
CREATE INDEX IF NOT EXISTS evidence_by_kind ON evidence (change_id, sha, kind);
