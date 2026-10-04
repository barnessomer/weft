// Shared helpers for the gateway's Workers-runtime tests.

import { SELF } from "cloudflare:test";
import { WcpProtocolError, type ErrorCode } from "@weft/protocol";

export const ADMIN = "test-admin-token";
export const BASE = "https://weft.test";

let n = 0;
export const uniqueRepo = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(n++).toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

export async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method,
    headers: {
      "wcp-version": "0.1",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** JSON call that converts WCP error bodies into WcpProtocolError (what runScenario expects). */
export async function wcp<T>(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const r = await call(method, path, token, body, headers);
  if (r.status === 204) return undefined as T;
  const j = (await r.json()) as { type?: string; error?: { code: ErrorCode; message: string; details?: Record<string, unknown> } };
  if (j.type === "error" && j.error) throw new WcpProtocolError(j.error.code, j.error.message, j.error.details);
  return j as T;
}

export async function createRepo(repo: string, init: Record<string, unknown> = {}): Promise<void> {
  const r = await call("POST", "/v1/admin/repos", ADMIN, { repo, ...init });
  if (r.status !== 201) throw new Error(`createRepo ${repo}: ${r.status} ${await r.text()}`);
}

export async function token(spec: { principal: string; scopes: string[]; repos: string[] | "*"; agent?: string; change?: string }): Promise<string> {
  const r = await call("POST", "/v1/admin/tokens", ADMIN, spec);
  if (r.status !== 201) throw new Error(`token: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { token: string }).token;
}

export const agentToken = (repo: string, agent: string) => token({ principal: agent, scopes: ["agent"], repos: [repo], agent });
export const observerToken = (repos: string[] | "*") => token({ principal: "phone", scopes: ["observe"], repos });
export const humanToken = (repos: string[] | "*", who = "john") => token({ principal: who, scopes: ["human"], repos });
export const systemToken = (repos: string[] | "*", who = "coordinator") => token({ principal: who, scopes: ["system"], repos });

export const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" } as const;

export function hello(agent: string, change: string, priority = 0) {
  return { type: "hello", protocol: "wcp/0.1", agent: { id: agent, harness: "claude-code" }, capabilities: caps, task: { id: `T-${agent}`, priority }, change };
}

/** Open a WebSocket through the gateway and collect frames. */
export async function openSocket(path: string, tok?: string) {
  const res = await SELF.fetch(`${BASE}${path}`, { headers: { upgrade: "websocket", ...(tok ? { authorization: `Bearer ${tok}` } : {}) } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket: ${res.status} ${await res.text()}`);
  const frames: Array<Record<string, unknown>> = [];
  let closed: { code: number; reason: string } | undefined;
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (e) => {
    frames.push(JSON.parse(e.data as string) as Record<string, unknown>);
    waiters.splice(0).forEach((w) => w());
  });
  ws.addEventListener("close", (e) => {
    closed = { code: e.code, reason: e.reason };
    waiters.splice(0).forEach((w) => w());
  });
  ws.accept();
  const until = async (pred: (f: Array<Record<string, unknown>>) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred(frames)) {
      if (closed) throw new Error(`socket closed ${closed.code} ${closed.reason}; frames=${JSON.stringify(frames)}`);
      if (Date.now() > end) throw new Error(`timeout; frames=${JSON.stringify(frames)}`);
      await Promise.race([new Promise<void>((r) => waiters.push(r)), new Promise((r) => setTimeout(r, 50))]);
    }
    return frames;
  };
  return { ws, frames, until, closed: () => closed, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}
