// Pure outbound policy for the sandbox (see outbound.ts). No runtime imports: unit-tested in Node.

export interface OutboundProps {
  run: string;
  repo: string;
  task: string;
  change: string;
  agent: string;
  git?: { host: string; path_prefix: string; token?: string };
  weft?: { origin: string; token?: string };
  allow_hosts?: string[];
}

export interface OutboundEnv {
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AI?: { run(model: string, inputs: unknown, options?: unknown): Promise<unknown> };
}

export const AIG_HOST = "gateway.ai.cloudflare.com";

export type Decision =
  | { action: "deny"; status: number; message: string }
  | { action: "forward"; set: Record<string, string>; drop: string[]; kind: "aig" | "git" | "weft" | "allow" }
  | { action: "ai-binding"; model: string | null; compat: boolean; metadata: Record<string, string>; gateway: string };

export function aigMetadata(p: OutboundProps): Record<string, string> {
  // AI Gateway keeps at most 5 custom metadata entries.
  return { run: p.run, task: p.task, change: p.change, agent: p.agent, repo: p.repo };
}

/** Pure routing/credential policy (unit-tested without the runtime). */
export function decide(method: string, url: URL, props: OutboundProps, env: OutboundEnv): Decision {
  if (url.protocol !== "https:") return { action: "deny", status: 403, message: `${url.hostname}: only HTTPS is allowed from a Weft sandbox` };
  const host = url.hostname.toLowerCase();

  if (host === AIG_HOST && env.AI_GATEWAY_ACCOUNT_ID && env.AI_GATEWAY_ID) {
    const gw = `/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}`;
    if (url.pathname !== gw && !url.pathname.startsWith(`${gw}/`)) return { action: "deny", status: 403, message: `only AI Gateway ${env.AI_GATEWAY_ID} is reachable` };
    const rest = url.pathname.slice(gw.length);
    const metadata = aigMetadata(props);
    if (rest.startsWith("/workers-ai/") && env.AI && !env.AI_GATEWAY_TOKEN) {
      if (method !== "POST") return { action: "deny", status: 405, message: "workers-ai via binding: POST only" };
      const compat = rest === "/workers-ai/v1/chat/completions";
      return { action: "ai-binding", model: compat ? null : decodeURIComponent(rest.slice("/workers-ai/".length)), compat, metadata, gateway: env.AI_GATEWAY_ID };
    }
    const set: Record<string, string> = { "cf-aig-metadata": JSON.stringify(metadata) };
    const drop = ["cf-aig-metadata", "cf-aig-authorization"];
    if (env.AI_GATEWAY_TOKEN) set["cf-aig-authorization"] = `Bearer ${env.AI_GATEWAY_TOKEN}`;
    if (rest.startsWith("/anthropic")) {
      drop.push("x-api-key", "authorization");
      if (env.ANTHROPIC_API_KEY) set["x-api-key"] = env.ANTHROPIC_API_KEY;
    } else if (rest.startsWith("/openai") || rest.startsWith("/compat")) {
      drop.push("authorization", "x-api-key");
      if (env.OPENAI_API_KEY) set["authorization"] = `Bearer ${env.OPENAI_API_KEY}`;
    } else {
      drop.push("authorization", "x-api-key");
    }
    return { action: "forward", set, drop, kind: "aig" };
  }

  if (props.git && host === props.git.host.toLowerCase()) {
    const prefix = props.git.path_prefix.replace(/\/+$/, "");
    if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
      const set: Record<string, string> = props.git.token ? { authorization: `Bearer ${props.git.token}` } : {};
      return { action: "forward", set, drop: ["authorization"], kind: "git" };
    }
    return { action: "deny", status: 403, message: `${host}: only this run's fork is reachable` };
  }

  if (props.weft) {
    const o = new URL(props.weft.origin);
    if (o.protocol === "https:" && host === o.hostname.toLowerCase()) {
      const set: Record<string, string> = props.weft.token ? { authorization: `Bearer ${props.weft.token}` } : {};
      return { action: "forward", set, drop: ["authorization"], kind: "weft" };
    }
  }

  if ((props.allow_hosts ?? []).some((h) => h.toLowerCase() === host)) {
    if (method !== "GET" && method !== "HEAD") return { action: "deny", status: 405, message: `${host}: read-only (GET/HEAD)` };
    return { action: "forward", set: {}, drop: ["authorization", "cookie"], kind: "allow" };
  }

  return { action: "deny", status: 403, message: `${host} is not reachable from this sandbox` };
}

