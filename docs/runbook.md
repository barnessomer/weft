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

## PM landings → Weft `land` (B16 follow-up, stopgap until B8)

The PM lands kanban branches with `git merge`, outside Weft. Each merge must be followed by a
system `land` record, or the merged card's soft claims linger for their 30-minute TTL and later
cards get `claim_wait` against code that is already on main. After every merge into main:

```sh
python3 packages/adapters/hermes/scripts/weft_land.py                # the merge commit at main
python3 packages/adapters/hermes/scripts/weft_land.py --recent 20    # catch-up (idempotent)
python3 packages/adapters/hermes/scripts/weft_land.py --branch wt/x --sha <sha>   # fast-forward merge
# add --dry-run to see the mapping and decisions without writing
```

- Branch → change: task ids come from the weft board's kanban DB (`branch_name`, or
  `workspace_path` = `.worktrees/<key>` for `wt/<key>`), a `t_<hex8>` in the branch name, and
  the `[t_…]` tags / `Kanban-Task:` trailers of the commits the merge brought in
  (`merge^1..merge^2`). The changes are looked up with `GET /events?task=<id>`; the Hermes
  adapter names them `hermes-<profile>/<task id>`.
- A change is landed when it has an accepted `edit`/`claim` after its last accepted `land`
  (a reopened card is landed again; a rerun is a no-op). Draft:
  `POST /v1/repos/weft/system/events {kind:"land", base_seq:<head>, change, payload:{sha:<merge sha>, op_id}}`,
  `op_id` = uuid5(repo, change, sha). Per spec §6.3 the land removes the change's claims, clears
  its open errors and pushes `trunk_advanced` (requires_rebase) to the changes that touch its keys.
- A rejected land (R1 trunk CAS, `stale_overwrite`) is logged and retried up to 3 times against a
  fresh head: git already holds the merge, so the rebase is re-reading Weft's trunk view.
  Exit status 1 if any land still failed.
- Token: system token `weft-pm-land` (scopes `system`+`observe`, repos `[weft]`), minted on first
  use from `~/.config/weft/preview-admin-token` and stored under `land` in
  `~/.config/weft/hermes-adapter.json` (mode 600). `install.py --uninstall` revokes it with the
  last profile. Never printed.
- Log: one JSON line per decision in `~/.cache/weft-hermes/land.log`.
- Live check (throwaway repo; real adapter, git merge, gateway):
  `python3 packages/adapters/hermes/scripts/verify_land_live.py` — claim_wait before the land,
  `land` accepted, `trunk_advanced` to the other card, and after it rebases its edit of the same
  symbol carries no `claim_wait`/`stale_overwrite`; rerun is a no-op.
- Agents still have to rebase after a land: their next edit of a landed symbol is
  `stale_overwrite` until their worktree gets a new commit that includes main (`git merge main`).
