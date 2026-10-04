# Weft runbook

## Prerequisites

- Node.js 22 or newer (Node 24 is used in CI)
- pnpm 9
- Cloudflare Wrangler authentication for preview deployment

## Install

```sh
pnpm install --frozen-lockfile
```

## Gate

The repository gate is:

```sh
pnpm -r typecheck && pnpm -r test
```

The root aliases are also available:

```sh
pnpm typecheck
pnpm test
```

## Run an app locally

Each app is a Worker placeholder with its own Wrangler configuration. Start one with:

```sh
pnpm --filter @weft/gateway dev
# or: pnpm --filter @weft/workflows dev
# or: pnpm --filter @weft/sandbox dev
# or: pnpm --filter @weft/web dev
```

The command runs `wrangler dev` using that app's `wrangler.toml`. Local Durable Object state, when introduced, remains local to the selected Wrangler environment.

## Deploy a preview

Authenticate using Wrangler OAuth, ensure `CLOUDFLARE_API_TOKEN` is unset, then deploy the selected app without production intent:

```sh
unset CLOUDFLARE_API_TOKEN
pnpm --filter @weft/gateway deploy:preview
```

All Worker names and future Cloudflare resources must begin with `weft-`. Do not use the preview command to deploy production without an approved environment configuration.

## Gateway + sequencer (B2)

Preview: `https://weft-gateway-preview.redacted-subdomain.workers.dev` (`/v1/health` is public).

- `packages/sequencer`: `SqlCoordinator` (WCP v0.1 over SQLite, a port of the protocol's
  reference coordinator), `JournaledCoordinator` (input journal + `replay()`), and the
  `RepoCoordinator` Durable Object (one per repo, `idFromName(repo)`).
- `apps/gateway`: the HTTP/WS binding (spec §2, §8, §9) and the `Registry` Durable Object
  (repos + SHA-256-hashed tokens).

Operator secret: `WEFT_ADMIN_TOKEN` (`wrangler secret put WEFT_ADMIN_TOKEN --env preview`).
The preview's value lives in `~/.config/weft/preview-admin-token` (mode 600) on John's
MacBook; never print it.

```sh
ADMIN=$(cat ~/.config/weft/preview-admin-token); U=https://weft-gateway-preview.redacted-subdomain.workers.dev
# create a repo (policy wound-wait|wait-die; optional claim_ttl_ms, session_ttl_ms)
curl -sX POST $U/v1/admin/repos -H "authorization: Bearer $ADMIN" -d '{"repo":"weft"}'
# agent token: exactly one repo, bound agent id (optionally change)
curl -sX POST $U/v1/admin/tokens -H "authorization: Bearer $ADMIN" \
  -d '{"principal":"claude-a","scopes":["agent"],"repos":["weft"],"agent":"claude-a"}'
# observer token for a phone (read-only), human token (approve/undo/pause/message), system token (landing queue)
curl -sX POST $U/v1/admin/tokens -H "authorization: Bearer $ADMIN" -d '{"principal":"johns-iphone","scopes":["observe"],"repos":"*"}'
curl -sX POST $U/v1/admin/tokens -H "authorization: Bearer $ADMIN" -d '{"principal":"john","scopes":["human"],"repos":"*"}'
curl -sX POST $U/v1/admin/tokens -H "authorization: Bearer $ADMIN" -d '{"principal":"landing-queue","scopes":["system"],"repos":"*"}'
# list (no secrets) / revoke
curl -s $U/v1/admin/tokens -H "authorization: Bearer $ADMIN"; curl -sX DELETE $U/v1/admin/tokens/<id> -H "authorization: Bearer $ADMIN"
```

Live smoke test (creates a throwaway `smoke-*` repo, plays the demo collision, checks the
observer API, feed and resumable stream): `node apps/gateway/scripts/smoke.mjs`.

Endpoints beyond the spec: `GET|POST /v1/repos/{repo}/system/queue` (submit queue: enqueue
`{change}`, set `{id,status}`), `GET /v1/repos/{repo}/system/ops` (operation log), agent WS
`submit` frames may carry `idempotency_key`.

## Artifacts integration (B6)

Resources (all `weft-`): Artifacts namespaces `weft` (prod) / `weft-preview`; Queues `weft-artifacts-events` /
`weft-artifacts-events-preview` (consumer: the gateway's `queue()`); D1 `weft` / `weft-preview`
(`apps/gateway/migrations`). Deploys need wrangler 4.147 (root devDependency) for the `[[artifacts]]` binding.

```sh
cd apps/gateway; unset CLOUDFLARE_API_TOKEN
pnpm exec wrangler d1 migrations apply weft-preview --env preview --remote
pnpm exec wrangler deploy --env preview
# Per-fork event subscriptions from the gateway need a CF API token (Account > Queues: Edit):
pnpm exec wrangler secret put WEFT_CF_API_TOKEN --env preview
```

```sh
ADMIN=$(cat ~/.config/weft/preview-admin-token); U=https://weft-gateway-preview.redacted-subdomain.workers.dev
# bind a Weft repo to an Artifacts trunk (create:true creates it in the env's namespace)
curl -sX POST $U/v1/admin/artifacts/repos -H "authorization: Bearer ***" -d '{"repo":"weft-demo","create":true}'
# candidates (system token): fork + write token (returned ONCE) + Change-Id + trailers
curl -sX POST $U/v1/repos/weft-demo/tasks/t_123/candidates -H "authorization: Bearer ***" -d '{"count":3,"agents":["claude-a","codex-b","cursor-c"]}'
# observe: GET  /v1/repos/{repo}/tasks/{task}/candidates, GET /v1/repos/{repo}/changes/{change} (revisions, evidence)
# system:  POST /v1/repos/{repo}/changes/{change}/token {scope?,ttl?}; DELETE /v1/repos/{repo}/changes/{change};
#          POST /v1/repos/{repo}/system/trunk-token {ttl?}   (landing: landByPush from @weft/artifacts/git)
# subscriptions left pending (no WEFT_CF_API_TOKEN): GET|POST /v1/admin/artifacts/subscriptions {change, subscription_id}
```

Agent push: `git -c http.extraHeader="Authorization: Bearer $TOKEN" push $REMOTE HEAD:main` with trailers
`Change-Id`, `Task-Id`, `Agent-Id` (from the candidate response). Each push becomes a `checkpoint` in the repo log
(~5 s) and a `revisions` row with `status=queued` (B8 picks it up).

Live proof (creates and deletes a throwaway trunk/fork/subscription): `pnpm --filter @weft/artifacts test:live`.
