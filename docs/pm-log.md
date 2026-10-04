# PM log

Append-only. One dated entry per heartbeat that changed something.

## 2026-10-03 22:40 — kickoff
- Board created (25 cards), PM heartbeat cron d0494c88d9dd hourly. Spikes S1–S3 + scaffold B1 running.
- John delegated all decisions. Resolved D0 with defaults; Gemini CLI unusable (free tier UNSUPPORTED_CLIENT) → Cursor CLI + OpenCode as live harnesses 3–4 (both authenticated). Video + submission made autonomous (R3, R4 t_49aadeb8). Repo pushed to github.com/celador/weft (private).

## 2026-10-03 22:30 — first landings
- Landed B1 scaffold, S1, S3, B3 analyzer to main; gate green on main (typecheck + tests; analyzer 13/13). Worktrees removed.
- Verified S1 blocker myself: OAuth has artifacts(write) scope but `/artifacts/namespaces` → 10004 and `containers list` → "requires the Workers Paid plan". Root cause = account on Workers Free. Decision: upgrade to Workers Paid ($5/mo, within $150 ceiling) — needs John (dash login, Chrome not signed in, 1Password locked). Mitigation: interface + local git fake (design.md updated, B6/B7/B8/B10 commented). Not on critical path until day 5.
- Spend estimate: $0 so far; +$5/mo pending.

## 2026-10-03 23:00 — scope add (John)
- I1: Hérmes iOS "Changes" feed of the combined change log (observer role added to P1/B2). B16: Hermes adapter so Weft coordinates its own build. Principle 9 "the editor disappears" added to design. Both gate M2.
- 2026-10-03 (Hermes, for John): Cloudflare account upgraded to Workers Paid ($5/mo, card on file). Verified: /artifacts/namespaces → success (0 namespaces), /containers/applications → success. S1 blocker cleared; real Artifacts/Containers usable now.

## 2026-10-03 23:25 — S2 landed
- S2 (arq) hit iteration budget 90/90, then re-dispatches bounced off the ChatGPT/Codex usage limit (resets 10-04 03:03; arq + backend share it). Worker output was complete but uncommitted → PM added a verified-vs-documented table, committed, landed; gate green. Claude Code L0–L3 verified live; Codex L0 verified, L1–L3 left to B5 to re-probe.
- Decision: no reassignment of Codex-profile cards — next ones (B4/B5) gate on B2 and quota resets before then. P1 (default/Claude) now ready and dispatched. Day 0 on track.

## 2026-10-04 00:25 — P1 + B2 landed
- Landed wt/b2 (contains P1 WCP v0.1 spec + protocol pkg, RepoCoordinator DO + gateway). Gate green on main (protocol 108, sequencer 41, gateway 44, analyzer 13). Preview gateway responds 200. Worktrees b2/p1 removed, pushed.
- B4/B5/B6 bouncing on Codex quota wall (resets 03:03). Decision: B4 (Claude Code adapter) + B6 (Artifacts) reassigned to default/Claude to keep the M1 critical path moving; B5 stays on Codex (needs it to probe). I1 hermes-ios landing deferred until I1b (editing the same worktree) finishes.
- Day 1: ahead of plan (sequencer done; M1 due 10-07).

## 2026-10-04 01:30 — B4, B6, B16 (+land script) landed
- Landed wt/b16-land (incl. B16 Hermes adapter), wt/b4 (Claude Code L3 adapter), wt/b6 (Artifacts forks/candidates/Change-Ids). design.md/runbook.md conflicts resolved by keeping all sections. Gate green on main (protocol 108, sequencer 42, gateway 53, artifacts 16, claude-code 10, hermes 6, analyzer 13). weft_land.py --recent 20 posted lands #97–#99; preview gateway 200. Worktrees removed, pushed.
- Codex quota wall (resets 03:03) bouncing B5/B7/B9/B14 every dispatch. Decision: B7 (gates B8, critical path) and B9 (M2 UI) → default/Claude; B5 stays (needs Codex to probe), B14 stays (first cut candidate).
- I1 not landed into hermes-ios main: it is stacked on pushed branch review/attribution (builds 25–31, 11 commits not on main, another session's work). Decision: pushed wt/weft-feed to origin; land after review/attribution reaches main rather than landing someone else's branch.
- Day 1: M1 waits only on B5 (Codex adapter) after quota reset. On track.

## 2026-10-04 02:35 — B7 + B9 landed
- Landed wt/b9 (web UI, preview 302→Access/key gate) and wt/b7 (sandbox runner; /v1/health 200). design.md/runbook.md conflicts resolved keeping both sections. Gate green on main (web 20, sandbox 23, gateway 53, protocol 108, sequencer 42, …). weft_land posted #207/#208. Worktrees removed, pushed.
- B5/B15 "stranded in ready" = Codex quota wall (rate_limited requeues, no failure count); resets 03:03 — no action. B8 (critical path) + B14 running.
- Open for later: AI Gateway `weft` not created (wrangler OAuth can't); preview uses `default` — acceptable for demo, not a blocker.
- Day 1: on track; M1 waits on B5 only.
