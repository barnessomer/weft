// Run specification for one agent run (one candidate change) and its secret/non-secret split.
//
// The caller (dispatcher / B8 workflows) sends a RunRequest. Secrets (the fork's write token,
// the Weft agent token) are separated immediately: they live only in the run's Durable Object
// storage and in the props of the Outbound entrypoint, never in the container, R2, logs or
// status responses. The container gets `ContainerSpec` (spec.json) only.

export type Harness = "claude-code" | "codex" | "script";

export interface RunRequest {
  /** Run id (DO name). Default: random. 1-63 chars [a-z0-9-]. */
  run?: string;
  repo: string;
  task: string;
  /** Change-Id (I + 40 hex) of the candidate. */
  change: string;
  agent: string;
  title?: string;
  harness: Harness;
  model?: string;
  max_turns?: number;
  /** The task text handed to the agent. */
  prompt?: string;
  /** Extra repository rules injected as AGENTS.md. */
  agents_md?: string;
  /** `script` harness only: argv run in the checkout (tests, smoke, benchmarks). */
  command?: string[];
  fork?: { remote: string; branch?: string; token?: string };
  /** Extra git remotes reachable from the run (system jobs: trunk + fork). Tokens stay in the DO. */
  remotes?: Array<{ remote: string; token?: string }>;
  /** WCP coordinator for the adapter (claude-code harness). */
  weft?: { url: string; repo?: string; token?: string; priority?: number; mode?: "enforce" | "advise" };
  trailers?: Record<string, string>;
  /** Container instance type (lite, standard-1..4). Default standard-1. */
  instance?: string;
  timeout_s?: number;
  push?: boolean;
  /** Extra hostnames the agent may reach read-only (GET/HEAD), e.g. registry.npmjs.org. */
  allow_hosts?: string[];
  /** POSTed with the final status when the run ends. */
  report?: { url: string };
}

export interface RunSecrets {
  git_token?: string;
  /** Tokens for `remotes[i]` (same order; null = none). */
  remote_tokens?: Array<string | null>;
  weft_token?: string;
}

/** What the container sees (spec.json). No secrets. */
export interface ContainerSpec {
  run: string;
  repo: string;
  task: string;
  change: string;
  agent: string;
  title?: string;
  harness: Harness;
  model?: string;
  max_turns?: number;
  prompt?: string;
  agents_md?: string;
  command?: string[];
  fork?: { remote: string; branch?: string };
  remotes?: Array<{ remote: string }>;
  weft?: { url: string; repo?: string; priority?: number; mode?: "enforce" | "advise" };
  trailers?: Record<string, string>;
  timeout_s?: number;
  push?: boolean;
  ai_gateway?: { base_url: string };
  work_root?: string;
}

export const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const INSTANCE_TYPES = ["lite", "standard-1", "standard-2", "standard-3", "standard-4"];
// Linux rejects a single argv entry >= 128 KiB; the prompt becomes one argument.
export const MAX_PROMPT_BYTES = 120 * 1024;

export function validateRunRequest(r: unknown): string[] {
  const errs: string[] = [];
  if (!r || typeof r !== "object") return ["body must be a JSON object"];
  const q = r as Record<string, unknown>;
  const str = (k: string) => typeof q[k] === "string" && (q[k] as string).length > 0;
  for (const k of ["repo", "task", "change", "agent", "harness"]) if (!str(k)) errs.push(`${k} required`);
  if (q.run !== undefined && !(typeof q.run === "string" && RUN_ID.test(q.run))) errs.push("run must match [a-z0-9-]{1,63}");
  if (q.harness !== undefined && !["claude-code", "codex", "script"].includes(q.harness as string)) errs.push("harness must be claude-code|codex|script");
  if (q.harness === "script") {
    if (!Array.isArray(q.command) || q.command.length === 0 || !q.command.every((a) => typeof a === "string")) errs.push("script harness needs command: string[]");
  } else if (q.harness) {
    if (!str("prompt")) errs.push("prompt required");
    if (!q.fork) errs.push("fork required");
  }
  if (typeof q.prompt === "string" && new TextEncoder().encode(q.prompt + String(q.agents_md ?? "")).byteLength > MAX_PROMPT_BYTES) errs.push("prompt + agents_md must be < 120 KiB");
  if (q.fork !== undefined) {
    const f = q.fork as Record<string, unknown>;
    if (!f || typeof f.remote !== "string" || !/^(https:\/\/|file:\/\/)/.test(f.remote)) errs.push("fork.remote must be an https:// (or file:// in tests) git URL");
  }
  if (q.remotes !== undefined) {
    if (!Array.isArray(q.remotes) || q.remotes.length > 8 || !q.remotes.every((x) => x && typeof (x as { remote?: unknown }).remote === "string" && /^(https:\/\/|file:\/\/)/.test((x as { remote: string }).remote)))
      errs.push("remotes must be at most 8 {remote: https:// git URL}");
  }
  if (q.weft !== undefined) {
    const w = q.weft as Record<string, unknown>;
    if (!w || typeof w.url !== "string" || !/^https?:\/\//.test(w.url)) errs.push("weft.url must be an http(s) URL");
  }
  if (q.instance !== undefined && !INSTANCE_TYPES.includes(q.instance as string)) errs.push(`instance must be one of ${INSTANCE_TYPES.join(", ")}`);
  if (q.timeout_s !== undefined && !(typeof q.timeout_s === "number" && q.timeout_s > 0 && q.timeout_s <= 6 * 3600)) errs.push("timeout_s must be 1..21600");
  if (q.allow_hosts !== undefined && !(Array.isArray(q.allow_hosts) && q.allow_hosts.every((h) => typeof h === "string" && /^[a-z0-9.-]+$/i.test(h)))) errs.push("allow_hosts must be hostnames");
  if (q.report !== undefined && !(q.report && typeof (q.report as { url?: unknown }).url === "string" && /^https:\/\//.test((q.report as { url: string }).url))) errs.push("report.url must be https");
  return errs;
}

/** Split a validated request into the container's spec and the Worker-only secrets. */
export function splitRequest(r: RunRequest, run: string, aiGatewayBase: string | undefined): { spec: ContainerSpec; secrets: RunSecrets } {
  const secrets: RunSecrets = {};
  if (r.fork?.token) secrets.git_token = r.fork.token;
  if (r.weft?.token) secrets.weft_token = r.weft.token;
  if (r.remotes?.some((x) => x.token)) secrets.remote_tokens = r.remotes.map((x) => x.token ?? null);
  const spec: ContainerSpec = {
    run,
    repo: r.repo,
    task: r.task,
    change: r.change,
    agent: r.agent,
    harness: r.harness,
    ...(r.title !== undefined ? { title: r.title } : {}),
    ...(r.model !== undefined ? { model: r.model } : {}),
    ...(r.max_turns !== undefined ? { max_turns: r.max_turns } : {}),
    ...(r.prompt !== undefined ? { prompt: r.prompt } : {}),
    ...(r.agents_md !== undefined ? { agents_md: r.agents_md } : {}),
    ...(r.command !== undefined ? { command: r.command } : {}),
    ...(r.fork ? { fork: { remote: r.fork.remote, ...(r.fork.branch ? { branch: r.fork.branch } : {}) } } : {}),
    ...(r.remotes ? { remotes: r.remotes.map((x) => ({ remote: x.remote })) } : {}),
    ...(r.weft
      ? {
          weft: {
            url: r.weft.url,
            ...(r.weft.repo ? { repo: r.weft.repo } : {}),
            ...(r.weft.priority !== undefined ? { priority: r.weft.priority } : {}),
            ...(r.weft.mode ? { mode: r.weft.mode } : {}),
          },
        }
      : {}),
    ...(r.trailers ? { trailers: r.trailers } : {}),
    ...(r.timeout_s !== undefined ? { timeout_s: r.timeout_s } : {}),
    ...(r.push !== undefined ? { push: r.push } : {}),
    ...(aiGatewayBase ? { ai_gateway: { base_url: aiGatewayBase } } : {}),
  };
  return { spec, secrets };
}

/** Never let a token leave through status/log output. */
export function redact(s: string, extra: Array<string | undefined> = []): string {
  let out = s;
  for (const x of extra) if (x && x.length >= 8) out = out.split(x).join("***");
  return out
    .replace(/art_v1_[0-9a-f]{16,}(\?expires=\d+)?/g, "art_v1_***")
    .replace(/(authorization:\s*(bearer|basic)\s+)[^\s"']+/gi, "$1***")
    .replace(/sk-(ant-)?[A-Za-z0-9_-]{16,}/g, "sk-***");
}

export function randomRunId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return `run-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}
