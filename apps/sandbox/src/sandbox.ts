// WeftSandbox: one Durable Object (and one container) per agent run.
//
// The DO owns the container's lifecycle (RunController), keeps the run's secrets in its own
// storage, and hands them to the Outbound entrypoint as props so they are added to the
// sandbox's outbound requests without ever entering the container. An alarm ticks while the
// run is live: it ships new log bytes to R2 and detects completion.

import { DurableObject } from "cloudflare:workers";
import { aigMetadata, type OutboundProps } from "./policy";
import { RunController, type ContainerLike, type KV, type RunStatus } from "./runner";
import type { ContainerSpec, RunRequest, RunSecrets } from "./spec";

export interface Env {
  WEFT_SANDBOX: DurableObjectNamespace<WeftSandbox>;
  WEFT_LOGS: R2Bucket;
  AI?: { run(model: string, inputs: unknown, options?: unknown): Promise<unknown> };
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  WEFT_RUNNER_TOKEN?: string;
  WEFT_RUNNER_REPORT_TOKEN?: string;
}

type ContainerRuntime = ContainerLike & {
  images?: Record<string, string>;
  interceptAllOutboundHttp(binding: Fetcher): Promise<void>;
  interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void>;
};

export function outboundProps(spec: ContainerSpec, secrets: RunSecrets, allowHosts: string[] = []): OutboundProps {
  const props: OutboundProps = { run: spec.run, repo: spec.repo, task: spec.task, change: spec.change, agent: spec.agent, allow_hosts: allowHosts };
  if (spec.fork && spec.fork.remote.startsWith("https://")) {
    const u = new URL(spec.fork.remote);
    props.git = { host: u.hostname, path_prefix: u.pathname.replace(/\/+$/, ""), ...(secrets.git_token ? { token: secrets.git_token } : {}) };
  }
  const gits = (spec.remotes ?? []).flatMap((r, i) => {
    if (!r.remote.startsWith("https://")) return [];
    const u = new URL(r.remote);
    const token = secrets.remote_tokens?.[i];
    return [{ host: u.hostname, path_prefix: u.pathname.replace(/\/+$/, ""), ...(token ? { token } : {}) }];
  });
  if (gits.length) props.gits = gits;
  if (spec.weft) props.weft = { origin: new URL(spec.weft.url).origin, ...(secrets.weft_token ? { token: secrets.weft_token } : {}) };
  return props;
}

export function aiGatewayBase(env: Pick<Env, "AI_GATEWAY_ACCOUNT_ID" | "AI_GATEWAY_ID">): string | undefined {
  return env.AI_GATEWAY_ACCOUNT_ID && env.AI_GATEWAY_ID ? `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}` : undefined;
}

export class WeftSandbox extends DurableObject<Env> {
  private readonly container: ContainerRuntime;
  private readonly controller: RunController;
  private allowHosts: string[] | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = (ctx as unknown as { container?: ContainerRuntime }).container;
    if (!container) throw new Error("container binding is not configured");
    this.container = container;
    const kv: KV = {
      get: async <T>(k: string) => (await ctx.storage.get<T>(k)) ?? undefined,
      put: async <T>(k: string, v: T) => ctx.storage.put(k, v),
    };
    const base = aiGatewayBase(env);
    this.controller = new RunController({
      container,
      kv,
      logs: env.WEFT_LOGS,
      ...(container.images?.agent ? { image: container.images.agent } : {}),
      ...(base ? { aiGatewayBase: base } : {}),
      prepare: async ({ spec, secrets }) => {
        const exportsNs = (ctx as unknown as { exports: Record<string, (o: { props: OutboundProps }) => Fetcher> }).exports;
        this.allowHosts ??= (await ctx.storage.get<string[]>("allow_hosts")) ?? [];
        const outbound = exportsNs.Outbound!({ props: outboundProps(spec, secrets, this.allowHosts) });
        await container.interceptAllOutboundHttp(outbound);
        await container.interceptOutboundHttps("*", outbound);
      },
      report: async (url, status) => {
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(env.WEFT_RUNNER_REPORT_TOKEN ? { authorization: `Bearer ${env.WEFT_RUNNER_REPORT_TOKEN}` } : {}) },
          body: JSON.stringify({ type: "weft.sandbox.run", status, metadata: aigMetadata({ run: status.run, repo: status.repo, task: status.task, change: status.change, agent: status.agent }) }),
        });
      },
    });
    if (container.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(30 * 60 * 1000));
  }

  async start(req: RunRequest, run: string): Promise<{ ok: true; status: RunStatus } | { ok: false; code: number; errors: string[] }> {
    // Fast path only: validate + persist; the alarm boots the container (cold start can exceed
    // the 30 s blockConcurrencyWhile limit and the caller should not wait for it).
    return this.ctx.blockConcurrencyWhile(async () => {
      this.allowHosts = req.allow_hosts ?? [];
      await this.ctx.storage.put("allow_hosts", this.allowHosts);
      const r = await this.controller.start(req, run);
      if (r.ok) await this.ctx.storage.setAlarm(Date.now());
      return r;
    });
  }

  async status(): Promise<RunStatus | undefined> {
    return this.controller.status();
  }

  async kill(): Promise<RunStatus | undefined> {
    return this.controller.kill();
  }

  /** Force a log flush / completion check now (also used by tests and the live script). */
  async poke(): Promise<RunStatus | undefined> {
    const next = await this.controller.tick();
    if (next !== null) await this.ctx.storage.setAlarm(Date.now() + next);
    return this.controller.status();
  }

  override async alarm(): Promise<void> {
    const next = await this.controller.tick();
    if (next !== null) await this.ctx.storage.setAlarm(Date.now() + next);
  }

  /** Destroy the container (after a run, to free the instance). */
  async destroy(): Promise<void> {
    if (this.container.running) await this.container.destroy();
  }
}
