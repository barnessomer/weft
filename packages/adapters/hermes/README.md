# @weft/adapter-hermes

WCP v0.1 adapter for [Hermes Agent](https://hermes-agent.nousresearch.com/docs): a Python plugin
that puts Hermes' tool calls on the Weft log and Weft's diagnostics back into the agent's run.
It is how Weft's own build (Hermes kanban workers on the `weft` board) is coordinated by Weft.

Declared capability: **L3** (`observe: sync`, `inject: immediate`, `deny_edit`, `refuse_stop`,
`commit_gate: tool_interception`).

## Hook mapping

| Hermes hook | Tool / condition | WCP |
|---|---|---|
| `pre_tool_call` | `write_file`, `patch` (replace mode) | analyze proposed before/after → `submit mode:"check"`; `reject` → `{"action":"block","message": verdict.context}` (L2) |
| `pre_tool_call` | `terminal` in scope | snapshot dirty files + HEAD; a `git commit` command first asks `gate commit` |
| `pre_tool_call` | `kanban_complete`, `kanban_request_review` | `gate stop`; refused → block with the rendered open errors (L3) |
| `post_tool_call` | any edit above, `patch` V4A mode, terminal-made changes | real before/after → `submit mode:"commit"` (diff, reads, writes); HEAD moved → `checkpoint {sha}` |
| `post_tool_call` | other tools, session open | `inbox.drain` at most every 20 s |
| `transform_tool_result` | queued verdict/inbox context | adds `weft_diagnostics` to the JSON tool result (or appends text) — L1 |
| `pre_verify` | session open | `gate stop`; refused → `{"action":"continue"}` (L3, bounded by `agent.max_verify_nudges`) |

Base and inbox (spec §5.2, §5.4): `base_seq` advances only to a `delivered_through` whose context
was actually passed to the model (block message or tool-result injection), and the inbox is acked
up to the ids injected. A `trunk` item with `requires_rebase` caps the base below the landing until
the worktree gets a new commit.

Identity: agent `hermes-<profile>` (one repo-scoped token per profile), change
`hermes-<profile>/<kanban task id>` (`adhoc-<session>` outside kanban), task title/priority read
from the kanban DB (`HERMES_KANBAN_DB`) and used as `intent` / `summary_hint`.

Keys: `.ts/.tsx/.js…` files go through `@weft/analyzer` (bundled to `analyze.mjs`, run as one
persistent `node … --serve` child per Hermes process) plus cross-file reads from relative imports
(`src/analyze-cli.ts#importReads`). Other files get a whole-file key `path#*`.

### Scope guard

The `default`, `backend` and `arq` profiles also work on other boards, so every hook is a no-op
unless the target path (or the terminal's `workdir`, else `HERMES_KANBAN_WORKSPACE`) is inside a
configured root. Defaults:

| root | key prefix |
|---|---|
| `~/github/weft` (incl. `.worktrees/*`; paths are worktree-relative, so all worktrees share keys) | — |
| `~/code/hermes-ios/.worktrees/weft-feed` | `ios/` |

`node_modules`, `.git`, `.wrangler`, `.turbo` are ignored. No session is opened until the first
in-scope tool call; completion gates only apply to processes that have one.

### Failure behaviour

Fail open: transport errors, timeouts (4 s HTTP, 6 s analyzer) and bugs let the tool run; they are
logged to `~/.cache/weft-hermes/<profile>.log`. (Hermes fails a *timed-out* `pre_tool_call` closed,
which is why everything is bounded well under `plugins.hook_callback_timeout`.) Expired sessions are
re-opened transparently (`410` → new `hello`); a daemon thread heartbeats while the session lives.

Escape hatches: `WEFT_HERMES_MODE=advise` (or `"mode": "advise"` in the config) never blocks — it
only injects. A completion refused for the same open errors twice is treated as a deliberate retreat
on the third attempt: the adapter submits a `release` for those keys (visible in the feed) and lets
it through, so a worker can never be wedged by an error it chose not to fix.

## Install / remove

```sh
python3 packages/adapters/hermes/scripts/install.py              # default, backend, arq
python3 packages/adapters/hermes/scripts/install.py --status
python3 packages/adapters/hermes/scripts/install.py --uninstall  # reverses everything below
```

Install (idempotent): builds `dist/analyze.mjs`; registers repo `weft` on the gateway
(`POST /v1/admin/repos`, admin token from `~/.config/weft/preview-admin-token`); issues one agent
token per profile (`POST /v1/admin/tokens`, agent `hermes-<profile>`); writes
`~/.config/weft/hermes-adapter.json` (mode 600: url, repo, roots, mode, per-profile token + id);
copies `plugin/weft/*` + `analyze.mjs` to `<profile home>/plugins/weft/` with an `INSTALLED.json`
manifest; runs `hermes [-p <profile>] plugins enable weft --no-allow-tool-override` (adds `weft` to
`plugins.enabled` in the profile's `config.yaml`).

Uninstall: `hermes plugins disable weft` per profile, deletes `<profile home>/plugins/weft/`,
revokes the profile's token (`DELETE /v1/admin/tokens/<id>`), removes it from the config file
(and the file when empty). Manual equivalent: `hermes [-p P] plugins disable weft && rm -rf
<home>/plugins/weft`, then `rm ~/.config/weft/hermes-adapter.json`.

Overrides: `WEFT_HERMES_CONFIG`, `WEFT_HERMES_URL`, `WEFT_HERMES_TOKEN`, `WEFT_HERMES_MODE`,
`WEFT_HERMES_CACHE`.

## Tests

```sh
pnpm --filter @weft/adapter-hermes test        # bundle + vitest (analyzer bridge) + python unittest (hooks, fake WCP)
python3 packages/adapters/hermes/scripts/verify_live.py   # two adapters vs the deployed gateway (throwaway smoke-hermes-* repo)
```

## Landing (PM merges → `land`)

Weft's build merges kanban branches with `git merge`, outside Weft. `scripts/weft_land.py` appends
the system `land` for each merged change so its claims are released and other cards get
`trunk_advanced`: run it after every merge into main (`--recent N` to catch up, `--dry-run` to
preview). Details, token and log: docs/runbook.md "PM landings → Weft land". Live check:
`scripts/verify_land_live.py`. B8's landing queue replaces it.
