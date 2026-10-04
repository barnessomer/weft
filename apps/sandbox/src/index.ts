// weft-sandbox Worker: the runner API.
//
//   POST /v1/runs                       start an agent run (RunRequest) -> 202 {run, status}
//   GET  /v1/runs/{run}                 status: state, timings (cold start), result, log chunk counts
//   POST /v1/runs/{run}/kill            SIGTERM the run's process group
//   POST /v1/runs/{run}/poke            flush logs + check completion now
//   POST /v1/runs/{run}/destroy         stop the container
//   GET  /v1/runs/{run}/logs/{stream}   concatenated log chunks from R2 (runner.log | agent.stdout.log | agent.stderr.log)
//   GET  /v1/health
//
// Auth: `Authorization: Bearer <WEFT_RUNNER_TOKEN>` (Worker secret). For Worker-to-Worker use
// (B8 workflows, gateway dispatcher) bind the `SandboxRunner` entrypoint as a service and call
// start/status/kill over RPC instead.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./sandbox";
import { RUN_ID, randomRunId, type RunRequest } from "./spec";
import { STREAMS, type RunStatus } from "./runner";

export { WeftSandbox } from "./sandbox";
export { Outbound } from "./outbound";

function stub(env: Env, run: string) {
  return env.WEFT_SANDBOX.get(env.WEFT_SANDBOX.idFromName(run));
}

async function startRun(env: Env, req: RunRequest) {
  const run = req.run ?? randomRunId();
  return { run, result: await stub(env, run).start(req, run) };
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i]! ^ y[i]!;
  return d === 0;
}

export async function readLogs(bucket: R2Bucket, run: string, stream: string): Promise<string> {
  const prefix = `runs/${run}/${stream}/`;
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  keys.sort();
  let out = "";
  for (const k of keys) out += (await (await bucket.get(k))?.text()) ?? "";
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/health") return Response.json({ ok: true, service: "weft-sandbox", ai_gateway: env.AI_GATEWAY_ID ?? null });
    const auth = request.headers.get("authorization") ?? "";
    if (!env.WEFT_RUNNER_TOKEN || !timingSafeEqual(auth, `Bearer ${env.WEFT_RUNNER_TOKEN}`)) return Response.json({ error: "unauthorized" }, { status: 401 });

    // AI Gateway log lookup (metadata, tokens, cost) for a call made by a run: evidence for B8.
    const lm = /^\/v1\/aig\/logs\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (lm && request.method === "GET") {
      if (!env.AI || !env.AI_GATEWAY_ID) return Response.json({ error: "no AI binding" }, { status: 501 });
      try {
        const gw = (env.AI as unknown as { gateway(id: string): { getLog(id: string): Promise<unknown> } }).gateway(env.AI_GATEWAY_ID);
        return Response.json(await gw.getLog(lm[1]!));
      } catch (e) {
        return Response.json({ error: String((e as Error).message ?? e) }, { status: 502 });
      }
    }

    if (url.pathname === "/v1/runs" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as RunRequest | null;
      if (!body) return Response.json({ error: "JSON body required" }, { status: 400 });
      const { run, result } = await startRun(env, body);
      if (result.ok === false) return Response.json({ run, errors: result.errors }, { status: result.code });
      const st = (result as unknown as { status: RunStatus }).status;
      return Response.json({ run, status: st }, { status: st.state === "failed" ? 502 : 202 });
    }

    const m = /^\/v1\/runs\/([^/]+)(?:\/(kill|poke|destroy|logs)(?:\/([^/]+))?)?$/.exec(url.pathname);
    if (!m) return Response.json({ error: "not found" }, { status: 404 });
    const [, run, action, stream] = m;
    if (!RUN_ID.test(run!)) return Response.json({ error: "bad run id" }, { status: 400 });
    const s = stub(env, run!);
    if (!action && request.method === "GET") {
      const st = await s.status();
      return st ? Response.json(st) : Response.json({ error: "no such run" }, { status: 404 });
    }
    if (action === "logs" && request.method === "GET") {
      if (!stream || !(STREAMS as readonly string[]).includes(stream)) return Response.json({ error: `stream must be one of ${STREAMS.join(", ")}` }, { status: 400 });
      return new Response(await readLogs(env.WEFT_LOGS, run!, stream), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (request.method === "POST" && action === "kill") return Response.json((await s.kill()) ?? { error: "no such run" });
    if (request.method === "POST" && action === "poke") return Response.json((await s.poke()) ?? { error: "no such run" });
    if (request.method === "POST" && action === "destroy") {
      await s.destroy();
      return Response.json({ ok: true });
    }
    return Response.json({ error: "method not allowed" }, { status: 405 });
  },
} satisfies ExportedHandler<Env>;

/** Service-binding RPC surface for other Weft Workers (gateway dispatcher, B8 workflows). */
export class SandboxRunner extends WorkerEntrypoint<Env> {
  async start(req: RunRequest) {
    const { run, result } = await startRun(this.env, req);
    return { run, ...result };
  }
  async status(run: string) {
    return stub(this.env, run).status();
  }
  async kill(run: string) {
    return stub(this.env, run).kill();
  }
  async logs(run: string, stream: string) {
    return readLogs(this.env.WEFT_LOGS, run, stream);
  }
}
