# Weft demo video — storyboard (R3a)

Shot list for `script.md`. Every shot has an exact, reproducible source. Clip files are produced
by the rig (`rig/README.md`) into `demo/video/clips/<kind>/<id>.mp4` (gitignored); the edit
order and slot lengths live in `rig/edl.json`, which `rig/assemble.mjs` reads.

Kinds and sources:

- **web**: Weft web UI at `https://weft-web-preview.elier.ai/<hash route>`, filmed by
  `rig/record-web.mjs` (Playwright video, 1920x1080, page zoom 1.25). Steps in `rig/shots/web.json`.
- **term**: recorded transcripts from `demo/evidence/…` replayed by `rig/play.mjs` and filmed
  by VHS (`rig/render-term.mjs`), or a live command (`exec`). Blocks in `rig/shots/term.json`.
  Every term shot opens with a banner saying which run/file it shows: nothing is re-enacted.
- **sim**: Hérmes iOS app, Changes feed, on the dedicated simulator "Weft Video iPhone 17 Pro"
  (`rig/record-sim.mjs`, `xcrun simctl io recordVideo`), live against
  `https://weft-gateway-preview.elier.ai`. Launch args in `rig/shots/sim.json`.
- **card**: slide rendered from `rig/shots/cards.json` by `rig/render-cards.mjs` (HTML → PNG
  → still clip), same palette as the web UI.

Sec = approximate on-screen time in the dry-run cut; shots are cut on narration cues
(`rig/edl.json`), so the authoritative per-shot timing is `out/timeline.json` after assembly.
Order within §09 in the cut: S09a → S09c → S09b.

Status column: **ok** = dry-run recorded and checked on current preview data (2026-10-04);
**R3** = needs a fresh run or a final asset at R3 (reason given).

| Shot | Sec | Kind | Exact source | What is on screen | Status |
|---|---|---|---|---|---|
| **00 · Cold open** |||||
| S00a | ~9 | web | `#/r/demo-m1-20261004-064201-r1/live`, hover `.row[data-seq="9"]` | M1 run 1 log: #9 BLOCKED with the red `createSession` squiggle; Squiggles panel | ok |
| S00b | 3.5 | card | cards.json `S00b` | Title: Weft — coordination at edit time | ok |
| **01 · The problem** |||||
| S01a | 20 | card | cards.json `S01a` | Merge time vs edit time, "merge cleanly — and do not compile" | ok (first cut; R3 may animate) |
| S01c | ~24 | web | `#/r/weft/live`, Replay 64× | Weft's own log replaying: many agents, many edits | R3 final (replay fix: the log now shows only what the replay has reached) |
| **02 · What Weft is** |||||
| S02a | ~35 | diagram | `rig/render-diagram.mjs` `S02a` | animated: agents → adapters → gateway → sequencer DO → ordered log → verdict back into Codex as a squiggle; steps fire on narration cue words | R3 final |
| S02b | ~23 | web | `#/r/demo-m1-20261004-064201-r1/live`, click `.row[data-seq="3"]` | Record drawer: intent, reads/writes with `sig`/`body` chips, diff | ok |
| **03 · The squiggle** |||||
| S03a | 16 | web | `#/r/demo-m1-20261004-064201-r1/live`, Replay 4×, hover #9 | #3 claude-a signature change → #9 REJECTED + squiggle → #10 accepted | ok |
| S03b | 14 | term | `demo/evidence/m1/run-1/b-hooks.jsonl` (PreToolUse `injected`, the deny) | What Codex saw: `[weft error] stale_assumption …` + Claude's quoted diff | ok |
| S03c | 11 | term | `demo/evidence/m1/run-1/b2-implement.jsonl` (agent messages) | "Weft caught a required session-options change…", accepted #10, final summary | ok |
| S03d | ~26 | term | `demo/evidence/m1/run-1/landing.txt` | B alone: `tsc exit 2`; main after both merges: `tsc exit 0`, 11 tests ✔ | ok |
| **04 · Negotiation** |||||
| S04a | ~15 | web | `#/r/demo-b11-20261004-144005-r6/live` (B11 run 6, deployed preview gateway), filter "negotiat", open #10 | `negotiate.propose` #10 → `accept` #20, proposal detail | R3 final |
| S04b | 12 | term | `demo/evidence/b11/run-5/transcript.md` (`[weft negotiation] #11 …`) | The proposal as injected into claude-a's next tool call | ok |
| S04c | ~13 | card | cards.json `S04c` | The two overload signatures; B's unchanged call | ok |
| **05 · Candidates and evidence** |||||
| S05a | 9 | web | `#/r/weft-demo/board` | Board columns, task cards with candidate counts | ok |
| S05b | 26 | web | `#/r/weft-demo/task/b10-mutjeffj`, scroll 420 | "Add kiwi to the pricing page": 2 candidates, Δ 0.14% vs 1.67%, review pass 100 vs fail 33 | **R3 — screenshots broken**: stored evidence URLs point at the old `*.workers.dev` previews host (no DNS now). Fix data first (follow-up card), else images render as broken alt text |
| S05c | ~18 | web | `#/r/weft-demo/ops` | Op log: land / revert, Undo | ok |
| **06 · Auto-revert in 43 s** |||||
| S06a | 12 | card | cards.json `S06a` (numbers from `b13-auto-revert-live/run.json`) | t+0 land, t+6 500s, t+15 revert started, t+43 healthy | ok |
| S06c | 10 | term | `demo/evidence/b13-auto-revert-live/run.json` (steps after the land) | The live run's own timeline: `GET /quote → 500` … `→ 200` | ok |
| S05c | 5 | web | (reused) `#/r/weft-demo/ops` | land op → reverted | ok |
| S06d | ~5 | web | `#/r/weft-demo/task/b13-mutj3m36`, scroll 600 | Task "Quote API: support ?unit=g": REVERTED, review fail, production evidence | R3 — same broken-screenshot data issue as S05b; scroll to the `production_tail_error` stack trace |
| **07 · Many harnesses** |||||
| S07b | ~30 | web | `#/r/weft-demo/live` filtered `-r5`, Replay 64× | M2 run 5: 18 live agents (Claude Code, Codex, OpenCode) on six tasks, warnings, evidence checkpoints | R3 final (replay now replays the filtered records) |
| S07c | ~19 | card | cards.json `S07c` | L0 observe · L1 inject · L2 block · L3 gate | ok |
| **08 · The editor disappears** |||||
| S08a | ~18 | sim | sim.json `S08a`: weft-demo + B11 run 6 + M1 run 1, kinds intent/edit/negotiate/land/revert/control | Changes feed, "Live · 4 repos" (observe-only token scoped to the shown repos) | R3 final |
| S08b | ~18 | sim | sim.json `S08b`: `-weft.openEvent demo-m1-20261004-064201-r1:9` | Event #9 detail: BLOCKED, "Weft stopped this edit before it was made", diagnostic with cause link | ok |
| S08c | — | sim | R3: `-weft.debugAction approve:<R3 demo repo>:<change>` | Approve sheet | R3 only: human actions append real records, never run against evidence repos |
| **09 · Built under Weft** |||||
| S09a | 12 | web | `#/r/weft/live`, "Squiggles only" | Weft's own log: `claim_wait` warnings between real kanban workers | ok |
| S09b | ~10 | sim | sim.json `S09b`: `-weft.openEvent weft:6` | the first collision on the phone: `claim_wait` on builtUnderWeft, caused by event #5 | R3 final |
| S09c | ~16 | card | cards.json `S09c` ← `demo/video/dogfood-stats.json` | Stat cards: events, edits, landings, waits | ok; refresh stats at R3 |
| **10 · An open standard** |||||
| S10a | 10 | card | cards.json `S10a` (quote from aaif.io Agent Plugins post) | The "hooks … not portable in 1.0" quote | ok |
| S10c | ~16 | term | live from the main checkout: `pnpm --filter @weft/protocol test` | protocol + conformance tests passing | R3 final |
| **11 · Cloudflare** |||||
| S11a | ~34 | diagram | `rig/render-diagram.mjs` `S11a` | Cloudflare architecture; each product lights up as it is named | R3 final |
| S11b | ~17 | card | cards.json `S11b` | End card: github.com/celador/weft · WCP · MIT · elier.ai | ok |

Screen-safety results of the dry run (OCR of every clip at 1 frame/s, `rig/screen-safety.mjs`):
0 hits across web/term/sim/cards. The DOM probe in `record-web.mjs` flagged `img src`/`a href`
attributes on S05b and S06d that still use the customer-named `*.workers.dev` host — not
visible on screen, but they are why the screenshots are broken (see status column).

Never on screen: `*.workers.dev` URLs, customer names, personal chats (the sim runs with a
dead chat gateway URL, so no chats load), tokens/keys (launch args and request headers only).
