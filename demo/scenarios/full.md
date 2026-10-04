# M2: the full demo (docs/design.md §8), end to end on deployed infrastructure

One command:

```sh
demo/run-full.sh --run 1          # writes demo/evidence/m2/run-1/
node demo/m2-report.mjs --write   # aggregates every run into demo/evidence/m2-report.md
```

Driver: `demo/m2-full.mjs`. Trunk seed: `demo/target-app` (auth/session service) +
`demo/m2-seed` (shop, storefront, `.weft/preview.json`, tsconfig) on the Artifacts trunk
`weft-preview/weft-demo`. That trunk is also the deployed Worker `weft-demo` (Workers Builds
redeploys every land/revert; `src/worker.ts` and `wrangler.jsonc` are kept by the seed).

## Cast

18 live agents: 6 tasks × 3 candidates, one Claude Code (`claude -p`), one Codex
(`codex exec`) and one OpenCode (`opencode run --attach` on `opencode serve`, model
`opencode/big-pickle`) per task. Each candidate is a real Artifacts fork created by
`POST /v1/repos/weft-demo/tasks/{task}/candidates` (fork, repo-scoped write token, Change-Id,
`pushed` subscription to the gateway queue). Each agent works in its own clone of its fork with
its harness's Weft adapter installed (`install --change <candidate Change-Id>`), so every edit
goes through one coordinator: the `weft-demo` RepoCoordinator DO behind
`weft-gateway-preview`.

| task | title | candidates | what the beat shows |
|---|---|---|---|
| t1 | Session expiry | claude-t1, codex-t1, opencode-t1 | changes `createSession(userId)` → `createSession(userId, opts)`. Three alternatives of one task never conflict with each other (WCP §7.7). Risk medium: a human approves. |
| t2 | Signup endpoint | claude-t2, codex-t2, opencode-t2 | read + plan first (base pinned before t1's change), implement after it: the stale call is denied at edit time with a `stale_assumption` squiggle that cites t1's event and quotes its diff; the agent reroutes to the new signature on its own. |
| t3 | Session refresh | claude-t3, codex-t3, opencode-t3 | same collision, but its product rule forbids adapting: `weft negotiate propose overload …` reaches the t1 agent as injected context (an idle t1 agent is resumed and gets it redelivered); t1 accepts and adds the overload; the stop gate holds it until it does. |
| t4 | Bulk discount | claude-t4, codex-t4, opencode-t4 | changes only `calcTotal` in `src/pricing.ts` |
| t5 | Free shipping over $50 | claude-t5, codex-t5, opencode-t5 | changes only `shippingFee`, the adjacent one-liner: plain git conflicts with t4, the landing rebase merges structurally (Mergiraf layer). |
| t6 | Kiwi on the pricing page | claude-t6, codex-t6, opencode-t6 | storefront change: per-candidate preview (served from Artifacts), Browser Rendering screenshots vs trunk + pixel diff, risk, review agent against the acceptance criteria. Risk medium: a human compares and approves one. |

Then the planted bug: `apps/production-signal/scripts/live.mjs prove` lands a change to
`src/worker.ts` that throws on `/quote`; Workers Builds deploys it; the Tail consumer counts
exceptions; the detector starts RevertOperation from the op log; the revert redeploys; the
task is reopened with the stack trace as evidence.

## Timeline (driver phases, all timed in run.json `marks`)

1. `seeded`: trunk reset to the M2 seed (one commit, CAS push).
2. `agents_ready`: 6 tasks with acceptance criteria, 18 forks/tokens/subscriptions, 18 clones
   with adapters installed.
3. t4/t5/t6 agents start straight away; t2/t3 agents read and plan (`planners_joined`).
4. t1 agents start; `t1_signature_accepted` = the first accepted signature edit.
5. t2/t3 implement in their resumed conversations (`t2_t3_done`); a negotiation watcher resumes
   an idle t1 agent when a proposal for it appears (`t1_done`).
6. Each agent's work is committed through its adapter's git hooks (Change-Id/Task-Id/Agent-Id
   trailers; the pre-commit gate refuses open errors) and pushed to its fork → Artifacts
   `pushed` → Queue → gateway → ProcessRevision (rebase onto trunk with git → Mergiraf →
   resolver, tests, preview, screenshots, risk, review) → `evidence_done`.
7. One BestOfN per task (`select`). Where risk or the review asks for a human, the driver acts as
   the human through the same human action the web UI's Approve button sends (gateway
   `POST /actions {action: approve}` with John's web token): it approves the top-ranked eligible
   candidate, and for t1 the candidate that accepted t3's overload (the agreement both tasks
   depend on). BestOfN → LandChange (submit queue, presubmit, CAS push) → `landed`.
8. `trunk_checked`: clone trunk, `tsc -p .` and `node --test`.
9. `auto_revert_done`: the planted-bug beat.

## Pass criteria (run.json `criteria`)

- `agents_live`: 18 agents ran at least one turn.
- `collision_squiggle_reroute`: a t2 agent was rejected with `stale_assumption` caused by a t1
  signature edit, the deny is in its transcript (hooks.jsonl), and it then had accepted edits.
- `structural_merge`: t4 and t5 both landed and one landing used the `mergiraf` layer.
- `negotiation_both_land`: a t3 → t1 overload proposal was accepted, t1's winner is the
  acceptor, t1 and t3 both landed, and the overload is on trunk.
- `comparison_and_human_approval`: ≥ 2 t6 candidates have screenshots, t6 landed with
  `approved_by` set.
- `trunk_green`: trunk typechecks and tests pass after all landings.
- `auto_revert`: `live.mjs prove` passed.

## Notes

- Alternatives (§7.7) were added for this scenario: before it, the three candidates of one
  task arbitrated against each other (`claim_wait`/`claim_wounded`) and raised
  `stale_assumption` on each other's signature edits, which made best-of-N with live agents on
  one coordinator incoherent.
- `WEFT_PIN_EDGE_IP` (see `demo/lib/pin-dns.cjs`) resolves `*.elier.ai` locally to a
  Cloudflare edge IP. It exists because the Weft custom domains had no public DNS records
  when M2 ran; it changes nothing for deployed Workers.
- Lost Artifacts `pushed` events: if a pushed revision has not reached the gateway 90 s after the
  push, the driver (and `live.mjs` for the planted bug) replays the same `cf.artifacts.repo.pushed`
  envelope into `weft-artifacts-events-preview`. Every replay is listed in run.json
  (`push_events_replayed`, `auto-revert.json` `push_event_replayed`). See m2-report.md for why.
- `node demo/m2-full.mjs --run N --rescore` recomputes a finished run's `criteria` from its saved
  run.json + coordinator-log.json (no network). Use it only when a criterion's code was wrong;
  the run's `rescored` field records before/after.
- `--resume` finishes a run whose driver died after the agents pushed (phases D–G).
- Claude auth: `claude auth status` must say logged in, or export `CLAUDE_CODE_OAUTH_TOKEN`
  (`claude setup-token`) for the launcher process.
- Runtime: 17–48 min per run (OpenCode/big-pickle is the long pole); cost is Claude usage for 6
  agents plus Workers AI/Browser Rendering pennies.
