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

## 3b. Use the local gateway with real agents (optional)

`dev:local` runs the gateway's `test` environment: the coordinator and registry only (no Artifacts, Queues or Workflows), so it needs no Cloudflare login. It covers edit-time checks and the event log; landing is not automated, so a `land` event must be posted by a system writer (step 5 below).

1. Set the admin token in a gitignored `.dev.vars.test` file (Wrangler reads it; keeping it off the command line keeps it out of `ps`), apply the local D1 schema, and start the gateway:

   ```sh
   cd apps/gateway
   echo "WEFT_ADMIN_TOKEN=$(openssl rand -hex 16)" > .dev.vars.test
   pnpm exec wrangler d1 migrations apply WEFT_DB --local --env test
   pnpm dev:local                                   # http://localhost:8787
   ```

2. Create a repo and mint tokens. Agent tokens are scoped to one repo; each response contains the secret once, in its `token` field. Mint one `agent` token per agent and one `system` token for landing:

   ```sh
   U=http://localhost:8787; AD="authorization: Bearer $(cut -d= -f2 apps/gateway/.dev.vars.test)"
   curl -sX POST $U/v1/admin/repos  -H "$AD" -d '{"repo":"my-repo"}'
   curl -sX POST $U/v1/admin/tokens -H "$AD" \
     -d '{"principal":"agent-a","scopes":["agent","observe"],"repos":["my-repo"],"agent":"agent-a"}'   # -> {"token":"..."}
   curl -sX POST $U/v1/admin/tokens -H "$AD" \
     -d '{"principal":"lander","scopes":["system"],"repos":["my-repo"]}'
   ```

3. Build the Claude Code adapter once, then run its `install` in each agent's checkout or git worktree, using the absolute path to the bundle (the agents' projects do not contain it):

   ```sh
   pnpm --filter @weft/adapter-claude-code build
   WEFT_TOKEN=<agent token> node /abs/path/to/weft/packages/adapters/claude-code/dist/weft-claude.mjs install \
     --url http://localhost:8787 --repo my-repo --agent agent-a --task T-1 --title "What A is doing"
   ```

   Use a distinct `--agent` and token per worktree. Agents working on different repositories need different `--repo` values: coordination is per repository, so agents in different repos are not checked against each other.

4. Start the agents. An edit that conflicts with another agent's change is denied with a diagnostic.

5. To make `stale_overwrite` fire, post a `land` event once an agent's work is merged, using the system token:

   ```sh
   curl -sX POST $U/v1/repos/my-repo/system/events -H "authorization: Bearer <system token>" \
     -d '{"kind":"land","base_seq":<last seq>,"change":"<change id from .weft/claude.json>","payload":{"sha":"<hex sha>","op_id":"op1"}}'
   ```

State is local to Wrangler and lost when `.wrangler/` is cleared.

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
