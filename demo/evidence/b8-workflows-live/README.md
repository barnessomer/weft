# B8 live run: the four workflows on `weft-demo` (preview)

`node apps/workflows/scripts/live.mjs` → `run.json` (tokens scrubbed). Final run: 176 s end to end,
2026-10-04, preview stack (gateway, weft-workflows-preview, weft-sandbox-preview, Artifacts
namespace `weft-preview`, D1 `weft-preview`, Queue `weft-artifacts-events-preview`, Workers AI via
AI Gateway).

What happened (all through real pushes, Artifacts events, the queue consumer and Workflows):

1. **Task A, 1 candidate** (`claude-a`: `apple: 1` → `apple: 5`). Push → checkpoint → ProcessRevision
   (`up_to_date`, `node --test` 2/2 in the sandbox) → `POST /changes/{id}/land` → LandChange:
   submit queue, CAS push to trunk, `land` #60 (op log), task landed.
2. **Task B, 3 candidates, risk high** (`POST /tasks/{t}/select {n:3, risk:"high"}` → BestOfN).
   Their forks predate A's landing, so every one is rebased onto the new trunk:
   - `codex-b` (`pear: 2` → `3`, the line next to A's): git conflicts on adjacent lines,
     **Mergiraf** merges it structurally; tests pass.
   - `cursor-b` (breaks `calcTotal`): rebases cleanly, **tests fail** (1/2) → ProcessRevision
     bounces it to the agent as a system `message` (#64) with the test output; ranked ineligible.
   - `claude-b` (rewrites the same value A changed: `apple: 1` → `apple: 1 * KG`, adds `KG`, kiwi):
     git and Mergiraf both conflict → **resolver agent** (Workers AI `@cf/qwen/qwen2.5-coder-32b-instruct`
     through AI Gateway, 3.9 s) produces `apple: 5 * KG` — both intents kept; tests pass; result on
     the fork's `refs/heads/weft/rebased`.
   - Ranking (`rank` evidence): codex-b 1080 (tests, Mergiraf, churn 2) > claude-b 1038 (tests,
     resolver, churn 8) > cursor-b ineligible. BestOfN waits (`waitForEvent("approve")`); a human
     `approve` action on codex-b → BestOfN → LandChange → `land` #66 (rebased onto A by Mergiraf).
3. **Undo A**: human `undo` of A's op → RevertOperation → revert commit on the moved trunk
   (`Weft-Reverts-Op:` trailer), `revert` #68 (`reverts_seq` 60), task A reopened, change `reverted`,
   agent told (#69). Trunk ends with `apple: 1, pear: 3` (A undone, B kept).

Earlier run (same script, before the prompt fix) found that the resolver without per-hunk
guidance answered with one side only (`apple: 1 * KG`, dropping A's price) and tests could not
catch it. Fixes: the prompt now spells out base → trunk / base → change for every hunk, a resolution
identical to either side fails closed (bounce), and BestOfN always asks a human before landing a
resolver-merged winner.
