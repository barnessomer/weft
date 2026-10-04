# Cloudflare Artifacts readiness spike

Status: blocked on account access as of 2026-10-03.

## Account verification

`wrangler artifacts namespaces list --json` was run without `CLOUDFLARE_API_TOKEN`. Cloudflare returned API error `10004` (Access denied) for the account's Artifacts namespaces endpoint. This means the current authenticated Wrangler identity cannot use Artifacts; it does not establish that the account is or is not on Workers Paid.

Cloudflare's pricing page says Artifacts is available only on Workers Paid. It lists the first 10,000 operations/month and first 1 GB-month as included, then $0.15/1,000 operations and $0.50/GB-month. The billing start date in the current Cloudflare documentation is **2026-10-14**, not 2026-10-15.

The published limits are unlimited namespaces and repositories; 2,000 control-plane requests/10 seconds per namespace; 2,000 Git requests/10 seconds per artifact; 1 GB/repository; 32 MB/blob; and 1 TB/account (raiseable on request). These are published product limits, not a load test of this account.

Before deployment, obtain an identity with Artifacts access (and Workers Paid if needed), then verify with:

```sh
wrangler artifacts namespaces list --json
```

The source output and no credentials are committed.

## Spike contents

`spikes/artifacts/` is a typed Worker with a remote Artifacts binding to namespace `weft-spike` and a Queue consumer named `weft-artifacts-events`.

The Worker deliberately keeps token operations behind a bearer secret. It uses the documented binding surface: namespace `create`/`get`, and repository `info`, `fork`, `readFile`, and `createToken`.

- `POST /repos` creates a repository, but does not return its initial write token.
- `GET /repos/:name` returns repository metadata.
- `POST /repos/:name/fork` creates a default-branch-only fork.
- `GET /repos/:name/file?ref=main&path=README.md` streams a file at a ref.
- `POST /repos/:name/tokens` mints a short-lived read or write repo token only after authorization.
- The Queue consumer records Artifacts event type, namespace, repo name, payload, and ingestion latency. It does not persist events; that is intentionally the next decision.

The current Workers binding reference documents repository creation/import/deletion, metadata, token management, forking, and **read-only** Git object/file/history methods. It documents no create-commit, write-blob/tree, update-ref, or compare-and-swap ref method. Treat `git push` using a short-lived write token as the landing primitive, performed in a sandbox/container (or another trusted Git client). Atomic Git ref update semantics must be enforced by the Git push itself; a binding-based CAS is not currently available in the documented API.

Set the `ADMIN_SECRET` with `wrangler secret put ADMIN_SECRET` before deployment. Do not put it in `wrangler.toml`, source, or Git.

## Event subscription design

Artifacts sends lifecycle events (create, delete, fork, import, push, clone, fetch, and token changes) through Cloudflare Queues Event Subscriptions. Subscribe at the account-level `artifacts` source and route to `weft-artifacts-events`. The documented `cf.artifacts.repo.pushed` payload has `source.type: "artifacts.repo"`, `source.namespace`, `source.repoName`, `payload.ref`, `payload.before`, `payload.after`, `payload.commits` (each commit's id/message/timestamp/author/committer/parents), `payload.totalCommitsCount`, `payload.commitsTruncated`, plus `metadata.accountId`, `eventSubscriptionId`, `eventSchemaVersion`, and `eventTimestamp`. `cloned`/`fetched` carry an empty payload; token events include `tokenId`, and token-created also has `scope` and `expiresAt`.

Observed delivery latency is unavailable: no subscription could be created while the Artifacts namespace API returns Access denied. The consumer has measurement code, but no production or test event was received.

Use the queue as an intake boundary. For each `cf.artifacts.repo.pushed` event, the downstream durable consumer should deduplicate by a deterministic key built from event type, repository identity, and commit/ref data from the payload before scheduling a build. This protects the path from delivery retries and burst pushes. Persist the raw envelope plus the derived key and processing status in a durable store; the spike only proves decode and measurement.

## Workers Builds and previews

Cloudflare documents a Workers Builds integration that can build directly from an Artifacts repository. It requires account permissions `Artifacts Read` and `Artifacts Edit`; its documented setup is through the Workers dashboard. The integration supports only `main` as the production branch. Enabling “Builds for Preview branches” causes non-`main` pushes to run `npx wrangler preview` and create/update a branch Preview URL.

The consulted integration documentation does not document an API for programmatically attaching a newly created Artifacts fork to Workers Builds or enabling preview branches. Therefore treat automated per-fork Workers Builds configuration as unverified and do not make candidate forks invoke previews until a supported API is found and tested. A single preconfigured repository with candidate branches is the documented preview path.

## Sandbox and Containers decision

The recommended future shape is one Artifacts repo per sandbox/session ID, as shown by Cloudflare's `git-repo-per-sandbox` example. The Worker should create or reuse the repo from its own session record, issue a short-lived write token only when the sandbox needs to push, and supply the authenticated remote as an environment variable. Keep the Artifacts repo as the workspace/source-of-truth boundary rather than the scheduler's local filesystem.

Do not make Sandboxes or Containers a deployment dependency yet. They require their own account entitlement/configuration and were not validated while Artifacts itself returns access denied. Once access is granted, deploy this Worker first, create a test repo, push via its scoped token, confirm an event reaches the queue, and then add the sandbox/container integration behind a feature flag.

## Sources

- https://developers.cloudflare.com/artifacts/platform/pricing/
- https://developers.cloudflare.com/artifacts/guides/event-subscriptions/
- https://developers.cloudflare.com/artifacts/get-started/workers/
- https://developers.cloudflare.com/artifacts/api/workers-binding/
- https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/
- https://developers.cloudflare.com/sandbox/get-started/
- https://developers.cloudflare.com/containers/guides/deploy/

## Live verification (B6, 2026-10-04, account on Workers Paid)

Verified facts (commands: `packages/artifacts/src/live/e2e.live.ts` via `pnpm --filter @weft/artifacts test:live`,
plus direct CF API calls with wrangler OAuth):

- Namespace `weft-preview` is created implicitly by the first repo create (`wrangler@4.147 artifacts repos create … --namespace weft-preview`).
  The `[[artifacts]]` binding needs wrangler ≥ 4.14x (repo pins 4.147.0 for deploys; vitest-pool-workers keeps its own 4.35 and only warns).
- `fork()` returns `{remote, token, tokenExpiresAt}` immediately; `createToken("write", ttl)` on the new fork worked right after (no FORK_IN_PROGRESS seen).
  Candidate creation (fork + token + revoke initial token) takes ~5.4 s end to end from the gateway.
- `git clone`/`git push` with the fork token via `http.extraHeader: Authorization: Bearer <token>` (passed in `GIT_CONFIG_*` env, never argv). Fork starts at trunk HEAD.
- **Event subscriptions:** `pushed` exists only on source `artifacts.repo`, which **requires `repo_name`**. `repo_name: "*"` is accepted
  by the API but delivers nothing (verified: push with a `*` subscription → backlog 0; with a literal subscription → 1 message).
  The API event name is the short form `pushed` (`cf.artifacts.repo.pushed` is rejected as "Unrecognized event types").
  ⇒ one subscription per fork: `POST /accounts/{acct}/event_subscriptions/subscriptions {source:{type:"artifacts.repo",namespace,repo_name}, destination:{type:"queues.queue",queue_id}, events:["pushed"]}`.
- Delivered message body (HTTP pull) = JSON string of `{type:"cf.artifacts.repo.pushed", source:{namespace,repoName,type}, metadata:{accountId,eventSubscriptionId,eventSchemaVersion:1,eventTimestamp}, payload:{ref,before,after,commits[{id,message,messageTruncated,timestamp,author,committer,parents}],totalCommitsCount,commitsTruncated}}`;
  message metadata `CF-sourceMessageSource: artifacts.repo`.
- **Latency:** `eventTimestamp` → consumer `received_at` ≈ 3.1 s (consumer `max_batch_timeout = 2`); `git push` returned → WCP checkpoint visible via the observer API ≈ 5.2–5.5 s (3 runs, includes 500 ms polling).
- **Landing CAS:** Artifacts receive-pack enforces the old value: two concurrent `git push --force-with-lease=refs/heads/main:<base>` of different commits → exactly one wins,
  the other gets `[remote rejected] (stale ref)` (both outcomes observed across runs). Retrying the loser with the stale lease → client-side `stale info`.
- Workers OAuth (wrangler) cannot create API tokens (`/accounts/{id}/tokens` → 9109 Unauthorized), so the gateway's `WEFT_CF_API_TOKEN` must be created by John in the dashboard.

Unverified / for later: Workers `[[triggers.events]]` (wrangler 4.147 validates Artifacts event triggers with `filter = {namespace, repo_name?}` targeting **Workflows**) would give a
namespace-wide `pushed` trigger without per-fork subscriptions — worth testing in B8 (ProcessRevision).
