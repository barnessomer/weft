## What this changes

<!-- One behavior change. Link the issue: Fixes #… -->

## Defaults

- [ ] Default behavior is unchanged (including prompts, SessionStart text and diagnostics), and a test pins it.
- [ ] Or: this PR intentionally changes a default, and the title says so.

## Proof

**Failing on main** (test name and output):

```
paste here
```

**Before / after** (asciinema, VHS or video link, plus the exact commands to reproduce):

- Before:
- After:
- Commands:

## Spec

- [ ] No protocol, journal, diagnostic or agent-text change.
- [ ] Or: docs/protocol/wcp-v0.md updated (section: …). Journal replay stays deterministic.

## Security notes

<!-- New file reads/writes, network calls, env vars, config discovery, spawned processes,
     anything that lets one agent affect another's state. "None" is fine. -->

## Checklist

- [ ] `pnpm -r typecheck && pnpm -r test` passes
- [ ] I read CONTRIBUTING.md
