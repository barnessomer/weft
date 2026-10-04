# B11 negotiation on the deployed preview gateway (R3)

`demo/evidence/b11/` holds five valid runs against a local `wrangler dev` gateway. For the video
(shot S04a must show a real log in the web UI), the same driver was run once more against the
deployed preview stack on 2026-10-04:

```
WEFT_URL=https://weft-gateway-preview.elier.ai \
WEFT_ADMIN_TOKEN_FILE=~/.config/weft/preview-admin-token \
node demo/b11-negotiation.mjs --runs 1 --first 6 --out demo/evidence/b11-preview
```

Two live `claude -p` sessions (auth: `CLAUDE_CODE_OAUTH_TOKEN` in the launcher process only;
tokens never written here).

## Result: run 6 PASS (all 8 criteria) — 6/6 valid runs overall

Repo `demo-b11-20261004-144005-r6` (web UI: `#/r/demo-b11-20261004-144005-r6/live`).

| seq | record |
|---|---|
| #4 | claude-a changes `createSession`'s signature |
| #8 | claude-b's stale call **rejected** (`stale_assumption` ← #4) |
| #10 | `negotiate.propose` claude-b → claude-a: overload on `src/auth/session.ts#createSession` |
| #13 | claude-a's agreed edit (the overload) |
| #20 | `negotiate.accept` |
| #25, #26 | both changes land; `tsc` + tests green on main (`run-6/landing.txt`) |

The proposal reached claude-a **live**, injected at its next `PreToolUse:Edit` (A was still
running; no resume needed) — `run-6/transcript.md`, 14:40:49. Total wall time 1 min 43 s.
