#!/usr/bin/env node
// Scripted multi-agent scenario for the web UI (and the demo video): plays three competing
// candidates for one task plus a second task into a fresh repo on a deployed weft-gateway,
// at human pace, through the real WCP API — so the Live view, Board, Task and Ops views
// fill in live over the WebSocket. Everything here is a real coordinator verdict (the
// squiggles are R2/R3 results, not canned data).
//
//   node apps/web/scripts/demo-feed.mjs [--repo weft-ui-demo-x] [--pace 1500]
//   WEFT_URL=https://weft-gateway-preview.<sub>.workers.dev  (default: the preview)
//   WEFT_ADMIN_TOKEN_FILE=~/.config/weft/preview-admin-token
//
// Never prints tokens.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const URL_ = process.env.WEFT_URL ?? "https://weft-gateway-preview.redacted-subdomain.workers.dev";
const ADMIN = process.env.WEFT_ADMIN_TOKEN ?? readFileSync((process.env.WEFT_ADMIN_TOKEN_FILE ?? "~/.config/weft/preview-admin-token").replace(/^~/, homedir()), "utf8").trim();
const repo = arg("repo", `weft-ui-${Date.now().toString(36)}`);
const pace = Number(arg("pace", "1500"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, token, body, extra = {}) {
  const r = await fetch(URL_ + path, {
    method,
    headers: { "wcp-version": "0.1", "user-agent": "weft-demo-feed/0.1", authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
  return json;
}

const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" };
const diff = (file, minus, plus, at = 12) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -${at},${minus.length + 1} +${at},${plus.length + 1} @@`, " export class SessionStore {", ...minus.map((l) => `-${l}`), ...plus.map((l) => `+${l}`), ""].join("\n");

const created = await call("POST", "/v1/admin/repos", ADMIN, { repo });
console.log(`repo ${repo} ${created.created === false ? "(existing)" : "created"}`);
const tok = async (spec) => (await call("POST", "/v1/admin/tokens", ADMIN, spec)).token;
const AG = {
  "claude-a": { harness: "claude-code", task: "auth-retry", change: "Ia1c3f0e2b7d94c58a6e1f0b2c3d4e5f6a7b8c9d0" },
  "codex-b": { harness: "codex", task: "auth-retry", change: "Ib2d4e1f3c8ea5d69b7f2a1c3d4e5f6a7b8c9d0e1" },
  "gemini-c": { harness: "gemini-cli", task: "auth-retry", change: "Ic3e5f2a4d9fb6e7ac8a3b2d4e5f6a7b8c9d0e1f2" },
  "claude-d": { harness: "claude-code", task: "cart-total", change: "Id4f6a3b5eaac7f8bd9b4c3e5f6a7b8c9d0e1f2a3" },
};
const sys = await tok({ principal: "weft-landing", scopes: ["system"], repos: [repo] });
const S = {};
for (const [id, a] of Object.entries(AG)) {
  const t = await tok({ principal: id, scopes: ["agent"], repos: [repo], agent: id });
  const w = await call("POST", `/v1/repos/${repo}/sessions`, t, { type: "hello", protocol: "wcp/0.1", agent: { id, harness: a.harness }, capabilities: caps, task: { id: a.task, title: a.task === "auth-retry" ? "Retry expired auth tokens once" : "Show the cart total" }, change: a.change });
  S[id] = { t, sid: w.session, base: w.delivered_through ?? 0 };
  console.log(`  ${id} joined (${a.harness})`);
  await sleep(pace / 3);
}

/** Submit for an agent; base advances to delivered_through unless `hold` (agent hasn't seen it). */
async function submit(id, mode, event, hold = false) {
  const s = S[id];
  const v = await call("POST", `/v1/repos/${repo}/sessions/${s.sid}/events`, s.t, { type: "submit", mode, event: { base_seq: s.base, ...event } });
  if (!hold && v.delivered_through !== undefined) s.base = v.delivered_through;
  const d = (v.diagnostics ?? []).map((x) => `${x.severity}:${x.code}`).join(" ");
  console.log(`  #${v.seq ?? "-"} ${v.verdict} ${id} ${event.kind}${d ? `  [${d}]` : ""}`);
  await sleep(pace);
  return v;
}

const SESSION = "src/auth/session.ts";
const REFRESH = `${SESSION}#SessionStore.refreshToken`;
const FETCH = "src/api/client.ts#fetchWithAuth";

await submit("claude-a", "commit", { kind: "intent", intent: "auth-retry: Retry expired auth tokens once\nPlan: give refreshToken a retry budget and use it in fetchWithAuth." });
await submit("codex-b", "commit", { kind: "intent", intent: "auth-retry: Retry expired auth tokens once\nPlan: retry 401s once inside fetchWithAuth." });
await submit("gemini-c", "commit", { kind: "intent", intent: "auth-retry: Retry expired auth tokens once\nPlan: centralize retry in an interceptor." });
await submit("claude-d", "commit", { kind: "edit", files: ["src/cart.ts"], writes: [{ key: "src/cart.ts#Cart.total", kind: "new" }], reads: ["src/pricing.ts#calcTotal"], diff: diff("src/cart.ts", [], ["  get total(): number {", "    return calcTotal(this.items);", "  }"], 30), summary_hint: "Show the cart total" });
await submit("codex-b", "commit", { kind: "edit", files: ["src/api/client.ts"], reads: [REFRESH], writes: [{ key: FETCH, kind: "body" }], diff: diff("src/api/client.ts", ["  const res = await fetch(url, init);"], ["  let res = await fetch(url, init);", "  if (res.status === 401) {", "    await store.refreshToken();", "    res = await fetch(url, init);", "  }"], 40), summary_hint: "retry 401s once" });
await submit("claude-a", "commit", { kind: "edit", files: [SESSION], writes: [{ key: REFRESH, kind: "signature" }], diff: diff(SESSION, ["  async refreshToken(): Promise<string> {"], ["  async refreshToken(opts: { budget: number }): Promise<string> {", "    if (opts.budget <= 0) throw new RetryBudgetExceeded();"]), summary_hint: "add a retry budget" });
// codex-b has not seen claude-a's signature change (its base predates it): its next edit
// still calls refreshToken() → the pre-edit check is rejected with a stale_assumption squiggle.
await submit("codex-b", "check", { kind: "edit", files: ["src/api/client.ts"], reads: [REFRESH], writes: [{ key: FETCH, kind: "body" }], diff: diff("src/api/client.ts", ["    await store.refreshToken();"], ["    await store.refreshToken(); // second attempt"], 43) }, true);
// gemini-c tries to write the same symbol claude-a holds → arbitration (claim_wait).
await submit("gemini-c", "commit", { kind: "edit", files: [SESSION], writes: [{ key: REFRESH, kind: "body" }], diff: diff(SESSION, ["    const t = await this.fetchToken();"], ["    const t = await withInterceptor(() => this.fetchToken());"], 20) });
// codex-b proposes an overload instead of chasing the signature; claude-a accepts.
const prop = await submit("codex-b", "commit", { kind: "negotiate.propose", payload: { to: { agent: "claude-a" }, keys: [REFRESH], terms: { kind: "overload", text: "Keep refreshToken() as an overload that uses the default budget." } } });
await submit("claude-a", "commit", { kind: "negotiate.accept", payload: { reply_to: prop.seq } });
await submit("claude-a", "commit", { kind: "edit", files: [SESSION], writes: [{ key: `${SESSION}#SessionStore.refreshToken`, kind: "body" }], diff: diff(SESSION, [], ["  async refreshToken(): Promise<string>;", "  async refreshToken(opts = { budget: 1 }): Promise<string> {"]), summary_hint: "keep the old signature as an overload" });
S["codex-b"].base = (await call("POST", `/v1/repos/${repo}/sessions/${S["codex-b"].sid}/inbox`, S["codex-b"].t, { type: "inbox.drain" })).delivered_through;
await submit("codex-b", "commit", { kind: "edit", files: ["src/api/client.ts"], reads: [REFRESH], writes: [{ key: FETCH, kind: "body" }], diff: diff("src/api/client.ts", ["    await store.refreshToken();"], ["    await store.refreshToken({ budget: 1 });"], 43), summary_hint: "reroute to the budgeted refresh" });
await submit("gemini-c", "commit", { kind: "release", payload: { reason: "abandoned" }, intent: "claude-a owns refreshToken; retreating" });
await submit("claude-a", "commit", { kind: "checkpoint", payload: { sha: "4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39" } });
await submit("claude-d", "commit", { kind: "checkpoint", payload: { sha: "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807" } });

// Landing (B8 will own this): the system appends land for claude-d's change, then claude-a's.
const head = async () => (await call("GET", `/v1/repos/${repo}/events?tail=1&limit=1`, sys).catch(() => null))?.head_seq;
for (const [id, sha] of [["claude-d", "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807"], ["claude-a", "4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39"]]) {
  const r = await call("POST", `/v1/repos/${repo}/system/events`, sys, { kind: "land", base_seq: (await head()) ?? 0, task: AG[id].task, change: AG[id].change, payload: { sha, op_id: crypto.randomUUID() } });
  console.log(`  #${r.seq} ${r.status} land ${id} ${sha.slice(0, 7)}`);
  await sleep(pace);
}
for (const id of Object.keys(AG)) await call("DELETE", `/v1/repos/${repo}/sessions/${S[id].sid}`, S[id].t).catch(() => {});
console.log(`done: open the web UI at #/r/${repo}/live`);
