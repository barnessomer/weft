# @weft/adapter-watcher — harness-agnostic L0 adapter (file watcher + git pre-commit gate)

For any agent or editor without hooks (or a human): watch a checkout and report every file
change to the Weft coordinator after the fact. Other agents' edit-time checks then see this
checkout's work in near real time, and this checkout's conflicts are reported to the human.

```sh
WEFT_TOKEN=... node dist/weft-watch.mjs install --url … --repo … --agent human-w --task T-4 --title "Health check"
node dist/weft-watch.mjs run [--debounce 400] [--tick 15000]   # until Ctrl-C
node dist/weft-watch.mjs scan                                  # one pass over the dirty tree vs HEAD
```

What it does:

- **observe** — `fs.watch` (recursive), debounced. Each changed file (tracked or untracked, not
  git-ignored, not in `.git/.weft/node_modules/dist/…`) is diffed against the watcher's last
  snapshot of it, analyzed (`@weft/analyzer`: reads/writes) and submitted as a `commit` edit.
- **tell the human** — verdicts, positioned diagnostics and inbox items are printed (the same
  rendering agents get), e.g. `[weft error] stale_assumption src/ops/health.ts:5:10: You use
  src/auth/session.ts#createSession, whose signature changed in #3 by claude-a …`.
- **gate commits** — git's own `pre-commit` hook refuses a commit while this checkout's WCP
  session has open errors; `commit-msg` adds Change-Id/Task-Id/Agent-Id trailers. A periodic
  tick drains the inbox and reports a `checkpoint` when HEAD moves.

What it cannot do (and does not claim): nothing reaches a model, nothing is blocked before it
is written, the agent's stop is not gated, and `git commit --no-verify` bypasses the gate.

Declared capabilities: `{level: 0, observe: "async", inject: false, deny_edit: false, refuse_stop: false, commit_gate: "native"}`
(`native` = git's own pre-commit hook, the only gate an unhooked agent has).

Verified live on the preview gateway as `human-w` in `demo/b12-harnesses.mjs`: a stale call
written to `src/ops/health.ts` after claude-a's signature change was reported (rejected,
`stale_assumption` caused by claude-a's event), the commit was refused by the pre-commit hook,
and after the fix the edit was accepted and the commit went through.
