# Try Weft locally

This guide takes a fresh checkout through installing dependencies and exercising WCP without Cloudflare credentials. The local tests use Workers-compatible test doubles; they do not create cloud resources. The optional preview section deploys to your own Cloudflare account and is not needed for the local demo.

## Requirements

- Git
- Node.js 22 or newer (Node 24 is used in CI)
- pnpm 9

Check versions:

```sh
node --version
pnpm --version
```

## 1. Clone and install

```sh
git clone https://github.com/celador/weft.git
cd weft
pnpm install --frozen-lockfile
```

If using Corepack and pnpm is not installed, run `corepack enable` and then `corepack prepare pnpm@9 --activate` before the install.

## 2. Run the protocol tests

```sh
pnpm --filter @weft/protocol test
```

This validates the WCP schema and runs the reference coordinator's conformance scenarios. To run the repository-wide type and test gate:

```sh
pnpm -r typecheck && pnpm -r test
```

The gate may require Docker for container-specific tests. No secrets or live services are needed for protocol tests.

## 3. Run a local Worker (optional)

Start the gateway's Wrangler development server:

```sh
pnpm --filter @weft/gateway dev
```

Wrangler prints the local address (normally `http://localhost:8787`). In a second terminal, check health:

```sh
curl -i http://localhost:8787/v1/health
```

Stop the server with Ctrl-C. Local Durable Object state is isolated to your local Wrangler environment and is not sent to Cloudflare.

## 4. Optional: deploy a preview in your Cloudflare account

This step creates/updates a Worker in the account selected by your Wrangler login. Review the commands and account before proceeding. All Weft Cloudflare resource names use the `weft-` prefix. Do not set `CLOUDFLARE_API_TOKEN`; the project uses Wrangler OAuth.

1. Authenticate with Wrangler (`pnpm exec wrangler login`) and confirm the intended account (`pnpm exec wrangler whoami`).
2. From the repository root, deploy the gateway preview:

   ```sh
   unset CLOUDFLARE_API_TOKEN
   pnpm --filter @weft/gateway deploy:preview
   ```

3. Wrangler reports the deployed URL. Check its public health endpoint:

   ```sh
   curl -i https://<your-gateway-preview-host>/v1/health
   ```

The preview deployment is only the gateway app; it is not the full hosted multi-agent demo, which also needs configured Artifacts, D1, Queue, workflow, sandbox, and evidence resources. Consult [the runbook](runbook.md) before provisioning those services. Never paste admin tokens or secrets into issue reports or logs.

## Next steps

- Read [WCP v0.1](protocol/wcp-v0.md) for message formats, roles, validation, and conformance behavior.
- Review the [architecture and Cloudflare mapping](design.md).
- See the [AAIF proposal](proposal-aaif.md) for the case for standardizing agent hooks.
