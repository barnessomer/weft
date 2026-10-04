# @weft/sandbox — agents in Cloudflare Containers (B7)

One agent run = one Durable Object (`WeftSandbox`, named by run id) + one container. The
container image has git, node 24, Claude Code, Codex CLI, Mergiraf, pnpm and the WCP adapters;
the DO boots it, launches the in-container orchestrator, ships logs to R2 and reports the exit.
The container holds **no secrets**: the Worker's `Outbound` entrypoint adds credentials to the
sandbox's outbound requests.

```
POST /v1/runs ─► WeftSandbox DO (run id) ──alarm──► container.start (cold ≈ 0.3–0.5 s, standard-1)
                   │  secrets in DO storage          intercept all HTTP(S) ─► Outbound(props)
                   │                                  exec agent-run.mjs (detached, own pgid)
                   │                                    clone fork ─ git identity + trailers
                   │                                    inject task + AGENTS.md ─ install WCP adapter
                   │                                    claude | codex | script (headless)
                   │                                    push new commits ─ result.json
                   ├─ alarm every 2–5 s: new log bytes ─► R2 runs/<run>/<stream>/<seq>
                   └─ result.json ─► status succeeded|failed, R2 status.json, POST report.url
Outbound: AI Gateway `weft` (+ provider key / gateway token, forced cf-aig-metadata
          {run,task,change,agent,repo}; workers-ai via the AI binding) · this run's Artifacts fork
          (+ fork token) · Weft coordinator (agent token replaces the adapter placeholder) ·
          allow_hosts (GET/HEAD) · everything else 403
```

## API

Auth: `Authorization: Bearer $WEFT_RUNNER_TOKEN`. Worker-to-Worker: bind the `SandboxRunner`
entrypoint (`start(req)`, `status(run)`, `kill(run)`, `logs(run, stream)`).

| | |
|---|---|
| `POST /v1/runs` | RunRequest → `202 {run, status}` (`state: starting`; the alarm boots the container) |
| `GET /v1/runs/{run}` | status: `state` (starting/running/succeeded/failed/lost/killed), `warm`, `timings` (`cold_start_ms`, `agent_run.clone_ms`, …), `result` (`base`, `head`, `pushed`, `harness_exit`, harness `outcome` incl. Claude `total_cost_usd`), `logs` chunk counts |
| `GET /v1/runs/{run}/logs/{runner.log\|agent.stdout.log\|agent.stderr.log}` | concatenated R2 chunks (works while running) |
| `POST /v1/runs/{run}/kill` · `/poke` · `/destroy` | SIGTERM the process group · flush now · stop the container |
| `GET /v1/aig/logs/{id}` | AI Gateway log (metadata, tokens, cost) for a `cf-aig-log-id` |

RunRequest (`src/spec.ts`):

```jsonc
{
  "run": "cand-t12-1",                 // optional, [a-z0-9-]{1,63}; the DO name
  "repo": "weft-demo", "task": "t_12", "change": "I…40hex", "agent": "claude-a", "title": "…",
  "harness": "claude-code",            // | "codex" | "script" (command: string[])
  "model": "claude-sonnet-4-5", "max_turns": 40,
  "prompt": "task text", "agents_md": "extra repo rules",
  "fork": { "remote": "https://<acct>.artifacts.cloudflare.net/git/<ns>/<fork>.git", "branch": "main", "token": "art_v1_…" },
  "weft": { "url": "https://weft-gateway…", "repo": "weft-demo", "token": "<agent+observe token>", "mode": "enforce" },
  "trailers": { "Change-Id": "I…", "Task-Id": "t_12", "Agent-Id": "claude-a" },   // from the B6 candidate response
  "instance": "standard-1", "timeout_s": 3600, "push": true,
  "allow_hosts": ["registry.npmjs.org"], "report": { "url": "https://…/report" }
}
```

`fork.token` and `weft.token` are split off on arrival (`splitRequest`): they stay in the DO's
storage and the Outbound props; `spec.json` in the container never contains them, and status,
logs and R2 objects are redacted.

## In the container (`image/agent-run.mjs`)

1. `git clone --branch <branch> <fork>` (auth added by Outbound), `user.name/email = agent`.
2. Trailers: the Claude adapter's commit-msg hook (claude-code + weft) or a runner hook from `trailers`.
3. Context: `.weft/task.md`, `.weft/AGENTS.md`; for Claude a `CLAUDE.local.md` importing
   `@AGENTS.md`/`@.weft/AGENTS.md`; all git-excluded. The prompt itself carries task + rules.
4. `weft-adapter-claude install --change <Change-Id> …` with a placeholder token (Outbound swaps it).
5. Harness: `claude --print --output-format stream-json --verbose --dangerously-skip-permissions`
   (`ANTHROPIC_BASE_URL=<gateway>/anthropic`, `IS_SANDBOX=1`) or `codex exec --json
   --dangerously-bypass-approvals-and-sandbox` (provider `weft` → `<gateway>/openai`), run in
   its own process group with a timeout.
6. Push `HEAD:<branch>` if new commits → Artifacts `pushed` → WCP `checkpoint` (B6).
7. `result.json` (atomic) with state, outcome, base/head/pushed, timings.

## Develop / deploy

```sh
pnpm --filter @weft/sandbox test            # node: agent-run vs real git + RunController vs a local container
pnpm --filter @weft/sandbox typecheck
pnpm --filter @weft/sandbox image           # docker build (linux/amd64) of the agent image
cd apps/sandbox && unset CLOUDFLARE_API_TOKEN && pnpm deploy:preview   # Docker must run; stages adapters
node scripts/live.mjs e2e                   # live: fork → sandbox → model via AI Gateway → push → checkpoint
node scripts/live.mjs bench 5 standard-1    # cold/warm start numbers
node scripts/live.mjs claude                # real Claude Code + WCP adapter (needs a model credential)
```

Cold-start numbers and batching guidance: `docs/research/sandbox.md`.
