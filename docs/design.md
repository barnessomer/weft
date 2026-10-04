# Weft — design v0

Working name. "Weft" is the thread woven across the warp; here, the coordination layer
woven across many agents working one codebase. Protocol: **Weft Coordination Protocol (WCP)**.

Target: Cloudflare "build the next Git platform" competition (Artifacts + Workers).
Deadline 2026-10-14. Source: https://blog.cloudflare.com/next-git-platform-on-cloudflare/

## 1. Thesis

GitHub coordinates humans at merge time. Agents need coordination at **edit time**.

Every agent changes code through tool calls (Edit/Write/apply_patch/shell). Those calls are
the real unit of change. Weft streams every tool-call edit into one strictly-ordered log per
repo, validates each edit against everything that landed in the log since the agent's base
(optimistic concurrency, read/write sets at symbol granularity), and pushes the result back
into the agent's run as **diagnostics** — the multi-agent equivalent of an editor's red
squiggles. Conflicts get resolved while the code is being written, before any commit exists.

Above that sits a thin platform: tasks (intent) → candidate changes (stable Change-Ids) →
evidence (tests, previews, screenshots, transcripts) → selection → serialized landing on
trunk → automatic revert from the operation log. Artifacts holds every repo and fork.

The competition minimum ("multiple agents working on changes concurrently") is the core of
this design, not an add-on.

## 2. Principles

1. Trunk-based. One trunk per repo. Agents work on short-lived Artifacts forks that are
   continuously rebased; everything lands on trunk through one queue.
2. Stable change identity. Every commit carries trailers `Change-Id`, `Task-Id`, `Agent-Id`
   (installed by a commit-msg hook in every agent workspace). Evidence binds to Change-Id,
   not SHA.
3. One ordered log, one sequencer. Order is assigned by the sequencer (a Durable Object per
   repo), never by wall clocks. The DO is the elected leader; Cloudflare runs the election.
4. Validate, don't lock. Agents work freely; the sequencer validates each event's
   read/write sets against writes since its base sequence number.
5. Squiggles, not walls. Diagnostics are positioned, explained, and severity-graded.
   Errors block only on committed facts or firm claims; in-flight work produces warnings.
6. Asymmetric arbitration. On conflict exactly one party gets the error (log order, then
   priority via wait-die / wound-wait). No mutual retreat, no livelock.
7. Everything is an event. Edits, claims, negotiation messages, landings, reverts. The
   log is replayable and every diagnostic cites the event that caused it.
8. Harness-neutral. WCP is a wire protocol; each harness gets a thin adapter over its
   native hooks. Claude Code first, Codex second, then Gemini CLI / Cursor / Copilot.
9. The editor disappears. Agents change code with no human watching an editor. The
   human surface is a FEED — intent, edits, squiggles, negotiations, landings, reverts —
   readable on any device (first client: the Hérmes iOS app), with editor-free controls:
   approve, undo, pause, message an agent. WCP has a read-only observer role and a
   human-action scope for this. Every event carries a one-line human summary.
10. Dogfood. Weft's own build is coordinated by Weft (Hermes adapter on the build's
   kanban workers), and its change log is watched from the phone.

## 3. Core objects

- **Task**: kanban card. goal, acceptance criteria, risk tier, predicted scope (symbols),
  candidate count N, status, parent.
- **Change**: one agent's attempt at a task. Stable Change-Id, Artifacts fork, list of
  revisions (git SHAs). A task can have N competing changes (candidates).
- **Event** (WCP): `{seq, repo, agent, task, change, base_seq, kind, files, reads[], writes[],
  diff?, intent?, ts}`. kinds: `intent`, `edit`, `checkpoint` (push), `claim`, `release`,
  `negotiate.*`, `land`, `revert`.
- **Claim**: predicted (from planner) or actual (from edits) writes, with TTL.
- **Diagnostic**: `{severity: info|warning|error, file, range?, symbol, message,
  caused_by_seq, caused_by_agent, caused_by_task, suggestion}`.
- **Evidence**: per revision — test results, preview URL, screenshots, review verdict,
  cost, transcript pointer.
- **Operation**: append-only op log entry with refs before/after; undo = new op (revert
  commit on trunk, ref rewind elsewhere).

## 4. Validation rules (sequencer)

For incoming event E with base `b`, let W = writes of all accepted events with seq > b.

1. `E.writes ∩ W ≠ ∅` and the overlapping writer is committed/landed → **error** (stale
   overwrite). If the overlapping writer is in-flight → **warning** + arbitration.
2. `E.reads ∩ W ≠ ∅` where W changed a signature/exported contract → **error** (stale
   assumption: you call something that changed). Body-only changes → **warning**.
3. Else accept, assign seq, broadcast to agents whose reads/writes/claims intersect.

Symbol keys: `path#qualified.name` (e.g. `src/auth/session.ts#refreshToken`). Reads =
referenced symbols (calls, imports, types). Writes = symbols whose span the diff touches;
signature-vs-body distinguished. TypeScript only for v0 (TS compiler API / tree-sitter).

Arbitration: earlier seq keeps the area by default. Higher-priority task may wound a
younger one (wound-wait). The losing agent may: retreat (rework), wait (until the other
lands), or negotiate (`negotiate.propose` to the owner, e.g. "keep old signature as
overload"), or escalate to coordinator (merge tasks).

## 5. Injection points (per harness)

| Need | Claude Code | Codex | Others |
|---|---|---|---|
| pre-edit allow/warn/deny | PreToolUse (deny + reason) | PreToolUse (beta) | verify (S2) |
| post-edit ship diff + inbox drain | PostToolUse (additionalContext) | PostToolUse | verify |
| refuse to finish while errors open | Stop hook | SessionStop? verify | verify |
| last gate | git pre-commit | git pre-commit | git pre-commit |

Capability levels in WCP: L0 observe (file watcher), L1 inject (context back to model),
L2 block (pre-edit deny), L3 gate (stop/commit refusal). Adapters declare their level.

## 6. Platform layer

1. Intake: task created → planner predicts scope → predicted claims → overlap triage.
2. Dispatch: fork trunk in Artifacts per candidate, repo-scoped token, sandbox with
   agent + adapter + hooks, AGENTS.md + task context.
3. Continuous sync on every checkpoint push (Artifacts event → Queue → Workflow):
   rebase onto trunk (git → Mergiraf structural merge → resolver agent → back to agent),
   tests, preview deploy, screenshot, review agent → evidence.
4. Selection: candidates ranked (tests, review, diff size, visual diff, cost). Risk tier
   decides auto-land vs human approval (Workflows waitForEvent).
5. Landing: submit queue in the repo DO; final rebase + presubmit; trunk advance is
   compare-and-swap (non-fast-forward push rejected). Op logged, claims released.
6. Post-land: Workers Builds deploys trunk; Tail Worker errors → Analytics Engine; spike
   after landing → revert op, task reopened with stack trace as evidence.

## 7. Cloudflare mapping (every product load-bearing)

Core: Artifacts, Workers, Durable Objects (SQLite), Agents SDK, Workflows, Queues,
Sandbox SDK/Containers, Workers Builds + Previews.
Strong: AI Gateway (all model calls tagged with task/change → cost + transcripts),
Workers AI (embeddings, risk classification), Vectorize (code/task index), D1 (cross-repo
tasks/changes/evidence), R2 (transcripts, logs, screenshots, op archives), Browser
Rendering (preview screenshots, visual diff), Tail Workers + Observability (auto-revert
signal), Analytics Engine (landing/conflict/agent metrics), Access (humans + service
tokens), Workers for Platforms / dynamic Workers (per-repo policies as code).
Garnish: Secrets Store, Cron Triggers + DO alarms, KV (policy/config cache), Email
Routing/Workers (task by email, approvals), Pipelines + R2 Data Catalog (op log
analytics), Web Search API via AI Gateway.
Skip unless a real use appears: Hyperdrive, Images, Stream, Realtime, Turnstile.

## 8. Demo (5–10 min video)

1. Board with 6 tasks × 3 candidates = 18 real agents (Claude Code + Codex + Gemini).
2. Two tasks collide on one function: agent B gets a live squiggle at its call site
   because agent A changed the signature; B reroutes on its own. Shown in the agent
   transcript and on the board.
3. Same-file, different-function edits land cleanly where plain git would conflict.
4. Negotiation: B proposes an overload; A accepts; both land.
5. Candidate comparison with preview screenshots + evidence; human approves one.
6. Planted bug lands → production error spike → auto-revert from the op log → card
   reopened with the stack trace.
7. Close: WCP as an open spec; adapters for N harnesses; proposal to AAIF (Agent Plugins
   1.0 explicitly left hooks unstandardized).

## 9. Open questions (spikes)

- S1 Artifacts: can a Worker binding create commits / move refs, or must landing push
  from a sandbox? Event payload shapes, limits, Workers Builds wiring, Workers Paid plan.
- S2 Hooks: exact block/inject/stop semantics per harness.
- S3 Analyzer: precision of TS symbol read/write extraction; Mergiraf in a container.
- Sandbox cold-start → batching policy for continuous sync.

## 10. Repo layout (target)

```
packages/protocol     WCP types, JSON schema, spec conformance tests
packages/analyzer     TS read/write-set extraction (diff → symbols)
packages/sequencer    RepoCoordinator DO (log, validation, claims, queue, ws)
packages/adapters/*   claude-code, codex, gemini, cursor, watcher (L0)
apps/gateway          Worker: API, MCP endpoint, Artifacts events, dashboard
apps/workflows        ProcessRevision, LandChange, RevertOperation, BestOfN
apps/sandbox          agent/test/merge container images
apps/web              board, candidates, evidence UI
demo/                 demo target repo + scripted scenario
docs/                 design, protocol spec, research, runbook
```

## Update 2026-10-03 (PM, from S1)
- Artifacts binding is read-only for git objects (create/fork/info/readFile/createToken); landing = `git push` with a short-lived write token from a trusted git client (sandbox). No binding-level ref CAS: rely on push semantics.
- Per-fork Workers Builds previews have no documented API; previews use one preconfigured repo with candidate branches.
- Account is on Workers Free → Artifacts/Containers return access denied until upgraded to Workers Paid. All Artifacts/sandbox code sits behind ArtifactsLike/SandboxLike interfaces with a local git-backed fake.

## Update 2026-10-03 (P1, protocol spec)
WCP v0.1 is specified in `docs/protocol/wcp-v0.md` (normative; implemented by `packages/protocol`). Refinements to §3–§5 (details: spec Appendix B):
- Rejected events are logged (seq, `status: rejected`) without effects, so conflicts show in the feed and can be cited.
- Pre-edit validation is a side-effect-free `check` submission (L2); the post-edit `commit` enters the log.
- `base_seq` may not exceed what the coordinator delivered to the session; landings count toward base only after the agent rebased.
- In-flight overlaps are arbitrated through claims (every accepted edit is a soft claim); §4 rule 1 errors only on committed (landed/reverted) writers. §4 rule 2 stays literal (signature change ⇒ error).
- Seniority = task priority, then first-accepted-event seq; wound-wait default, wait-die per repo.
- Added kinds `message`, `control`, `join`/`leave`, `negotiate.counter`; observer + human API per §9 of the spec.

## Update 2026-10-03 (B2, sequencer)
- `RepoCoordinator` (one DO per repo, SQLite) runs `SqlCoordinator`, a table-backed port of the protocol reference; differential tests require identical output to the reference on every conformance step.
- Every state change goes through an **input journal** (`journal` table: op, args, clock). Replaying it into an empty DO reproduces the log and all state byte-for-byte; one operation runs at one frozen instant (found by the replay test: the local runtime clock advanced mid-call).
- Tokens/repos live in a `Registry` DO, issued via `/v1/admin` (operator secret). Observer views redact secrets in `diff`/`intent` (spec §13); the log keeps originals.
- Not yet: `/v1/feed/stream` (spec SHOULD), rate limiting of `check` (SHOULD), Access-gated human tokens (SHOULD). Preview Worker is `weft-gateway-preview` (runbook's preview env); the bare `weft-gateway` name is left for the PM's production deploy.

## Update 2026-10-04 (B16, Hermes adapter + dogfood)
- `packages/adapters/hermes`: a Python Hermes plugin at L3. `pre_tool_call` runs a `check` on
  `write_file`/`patch` and blocks with `verdict.context`. `post_tool_call` sends a `commit`,
  including edits made through the terminal, which are diffed against a snapshot of dirty
  files taken before the command; a HEAD move becomes a `checkpoint`. `transform_tool_result`
  adds `weft_diagnostics` to the tool result. `kanban_complete`/`kanban_request_review` and
  `pre_verify` go through `gate stop`, and a terminal `git commit` goes through `gate commit`.
  Symbol keys come from `@weft/analyzer`, bundled to one `analyze.mjs` that runs as a
  persistent node child, plus cross-file reads from relative imports. Non-TS files get a
  whole-file key `path#*`.
- Scope guard: hooks do nothing outside `~/github/weft` (incl. `.worktrees/*`, so all
  worktrees share repo-relative keys) and `~/code/hermes-ios/.worktrees/weft-feed` (key prefix
  `ios/`). Installed on profiles default/backend/arq, connected to the preview gateway, repo
  `weft`. Agent ids are `hermes-<profile>` (one repo-scoped token per profile) and change ids
  are `hermes-<profile>/<kanban task id>`, so concurrent cards on one profile still arbitrate
  as separate changes.
- Dogfood is live: real kanban workers produced the first collision, and the PM cron's own
  checkpoints are in the same log (`demo/beats/built-under-weft.md`).
- Design gap (proposal): Weft's build lands by `git merge` in the PM, outside Weft. Nothing
  appends `land`, so soft claims of finished cards linger until TTL (30 min) and later cards
  get `claim_wait` against work that is already on main. Proposal: the PM's merge step posts a
  system `land {sha, op_id}` per merged change (system token). That releases its claims and
  sends `trunk_advanced` to everyone affected. B8's landing queue should own this; until then
  a small PM script can do it.
- Done (t_4ea09be8): `packages/adapters/hermes/scripts/weft_land.py`, run by the PM after each
  `git merge` (weft-pm skill, docs/runbook.md). It maps the merged branch to kanban task ids
  (kanban DB, branch name, `[t_…]` commit tags), finds their changes via `GET /events?task=`, and
  posts `land {sha, op_id = uuid5(repo/change/sha)}` with `base_seq` = head for every change with
  edits after its last land; R1 rejections are retried on a fresh head. When B8 lands, the queue
  takes this over: the PM enqueues instead of merging, and the script goes away.
- Adapter fix found by the live landing check: a rebase checkpoint's verdict repeats the still
  unacked `trunk` item, which re-set the adapter's rebase floor right after the commit cleared
  it, so a rebased agent's next edit of a landed symbol was blocked with `stale_overwrite`. The
  floor is now cleared after the verdict is queued.
- Adapter escape hatches, so a dogfood worker can't get wedged: `WEFT_HERMES_MODE=advise`
  (inject only, never block). A completion refused twice for the same open errors is treated
  as a deliberate retreat on the third try: the adapter appends a `release` for those keys,
  which is visible in the feed.

## Update 2026-10-04 (B4, Claude Code adapter)
- `packages/adapters/claude-code` is the first L3 adapter, proven with two real `claude -p` sessions against the preview gateway (`demo/evidence/README.md`): B's stale call is denied at PreToolUse with a positioned `stale_assumption` squiggle, B reroutes, and the merged result typechecks; with B told to give up, the Stop gate refuses 5× and the git pre-commit gate refuses the commit.
- Pre-edit validation uses `submit mode:"check"` (spec §5.3), not an `intent` event: `intent` is never validated (§4.2).
- **The squiggle must carry the other side's code.** In-flight edits live in the other agent's fork, so "read the new signature" is impossible from the receiver's checkout. The adapter fetches the causing event (`GET /events/{seq}`; agent tokens get `observe` scope) and quotes its hunks. Proposal: the coordinator could attach the relevant hunk to `stale_assumption`/`contract_changed` diagnostics itself (spec v0.2).
- **base_seq advances only when coordinator text reaches the model**, to that response's `delivered_through`. Advancing on silent responses would let an agent that read a file before a signature change submit with a base past it, and R2 would miss the stale call (the demo collision). Remaining hole (protocol, not adapter): keys an agent starts using *after* a context injection that advanced its base past an unrelated-at-the-time signature change are not flagged; a per-key/per-file knowledge base would close it (proposal for v0.2).
- Open errors are per WCP session: an adapter must not `bye` a session with open errors at harness exit, or they are silently forgiven. The Claude adapter keeps such sessions alive (detached heartbeat) so the pre-commit gate and resumed conversations still see them.
- Change id = the `Change-Id` trailer (`I` + 40 hex), generated per checkout+task at install.

## Update 2026-10-04 (B6, Artifacts integration)
- `packages/artifacts`: `ArtifactsLike` (structural subset of the binding), fork naming `weft-<repo>-<task>-<n>`, Gerrit-style Change-Ids (`I`+40 hex) and trailer parsing, `pushed` event decoding with an idempotency key, per-fork event-subscription client, in-memory fake (Workers tests) and git-backed fake + **`landByPush`** (Node/sandbox): fast-forward-only `git push --force-with-lease=<ref>:<expected>`; a lost race is `stale_trunk` (live-verified: Artifacts answers `[remote rejected] (stale ref)`).
- Gateway: `POST /v1/repos/{repo}/tasks/{task}/candidates` (system) forks trunk, mints a repo-scoped write token (returned once), registers the Change-Id in D1 and subscribes the fork's `pushed` events to Queue `weft-artifacts-events`; the queue consumer records each push as a revision (D1) and appends a WCP `checkpoint` via the system API, then calls `triggerProcessing` (stub → B8).
- Protocol change: the **system** may append `checkpoint` (an observed push, `actor:{type:system,id:artifacts}`, attributed to the change and, if a session announced the change, its agent). Spec table §4.2/§3 updated; reference + SqlCoordinator identical.
- Correction to §6.3: Artifacts `pushed` subscriptions are per repo (no namespace wildcard), so "Artifacts event → Queue" means one subscription per fork, created at candidate time (needs `WEFT_CF_API_TOKEN`; without it candidates are `subscription: pending` and an operator reconciles via `/v1/admin/artifacts/subscriptions`).
- D1 `weft` (prod) / `weft-preview`: `artifacts_repos`, `tasks`, `changes`, `revisions`, `evidence`, `artifact_events` (apps/gateway/migrations).

## Update 2026-10-04 (B9, web UI)
- `apps/web` (Worker `weft-web`, preview `weft-web-preview`) serves a dependency-free ES-module app plus an allow-listed `/api/*` in front of the gateway over a service binding; details and Access setup in `docs/web-ui.md`. The browser never holds a WCP token: the Worker uses its own `observe`+`human` token and annotates actions with the signed-in identity.
- Views: Live (log + squiggle feed over the repo DO WebSocket, cause links, animated Replay for recordings), Board, Task (candidates side by side: diff stats from log diffs, D1 evidence, revisions, Approve), Ops (land/revert op log with Undo). All state is derived client-side from the WCP log (`public/lib/model.js`) plus the D1 index, so every view updates live.
- Gateway addition: `GET /v1/repos/{repo}/tasks` (observe) — tasks with candidates (no tokens) and a per-candidate evidence tally, for the board.
- Op log for humans is derived from `land`/`revert`/`control undo` records (observer scope) rather than `/system/ops` (system scope), so the UI never needs a system token.
- Approve = WCP `control approve` (spec §9.6) **and**, when a `BESTOFN` Workflows binding exists, `sendEvent("approve")` to instance `bestofn-<repo>-<task>`. B10/BestOfN must use that instance id (or the UI's `bestOfNInstanceId()` must change with it).
- Auth: Cloudflare Access JWT verified in the Worker (aud/iss/exp/RS256); operator-key session as fallback; fails closed. Access itself needs a dashboard step by John (wrangler OAuth has no Access scopes).

## Update 2026-10-04 (B7, sandbox runner)
- `apps/sandbox` (`weft-sandbox[-preview]`): one Durable Object + one container per agent run (Containers, `scheduling_policy=durable_object`). Sandbox SDK 1.0 only adds file helpers on top of `ctx.container`; Weft drives `start/exec` directly. Image: git, node 24, Claude Code 2.1.289, Codex 0.160.0, Mergiraf 0.20.0 (registered as git merge driver `mergiraf`), pnpm, the Claude WCP adapter (Codex adapter slot staged when B5 ships a bundle) and `/opt/weft/agent-run.mjs` (clone fork → trailers → inject task/AGENTS.md → adapter install with the candidate's Change-Id → headless harness → push → `result.json`).
- **The container holds no secrets** (stronger than "secrets via wrangler secrets"): it starts with `enableInternet:false` and every HTTP(S) request goes through the Worker's `Outbound` entrypoint with per-run props. Outbound adds the fork token (this fork's path only), the Weft agent token (replacing the adapter's placeholder), the provider key / gateway token for AI Gateway `weft`, and **forces** `cf-aig-metadata {run, task, change, agent, repo}` so cost/transcript attribution cannot be spoofed by the agent; everything else is 403. Live-verified: AI Gateway log shows the metadata + tokens + cost; a sandbox push became WCP checkpoint #1 of the candidate's change; Claude Code's SessionStart hook reached the coordinator through the token swap.
- Cold start (container start → first exec) is 0.27–0.42 s on standard-1/2 (median 0.38/0.34 s, warm hosts); clone of the demo fork 1.1 s; `lite` cannot boot the 1.17 GB image. Consequence for §6.3: no batching for latency. Keep one warm sandbox per change for ProcessRevision (DO named by Change-Id, 30 min inactivity timeout, incremental fetch), coalesce bursts to the newest head per change, and batch only in the land queue to save test time. Details: `docs/research/sandbox.md`.
- Booting happens in the DO alarm, not the request: a cold start inside `blockConcurrencyWhile` (30 s cap) reset the DO in the first live probe.
- The full model transcript is the harness's own JSON event stream (Claude `stream-json`, Codex `--json`) shipped to R2 per run; AI Gateway's `getLog` returns metadata/tokens/cost but not bodies.
- Gap: AI Gateway `weft` must be created by John (dashboard / API token); the preview runs with `AI_GATEWAY_ID=default` until then. Real Claude/Codex sessions need a model credential (Worker secret or BYOK in the gateway); Workers AI models work without one.
