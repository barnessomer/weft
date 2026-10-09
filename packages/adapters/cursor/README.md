# @weft/adapter-cursor — WCP adapter for Cursor CLI (`cursor-agent`) hooks (L3, documented)

Connects a Cursor checkout to a Weft coordinator (WCP v0.1) through Cursor's command hooks
(`.cursor/hooks.json`, https://cursor.com/docs/hooks). The hook command translates Cursor's
payloads onto the shared WCP core (`packages/adapters/claude-code/src`, via `host.ts`), so the
diagnostics are identical to the Claude Code and Codex adapters'.

```sh
WEFT_TOKEN=... node dist/weft-cursor.mjs install \
  --url http://localhost:8787 --repo my-repo \
  --agent cursor-d --task T-5 --title "..." [--priority 0] [--mode enforce|advise]
cursor-agent -p --trust --force "..."     # project hooks only run in a trusted workspace
```

`install` writes `.weft/cursor.json` + `.weft/token` (0600), merges our entries into
`.cursor/hooks.json` (foreign hooks kept; excluded from git because the paths are absolute),
the git `commit-msg`/`pre-commit` hooks and `.weft/bin/weft`.

## Hook mapping

| Cursor hook | core event | output | level |
|---|---|---|---|
| `sessionStart` | SessionStart (`hello`) | `additional_context` | L1 |
| `preToolUse` (edit-shaped tool) | PreToolUse check | `permission:"deny"` + `agent_message` (model) + `user_message`; always a valid `permission` (Cursor blocks on invalid output) | L2 |
| `preToolUse` `Shell` with `git commit` | PreToolUse Bash | deny while errors are open | commit_gate |
| `postToolUse` | PostToolUse commit / drain | `additional_context` (+ warnings an allowed pre-check produced) | L1 |
| `afterFileEdit` | PostToolUse, only for edits pre/postToolUse did not account for | (carried to the next injectable hook) | L0 |
| `stop` (`status:"completed"`) | Stop | `followup_message` → Cursor submits it as the next user message; `loop_limit: 5` | L3 |
| `sessionEnd` | SessionEnd (`bye`) | — | |

Cursor documents neither its built-in edit tools' names nor their argument schemas (the
generic payload is `tool_name` + `tool_input`). Edits are therefore detected by argument shape
(`old_string`/`new_string` → Edit, `edits[]` → MultiEdit, `content|contents|file_text` → Write,
any path + write-ish name → accounted after the fact). `afterFileEdit` is the safety net: it
fires for every agent edit, is deduplicated against what `postToolUse` already committed (hash
of the resulting text), and reconstructs the exact before-text by reverse-applying its edit
records.

Declared capabilities: `{level: 3, observe: sync, inject: immediate, deny_edit, refuse_stop, commit_gate: tool_interception}`.

## Verification status — documented, NOT live-verified

The adapter is covered by fixture tests built from the documented payloads (unit translation +
the real bundle against a local coordinator, `test/cursor.test.ts`). A live `cursor-agent` run
was attempted on 2026-10-04 with cursor-agent 2026.04.17 and failed before any hook fired:
the CLI's login had expired (`cursor-agent status` → "Not logged in"; `-p` → "Authentication
required"), and re-login needs a browser OAuth approval by the account owner. Until a live run
confirms that the CLI routes its edit tool through `preToolUse` with a derivable `tool_input`,
treat L2 as documented-only; `afterFileEdit` + the git pre-commit gate are the fallback.

To verify: `cursor-agent login`, then `node demo/b12-harnesses.mjs` with Cursor added as an
agent (or the probe recipe in `docs/research/hooks.md`).
