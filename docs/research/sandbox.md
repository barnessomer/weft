# Research: agent sandboxes on Cloudflare Containers (B7)

Card t_7d4ddb47. Code: `apps/sandbox`. Live script: `apps/sandbox/scripts/live.mjs`.
All numbers below are from `weft-sandbox-preview` (account 2d659dee…, Workers Paid) on
2026-10-04, measured by the runner itself (Durable Object timestamps) unless noted.

## Verified facts

| Fact | Proof |
|---|---|
| Sandbox SDK 1.0 no longer owns the container: your DO calls `ctx.container.start/exec`; `@cloudflare/sandbox` only adds Files/S3Mount/DirectoryBackup. Weft uses the container API directly (exec only, no `sandbox-shim` needed). | https://developers.cloudflare.com/sandbox/reference/ ; `npm pack @cloudflare/sandbox@1.0.0` README |
| `scheduling_policy = "durable_object"` containers accept only `lite`, `standard-1..4` (or a custom vcpu/memory/disk object). `basic` → `Invalid container instance type.` | bench run `bench-mutcr2v7-basic-*` status.error |
| `max_instances` is rejected for DO-managed containers by wrangler 4.147. | `wrangler deploy --dry-run` error |
| `lite` does not boot this 1.17 GB image: no successful `exec` within 180 s (twice). Use `standard-1` (default) or larger. | bench runs `bench-mutcoafi-lite-0`, DO alarm wallTime ≈ 205 s |
| Outbound interception works as documented: with `enableInternet:false` + `interceptAllOutboundHttp` + `interceptOutboundHttps("*")` and `ctx.exports.Outbound({props})`, every request reaches our `WorkerEntrypoint` with per-run props; the container trusts the interception CA via `NODE_EXTRA_CA_CERTS/GIT_SSL_CAINFO/CURL_CA_BUNDLE/SSL_CERT_FILE`. | live e2e: `example.com -> 403`, `api.anthropic.com -> 403`, other gateway → 403, trunk (not this run's fork) → 403, fork clone/push 200, coordinator 200 with swapped token |
| git over Artifacts works with the token added by the Worker (`Authorization: Bearer <fork token>` on `<host>/git/<ns>/<repo>.git/*`), never present in the container. Clone of a 1-commit fork ≈ 1.1 s, push ≈ 0.5 s. | live e2e runner.log `cloned ms:1143`, `pushed ms:469` |
| A push from the sandbox becomes a WCP `checkpoint` through B6's pipeline (Artifacts `pushed` event → Queue → gateway consumer), attributed to the candidate's Change-Id. | live e2e: `WCP checkpoint #1 for 0fba2ee (change Iffe0bd4…, actor {"type":"system","id":"artifacts"})` |
| Model calls from the sandbox are logged by AI Gateway with the run's metadata `{run, task, change, agent, repo}` (5 = the gateway's limit), tokens and cost. The metadata is set by the Worker, so an agent cannot spoof attribution. `env.AI.aiGatewayLogId` + `env.AI.gateway(id).getLog(id)` read it back. | live e2e: log `01M42KZ6BBAZSTNGRPX92B3EFC`: `metadata:{run:"e2e-mutcdsrc",task:"t_sbxmutcdsrc",change:"Iffe0bd4…",agent:"kimi-sbx",repo:"weft-sbx-mutcdsrc"}, tokens_in:44, tokens_out:305, cost:0.00126` |
| Real Claude Code 2.1.289 runs headless in the sandbox with the WCP adapter: adapter install 81 ms, SessionStart hook said hello to the preview coordinator through the Outbound token swap (repo log: `#1 join claude-sbx I3db4dc98… (claude-code, L3)`, `#2 leave … session end`), model calls reached AI Gateway and got `401 authentication_failed` (no Anthropic credential configured); Claude retried 10× and the runner recorded `state: failed, outcome_error: true` after 182 s. stream-json events were visible in R2 while the run was live. | `node scripts/live.mjs claude` (run `e2e-mutcus3f`) |
| `getLog()` returns metadata/tokens/cost but empty `request`/`response` bodies; the full transcript is the harness's own JSON event stream, which the runner ships to R2 (`runs/<run>/agent.stdout.log/*`). | same log |
| A named gateway is NOT auto-created: requests to gateway `weft` fail with `2001: Please configure AI Gateway in the Cloudflare dashboard`; `default` is auto-created on the first authenticated (binding) request. Wrangler OAuth (scope `ai (write)`) gets `10000 Authentication error` on the AI Gateway API, so the gateway cannot be created from here. | REST + binding probes |
| `@cf/meta/llama-3.1-8b-instruct` is deprecated (5028); `@cf/moonshotai/kimi-k2.6` works through the binding with OpenAI-shaped chat completions. | live probe |
| `blockConcurrencyWhile` around a cold start can exceed its 30 s limit and reset the DO (first probe: HTTP 1101). The runner therefore accepts the run in the request (fast path) and boots the container from the DO alarm. | first probe; fixed design |

## Cold start (standard-1 / standard-2, `true` as the agent)

`cold_start_ms` = `container.start()` → first successful `exec(["true"])` (the container is
usable). `request_to_done_ms` = run accepted → completion observed (includes agent-run's own
node startup and the 2 s first alarm tick).

| instance | n | cold_start_ms (each) | median | warm reuse cold_start | request→done (median) |
|---|---|---|---|---|---|
| standard-1 | 5 | 424, 375, 265, 376, 293 | 375 | 0 (same DO, container still up) | 2.69 s |
| standard-2 | 5 | 279, 377, 374, 265, 340 | 340 | 0 | 2.60 s |

Plus, per real run (live e2e, standard-1): alarm hop request→`start()` ≈ 12–37 ms, readiness
391–456 ms, clone 1.1 s, push 0.5 s; Claude Code / Codex CLI start ~1 s each (`versions.sh`
total 2.1 s for both + mergiraf + node).

Caveats (assumptions, not measured): these are warm *hosts* (the image was already pre-fetched
to the location after `wrangler deploy`); a first start on a host that has never pulled the
1.17 GB image will be slower (image pull). Containers are billed while running (instance
seconds), so idle warm containers are not free.

## Batching implications (design input for B8 continuous sync)

1. **The agent's own sandbox is long-lived, so cold start is paid once per candidate, not per
   checkpoint.** ~0.4 s boot + ~1 s clone is noise next to an agent session (minutes). No pooling
   is needed for agent runs.
2. **ProcessRevision (rebase/merge/tests per checkpoint) should reuse one sandbox per change.**
   Name the DO by Change-Id (e.g. `proc-<change>`), keep the container up with
   `setInactivityTimeout` (we use 30 min) and a fetched clone, and run each revision as a new
   exec in the warm container: per-revision overhead drops from ~1.5 s (boot + clone) to an
   incremental `git fetch` (~0.5 s). Warm reuse measured `cold_start_ms = 0`.
3. **Coalesce checkpoints, don't queue them.** Agents push in bursts. A revision that arrives
   while the change's sandbox is still processing the previous one should replace (not append
   to) the pending work: process only the newest head per change. The DO is the natural
   single-flight lock (one run at a time per DO: the runner returns 409 while busy).
4. **Batch only where it buys correctness, not latency.** Because boot is sub-second, there is no
   reason to wait N seconds to batch several changes into one container. Land-queue presubmit
   can still batch (test `trunk+A+B` together, bisect on failure) to save *test time*, which
   dominates.
5. **Fan-out cap = cost, not speed.** 18 parallel agents = 18 standard-1 containers; the account
   limits and instance-seconds bill are the constraint. Destroy containers when a candidate
   lands or is abandoned (`POST /v1/runs/{run}/destroy`), and let the 30 min inactivity timeout
   reap the rest.
6. **Image size matters on new hosts only.** 1.17 GB (Codex 427 MB, Claude Code 235 MB,
   Mergiraf 79 MB). If cold starts on fresh hosts become visible, split into per-harness images
   (`images.claude`, `images.codex`, `images.merge`) — the DO picks the image per run.
7. **Snapshots** (`snapshotContainer` / `start({containerSnapshot})`) can carry a pre-cloned repo
   with installed dependencies for large repos; not needed for the demo repo (clone 1.1 s), not
   measured.

## Credentials model (implemented)

The container holds no secrets. `Outbound` (src/outbound.ts, pure policy in src/policy.ts):
AI Gateway `weft` only (provider key / gateway token added, `cf-aig-metadata` forced;
`workers-ai/*` served via the AI binding with gateway id + metadata), this run's fork only (fork
token added), the Weft coordinator (agent token replaces the adapter's placeholder), optional
read-only `allow_hosts`; everything else 403, plain HTTP 403. Secrets live in the run DO's
storage and in Worker secrets (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AI_GATEWAY_TOKEN`) or in
AI Gateway BYOK (Secrets Store).

## Open / needs John

- Create AI Gateway **`weft`** (dashboard → AI → AI Gateway → Create, name `weft`; optionally
  Authenticated + BYOK Anthropic/OpenAI keys) — or give an API token with AI Gateway Edit. Until
  then the preview runs with `--var AI_GATEWAY_ID:default` (the live proof above used `default`).
- A model credential for real Claude Code / Codex sessions in the sandbox: `wrangler secret put
  ANTHROPIC_API_KEY --env preview` (and/or `OPENAI_API_KEY`), or BYOK keys in the `weft` gateway +
  `AI_GATEWAY_TOKEN`. Workers AI models work today without any key.
