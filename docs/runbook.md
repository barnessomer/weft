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
