# Cloudflare platform runbook

Weft's operator surface uses three Cloudflare-native platform capabilities. Deploy them independently so the browser-facing worker never receives system credentials or policy code.

## 1. Isolated policy worker

Create dispatch namespaces once:

    npx wrangler dispatch-namespace create weft-policies
    npx wrangler dispatch-namespace create weft-policies-preview

Upload `apps/policy` to the matching namespace under the script name `default`. The web worker calls `POLICY_DISPATCH.get("default")`; the policy worker receives only the validated candidate evidence and returns a bounded JSON decision. Keep customer-specific policies in separate dispatch scripts rather than adding dynamic evaluation to `apps/web`.

Verify by signing into the web operator UI, opening Policy, and evaluating the populated passing example. It should return `allow: true` and `isolate: "dispatch"`. If no dispatch binding is configured, local development uses the same deterministic built-in policy and marks it `isolate: "builtin"`.

## 2. Email intake

Add an Email Routing rule whose action is the `weft-web` Worker. Configure:

- `WEFT_EMAIL_REPO`: destination repo slug.
- `WEFT_EMAIL_FROM`: verified reply address.
- `WEFT_EMAIL_TOKEN` secret: a dedicated gateway token restricted to that repo with only `observe` and `system` scopes.

Never reuse `WEFT_WEB_TOKEN` for Email Routing. An inbound message creates one deterministic task intent through `/system/events` and replies with the task ID. Retry delivery is idempotent because the task ID is derived from Message-ID and subject.

Verify with a message to the routed address. Confirm the reply names the repo/task and that the gateway contains one accepted intent carrying `payload.source = "email"`.

## 3. Operational telemetry

`WEFT_ANALYTICS` writes one Analytics Engine point for:

- operator actions (`action.<name>`),
- policy evaluation (`policy.evaluate`), and
- email intake (`email.intake`).

The single index is `[repo]`; blobs are `[operation, outcome, source]`; the latency is the first double. Do not put subjects, senders, intent text, tokens, or other PII in Analytics Engine.

Example account-level query:

    SELECT index1 AS repo, blob1 AS operation, blob2 AS outcome,
           count() AS requests, avg(double1) AS avg_latency_ms
    FROM weft_operations
    WHERE timestamp > NOW() - INTERVAL '1' HOUR
    GROUP BY index1, blob1, blob2
    ORDER BY requests DESC

Use dataset `weft_operations_preview` for preview. The Policy screen also gives operators an immediate event, outcome, and squiggle snapshot derived from the authorized repo stream; Analytics Engine remains the aggregate cross-request source.

## Secrets and rollout

Set secrets separately in production and preview:

    npx wrangler secret put WEFT_EMAIL_TOKEN --config apps/web/wrangler.toml
    npx wrangler secret put WEFT_WEB_TOKEN --config apps/web/wrangler.toml

Deploy and smoke-test preview before production. Rollback is a normal Worker version rollback; dispatch policies can be replaced independently without redeploying the web worker.
