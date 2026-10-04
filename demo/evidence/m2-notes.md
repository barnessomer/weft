## How to read this

- Every run is the whole §8 scenario: the trunk is reseeded, then 18 live agents run (6 tasks × Claude
  Code `claude -p`, Codex `codex exec` and OpenCode `opencode run --attach`, model
  `opencode/big-pickle`), on one coordinator: the `weft-demo` RepoCoordinator DO behind
  `weft-gateway-preview`. After that come ProcessRevision evidence, BestOfN, LandChange and the
  B13 planted bug, all on the deployed preview stack.
- A run counts as PASS only when all seven beats pass. Nothing is retried inside a run.
- Run 1 was aborted. Concurrent `opencode serve` processes locked each other's SQLite store, and
  the analyzer was missing arrow-function signatures. Both were fixed before run 2.

## What broke and what was fixed

| run | what broke | fix (commit on wt/m2) |
|---|---|---|
| 1 | Concurrent `opencode serve` processes failed with "database is locked" | one `XDG_DATA_HOME` per OpenCode agent, seeded with the user's auth |
| 1 | Best-of-N alternatives of one task arbitrated against each other (`claim_wait`/`claim_wounded`, and `stale_assumption` on a sibling candidate's signature edit) | WCP §7.7 alternatives: candidates of one task never validate or arbitrate against each other in flight. A land releases its alternatives' claims. There is a conformance scenario for it |
| 2 | Agent names were reused across runs, so a run-2 proposal targeted a run-1 change | agent ids are run-unique (`claude-t1-r3`) |
| 2 | The driver's human Approve sent the wrong action shape (`400 /type required`) | sends `{type: action, action: approve, note}`, the same body the web UI sends |
| 2 | Pass criteria read `land.status === "complete"` (the workflow status, not the land outcome) | criteria read `landed`/`already_landed`. Run 2 was **rescored** from its saved coordinator log; no events changed (`run.json.rescored`) |
| 2 | The planted-bug beat died on an expired wrangler OAuth token (it lives about 1 h; a run takes 17–48 min) | the driver and `live.mjs` refresh with `wrangler whoami` and retry once on CF auth error 10000 |
| 3 | The evidence wait hung for 20 min on a candidate whose tests failed: ProcessRevision skips the review stage and the revision stays `processed` | the wait also ends on a failed `test` row |
| 3 | The planted-bug push was never delivered by Artifacts → Queues (revision "unseen"; no `artifact_events` row) | `live.mjs` now waits 45 s after creating a fork subscription before pushing (likely cause, below). The driver and `live.mjs` also replay the same `cf.artifacts.repo.pushed` envelope into `weft-artifacts-events-preview` if nothing arrives within 90 s. Each replay is recorded (`push_event_replayed` / `push_events_replayed`) |
| 3 | Run 3's auto-revert counts as FAIL | after the fix, the same beat was re-run on the same trunk: PASS (`run-3/auto-revert-retry.{json,log}`). It is evidence for the fix, not a rescore |

The Artifacts finding: fork pushes made minutes after the fork's subscription was created were
always delivered, at 2.6–5 s latency. The planted-bug fork is subscribed and pushed about 3 s
later, and that push was lost three times in a row, in run 3, a standalone retry, and run 4, which
needed the replay. Trunk pushes, on a long-lived subscription, were never lost. This points to a
settle time on new event subscriptions. That is a design note for B6, because agents that push
within seconds of `POST /candidates` would lose their first revision. Follow-up: the gateway
should reconcile it, by comparing the fork's head against its revisions on a timer.

## Honest gaps

- The human approval is scripted. The driver acts as John through the web UI's own action path
  (`POST /actions approve` with the web token). It picks the top-ranked eligible candidate, except
  for t1, where it picks the candidate that accepted t3's overload, because both tasks depend on
  that agreement. The UI button itself was not clicked in these runs. B9 verified it.
- BestOfN asked for a human on most tasks (risk medium/high from the classifier, or the review
  said "needs human"). Only t4/t5 (all runs) and t2 (run 4) auto-landed.
- Ranking ties are broken by candidate order, so Claude often wins a tie. That is not a quality
  signal.
- t2's Codex candidate was not denied in runs 2 and 4: its edits never went through the
  coordinator as stale. Whether that is because it read the new signature first or because of an
  adapter gap (for example `apply_patch` timing) was not investigated. The beat needs one t2 agent
  denied and rerouted, and every run had two or three.
- OpenCode (big-pickle) is the slowest harness. One OpenCode agent per run ran 10–15 min and set
  `all_agents_done`.
- Claude auth: the keychain login on this Mac is broken (see t_1b412791). Runs 3–5 passed
  `CLAUDE_CODE_OAUTH_TOKEN` from the Hermes credential pool to the launcher process only. It was
  never written to the repo or the logs. Run `claude setup-token` for a durable token.
