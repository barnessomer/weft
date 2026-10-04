# B11 evidence: B proposes an overload, A accepts, both land

Driver `node demo/b11-negotiation.mjs` (scenario: `demo/scenarios/b11-negotiation.md`), run
2026-10-04 with two live `claude -p` sessions against this branch's gateway + RepoCoordinator
DO under `wrangler dev --env test` (`http://127.0.0.1:8799`).

## Result: 5/5 valid runs PASS (run 1 aborted by a harness permission, not by Weft)

| run | proposal reached A | propose → accept | A's agreed edit | lands | B's signup call | A / B2 cost |
|---|---|---|---|---|---|---|
| 2 | redelivered at SessionStart (A resumed) | #10 → #13 | #12 | #20, #21 | `createSession(user.id)` | $0.81 / $0.33 |
| 3 | redelivered at SessionStart (A resumed) | #10 → #12 | #13 | #19, #20 | `createSession(user.id)` | $0.40 / $0.35 |
| 4 | redelivered at SessionStart (A resumed) | #10 → #13 | #12 | #18, #19 | `createSession(user.id)` | $0.49 / $0.34 |
| **5** | **live, injected at A's next PreToolUse:Edit** | #11 → #14 | #13 | #19, #20 | `createSession(user.id)` | $0.30 / $0.32 |
| 6 | redelivered at SessionStart (A resumed) | #14 → #17 | #16 | #22, #23 | `createSession(user.id)` | $0.52 / $0.34 |

In every run: B's stale call was denied at PreToolUse with `stale_assumption` caused by A's
signature change (#3); B chose the negotiate option; A accepted and added real TypeScript
overloads (`createSession(userId: string): Session;` + `createSession(userId, opts)`); both
branches merged with no conflict; `tsc` exit 0 and all tests green on `main` (see each run's
`landing.txt`).

Run 5 is the cleanest example of the full loop (`run-5/transcript.md`):

```text
#3   accepted edit              claude-a changed signature of createSession …
#9   rejected edit              Blocked: claude-b … src/api/account.ts   [stale_assumption ← #3]
#10  accepted edit              claude-a … added refreshSession            (A still working)
#11  accepted negotiate.propose claude-b → <A's change>: proposes overload on createSession
#13  accepted edit              claude-a changed signature of createSession, added DEFAULT_SESSION_OPTIONS
#14  accepted negotiate.accept  claude-a accepted #11
#16  accepted edit              claude-b … src/api/account.ts              (same call, now accepted)
#19  accepted land              claude-a landed …
#20  accepted land              claude-b landed …
```

What A's model saw, verbatim, in the middle of its own work (PreToolUse:Edit, 08:16:18):

```text
[weft negotiation] #11 claude-b (change If8a4…, task T-2) proposes to you: overload on src/auth/session.ts#createSession — "Please keep createSession(userId) (no options argument) working as an overload that uses the platform's default session lifetime. …". Answer it: accept #11 | reject #11 | counter #11 with other terms.
  ↳ Answer from the shell: `…/agent-a/.weft/bin/weft negotiate accept 11` | `… reject 11 "<why>"` | `… counter 11 <kind> "<terms>"`.
```

What B's shell printed when the reply came back (run 2):

```text
[weft] sent #10: claude-b → Iad88…: proposes overload on createSession
[weft negotiation] #13 claude-a (change Iad88…, task T-1) ACCEPTED #10. The agreement is binding and recorded in the log for both sides.
  ↳ claude-a agreed (#13, overload: "…" on src/auth/session.ts#createSession). Continue with your original plan; …
```

## Notes

- **run-1-aborted-permission**: B's `claude -p` ran `.weft/bin/weft negotiate …` with a relative
  path, which the driver's `--allowedTools` (absolute path only) did not allow ("This command
  requires approval"). B correctly refused to adapt, tried to negotiate, backed out its edit, and
  the stop gate held it 5 times with the open `stale_assumption` error. The driver now allows both
  path forms. Kept as evidence of the L3 gate and of the loser's behaviour without a channel.
- **Re-scored criterion (runs 2–4)**: those runs used the first version of the overload due,
  which only counted an owner edit made *after* the accept. In runs 2 and 4 A made the overload
  first and accepted second, so its stop gate refused once more (run 2: "agreement #13 obliges
  you …") and A edited `createSession` again. The rule now counts any accepted edit of the agreed
  keys after the proposal (spec §8.4; scenario `overload-before-accept`). `summary.json` has a
  `rescored` field; the coordinator logs are unchanged.
- Runs 2–4 and 6: A (~20–40 s) finished before B proposed, so the driver resumed A's conversation
  with a neutral prompt. A's new WCP session received the pending proposal in its SessionStart
  context (spec §8.2 redelivery); nothing in A's prompt named the request.

## Files per run

`transcript.md` (human-readable: full coordinator log, every Weft text injected into each model,
each model's tool calls and final answer, landing), `summary.json` (criteria, seqs, timings,
cost), `coordinator-log.json` (every record with diffs), `a-/b-hooks.jsonl` (per-hook timing and
injected text), `a-/b-adapter.log`, the harness transcripts (`*.jsonl` stream-json) and prompts,
`landing.txt` (commits with trailers, land records, merge graph, tsc/test output, final files).
