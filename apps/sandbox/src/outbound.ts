// Outbound entrypoint: every HTTP(S) request the sandbox makes goes through here
// (container started with enableInternet:false + interceptAllOutboundHttp/interceptOutboundHttps("*")).
//
// This is where credentials are added — the container never holds them:
//   * AI Gateway `weft` (gateway.ai.cloudflare.com/v1/<account>/<gateway>/...):
//       - drops the placeholder key the harness sends, adds the provider key (Worker secret
//         ANTHROPIC_API_KEY / OPENAI_API_KEY) and/or `cf-aig-authorization` (AI_GATEWAY_TOKEN,
//         for an authenticated gateway with BYOK keys in Secrets Store);
//       - ALWAYS sets `cf-aig-metadata` {run, task, change, agent, repo} from the run's props, so
//         every model call is attributed in the gateway's logs (transcript + cost capture) and the
//         agent cannot spoof it;
//       - `workers-ai/...` requests are served through the Worker's AI binding with the same
//         gateway id + metadata (no API token needed).
//   * the candidate's Artifacts fork: adds `Authorization: Bearer <fork token>` for that repo's
//     path only;
//   * the Weft coordinator: replaces the adapter's placeholder token with the agent token;
//   * `allow_hosts` from the run spec: read-only (GET/HEAD) pass-through, e.g. a package registry.
// Everything else is refused with 403. Plain HTTP is refused (credentials never travel in clear).

import { WorkerEntrypoint } from "cloudflare:workers";
import { decide, type Decision, type OutboundEnv, type OutboundProps } from "./policy";

export { decide, aigMetadata, type OutboundProps, type OutboundEnv } from "./policy";

export class Outbound extends WorkerEntrypoint<OutboundEnv> {
  override async fetch(request: Request): Promise<Response> {
    const props = (this.ctx as unknown as { props: OutboundProps }).props;
    const url = new URL(request.url);
    const d = decide(request.method, url, props, this.env);
    if (d.action === "deny") {
      console.log(JSON.stringify({ outbound: "deny", run: props.run, host: url.hostname, path: url.pathname.slice(0, 120), status: d.status }));
      return new Response(`${d.message}\n`, { status: d.status });
    }
    if (d.action === "ai-binding") return aiBinding(request, d, this.env);
    const headers = new Headers(request.headers);
    for (const h of d.drop) headers.delete(h);
    for (const [k, v] of Object.entries(d.set)) headers.set(k, v);
    return fetch(new Request(request, { headers }));
  }
}

async function aiBinding(request: Request, d: Extract<Decision, { action: "ai-binding" }>, env: OutboundEnv): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ errors: [{ message: "JSON body required" }], success: false }, { status: 400 });
  }
  const model = d.model ?? String(body.model ?? "");
  if (!model.startsWith("@cf/") && !model.startsWith("@hf/")) return Response.json({ errors: [{ message: "workers-ai model (@cf/...) required" }], success: false }, { status: 400 });
  const inputs = { ...body };
  delete inputs.model;
  try {
    const result = await env.AI!.run(model, inputs, { gateway: { id: d.gateway, metadata: d.metadata, collectLog: true } });
    // The gateway log id lets the agent (and the runner's evidence) cite the exact logged call.
    const logId = (env.AI as { aiGatewayLogId?: string | null }).aiGatewayLogId ?? "";
    const headers: Record<string, string> = logId ? { "cf-aig-log-id": logId } : {};
    if (result instanceof ReadableStream) return new Response(result, { headers: { ...headers, "content-type": "text/event-stream" } });
    return Response.json(d.compat ? result : { result, success: true, errors: [], messages: [] }, { headers });
  } catch (e) {
    return Response.json({ errors: [{ message: String((e as Error).message ?? e) }], success: false }, { status: 502 });
  }
}
