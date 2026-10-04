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
