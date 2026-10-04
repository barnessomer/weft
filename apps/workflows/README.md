# @weft/workflows: continuous sync, landing, revert, selection (B8)

Four Cloudflare Workflows (`weft-workflows[-preview]`). Their logic lives in `src/core` behind
small interfaces (`StepLike`, `Deps`), so the code that runs as a Workflow also runs under the
Node tests with a fake step, real git and real Mergiraf.

```
Artifacts push ─► Queue ─► gateway consumer ─► checkpoint (WCP) ─► ProcessRevision(change, sha)
                                                                     │ load + coalesce (newest head only)
                                                                     │ sandbox job: weft-job.mjs rebase
                                                                     │   git ─► Mergiraf ─► resolver agent (LLM via AI Gateway)
                                                                     │   tests on the rebased tree, push fork:weft/rebased
                                                                     │ evidence (D1): rebase, test
                                                                     │ conflict / failing tests ─► system `message` to the agent
                                                                     └ `candidate` event ─► BestOfN (if one is running)
POST /v1/repos/{r}/tasks/{t}/select ─► BestOfN: wait for N processed ─► rank ─► risk low: land top
                                         risk medium/high: waitForEvent("approve") ◄─ human `approve` action
POST /v1/repos/{r}/changes/{c}/land  ─► LandChange: submit queue (repo DO) ─► wait for turn
                                         sandbox job: weft-job.mjs land (final rebase + presubmit + CAS push)
                                         stale_trunk ─► retry (3×) │ `land` (op log, claims released, queue entry landed)
                                         D1: landings row, change + task landed, sibling candidates closed
human `undo` / POST /system/revert   ─► RevertOperation: op log ─► weft-job.mjs revert (git ─► Mergiraf, CAS push)
                                         `revert` record ─► task reopened + evidence (stack trace) ─► `message` to the agent
```

## Jobs (`apps/sandbox/image/weft-job.mjs`)

The git work runs in the sandbox (script harness, one container per job, `node
/opt/weft/weft-job.mjs '<spec>'`). The container holds no tokens: the workflow mints short-lived
trunk/fork tokens inside the start step (never step output) and passes them as run `remotes`;
the sandbox's Outbound entrypoint adds them per repository path. The job prints one
`{"weft_job": …}` line that the runner lifts into `result.json.outcome`.

| job | does | statuses |
|---|---|---|
| `rebase` | replay `merge-base(trunk, head)..head` onto trunk commit by commit: plain git, then Mergiraf as merge driver (`* merge=mergiraf`, diff3), then the resolver (`llm`: OpenAI-compatible endpoint, Workers AI through AI Gateway in the sandbox; `command`: any argv, e.g. a Claude Code session). Tests on the result; result pushed to `refs/heads/weft/rebased` of the fork | `up_to_date`, `clean`, `resolved`, `conflict`, `error` |
| `land` | same rebase onto the current trunk (or reuse `weft/rebased` when it sits exactly on today's trunk), presubmit, `git push --force-with-lease=refs/heads/main:<onto>` (fast-forward only) | `landed`, `stale_trunk`, `tests_failed`, `conflict`, `noop`, `rejected`, `error` |
| `revert` | `git revert` of every commit in `before..after` (newest first; Mergiraf layer on conflict), squashed into one commit with a `Weft-Reverts-Op:` trailer, CAS push; idempotent via that trailer | `reverted`, `stale_trunk`, `conflict`, `error` |

The resolver fails closed: leftover conflict markers, an empty or suspiciously short answer, or a
non-zero exit abort the replay and the conflict (with hunks) is bounced to the agent.

## Configuration (per repo, D1 `artifacts_repos.config`)

Set with `POST /v1/admin/artifacts/repos {repo, trunk, config}`:

```json
{ "tests": { "command": ["node", "--test"], "timeout_s": 300 },
  "resolver": { "kind": "llm", "model": "@cf/qwen/qwen2.5-coder-32b-instruct" },
  "layers": ["git", "mergiraf", "resolver"], "allow_hosts": ["registry.npmjs.org"],
  "instance": "standard-1", "job_timeout_s": 900 }
```

Risk tier per task (`tasks.risk`, set by `/select {risk}`): `low` lands the top-ranked candidate,
`medium`/`high` wait for a human `approve` (WCP `control approve`; the gateway forwards it to the
task's BestOfN as event `approve`, instance id `bestofn-<repo>-<task>`, same as `apps/web`).

Ranking: tests pass +1000 (failing = never eligible; no tests +500), rebase layer (none 120, git
100, Mergiraf 80, resolver 40), −churn/5 (max −200), −cost×20 (max −100); ties to the earlier
candidate. Every candidate gets a `rank` evidence row with its score and reasons.

## API

Gateway (system or human unless noted):
`POST /v1/repos/{repo}/changes/{change}/land {note?}` → 202 `{workflow}` ·
`POST /v1/repos/{repo}/tasks/{task}/select {n?, risk?, poll_s?, collect_timeout_s?, approval_timeout_s?}` → 202 ·
`POST /v1/repos/{repo}/system/revert {op_id|seq, reason, evidence?}` (system) → 202 ·
`POST /v1/repos/{repo}/actions` `approve` / `undo` now also drive BestOfN / RevertOperation.

Operator (this Worker, Bearer `WEFT_WORKFLOWS_TOKEN`): `POST /v1/workflows/{process|land|revert|best-of-n} {id?, params}`,
`GET /v1/workflows/{kind}/{id}`, `POST /v1/workflows/{kind}/{id}/events {type, payload}`.

## Develop / deploy / live

```sh
pnpm --filter @weft/workflows test         # Node: the four workflows end to end (real git + Mergiraf)
pnpm --filter @weft/sandbox test           # weft-job.mjs layers, land CAS race, revert, resolver
cd apps/workflows && unset CLOUDFLARE_API_TOKEN && pnpm exec wrangler deploy --env preview
node apps/workflows/scripts/live.mjs       # live: all four workflows on weft-demo (writes demo/evidence/b8-workflows-live/run.json)
```

Secrets (`wrangler secret put <NAME> --env preview`): `WEFT_SYSTEM_TOKEN` (gateway token, scopes
`system`+`observe`; value in `~/.config/weft/preview-workflows-system-token`) and
`WEFT_WORKFLOWS_TOKEN` (operator API; `~/.config/weft/preview-workflows-token`). Both mode 600.
