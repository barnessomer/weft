#!/usr/bin/env node
// Live smoke test of a deployed weft-gateway: creates a repo, issues tokens, plays the demo
// collision (signature change → stale_assumption), and checks the observer API, the
// combined feed and the resumable WebSocket stream (browser-style auth frame).
//
//   WEFT_URL=https://weft-gateway-preview.<sub>.workers.dev \
//   WEFT_ADMIN_TOKEN_FILE=~/.config/weft/preview-admin-token node scripts/smoke.mjs
//
// Never prints tokens.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const URL_ = process.env.WEFT_URL ?? "https://weft-gateway-preview.elier.ai";
const file = (process.env.WEFT_ADMIN_TOKEN_FILE ?? "~/.config/weft/preview-admin-token").replace(/^~/, homedir());
const ADMIN = process.env.WEFT_ADMIN_TOKEN ?? readFileSync(file, "utf8").trim();
const repo = process.env.WEFT_REPO ?? `smoke-${Date.now().toString(36)}`;

async function call(method, path, token, body, extra = {}) {
  const r = await fetch(URL_ + path, {
    method,
    headers: { "wcp-version": "0.1", authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok - ${msg}`);
};

const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" };
const KEY = "src/auth/session.ts#refreshToken";

const health = await fetch(`${URL_}/v1/health`).then((r) => r.json());
ok(health.ok && health.protocol === "wcp/0.1", `health ${URL_}`);
const created = await call("POST", "/v1/admin/repos", ADMIN, { repo });
ok(created.status === 201, `created repo ${repo}`);
const tok = async (spec) => (await call("POST", "/v1/admin/tokens", ADMIN, spec)).body.token;
const ta = await tok({ principal: "claude-a", scopes: ["agent"], repos: [repo], agent: "claude-a" });
const tb = await tok({ principal: "codex-b", scopes: ["agent"], repos: [repo], agent: "codex-b" });
const obs = await tok({ principal: "smoke-phone", scopes: ["observe"], repos: [repo] });
const human = await tok({ principal: "smoke-human", scopes: ["human"], repos: [repo] });

const hello = (id, change) => ({ type: "hello", protocol: "wcp/0.1", agent: { id, harness: "smoke" }, capabilities: caps, task: { id: `T-${id}` }, change });
const A = (await call("POST", `/v1/repos/${repo}/sessions`, ta, hello("claude-a", "I-a"))).body;
const B = (await call("POST", `/v1/repos/${repo}/sessions`, tb, hello("codex-b", "I-b"))).body;
ok(A.session && B.session, `sessions ${A.session}, ${B.session}`);

const sub = (who, s, mode, event, extra) => call("POST", `/v1/repos/${repo}/sessions/${s}/events`, who, { type: "submit", mode, event }, extra);
const v1 = await sub(tb, B.session, "commit", { kind: "edit", base_seq: 2, reads: [KEY], writes: [{ key: "src/api/client.ts#fetchWithAuth", kind: "body" }], intent: "retry 401s once" }, { "idempotency-key": "smoke-1" });
const v1b = await sub(tb, B.session, "commit", { kind: "edit", base_seq: 2, reads: [KEY], writes: [{ key: "src/api/client.ts#fetchWithAuth", kind: "body" }], intent: "retry 401s once" }, { "idempotency-key": "smoke-1" });
ok(v1.body.verdict === "accept" && v1.body.seq === 3 && v1b.body.seq === 3, "B edit accepted (#3); idempotent retry returned the same verdict");
const v2 = await sub(ta, A.session, "commit", { kind: "edit", base_seq: 1, writes: [{ key: KEY, kind: "signature" }], intent: "add a retry budget" });
ok(v2.body.verdict === "accept" && v2.body.seq === 4, `A signature change accepted: "${v2.body.summary}"`);
const v3 = await sub(tb, B.session, "check", { kind: "edit", base_seq: 3, reads: [KEY], writes: [{ key: "src/api/client.ts#fetchWithAuth", kind: "body" }] });
ok(v3.body.verdict === "reject" && v3.body.diagnostics[0].code === "stale_assumption" && v3.body.diagnostics[0].caused_by_seq === 4, "B pre-edit check rejected: stale_assumption caused by #4");
ok(v3.body.inbox.some((i) => i.diagnostic?.code === "contract_changed"), "B inbox carries contract_changed");
const gate = await call("POST", `/v1/repos/${repo}/sessions/${B.session}/gate`, tb, { type: "gate", gate: "stop" });
ok(gate.body.allow === false, "B stop gate refused while the error is open");
const msg = await call("POST", `/v1/repos/${repo}/actions`, human, { type: "action", action: "message", to: { agent: "codex-b" }, text: "use the overload", intent: "steer" });
ok(msg.body.record?.actor?.id === "smoke-human", "human steer message logged and attributed to the token principal");

const repos = await call("GET", "/v1/repos", obs);
ok(repos.body.repos.length === 1 && repos.body.repos[0].head_seq === 6, `repo list: ${JSON.stringify(repos.body.repos[0])}`);
const page = await call("GET", `/v1/repos/${repo}/events?tail=1&limit=3`, obs);
ok(page.body.events.map((e) => e.seq).join(",") === "4,5,6", "tail page 4,5,6");
const feed = await call("GET", "/v1/feed?limit=50", obs);
ok(feed.body.events.length === 6 && feed.body.cursor.startsWith("v0."), "combined feed returns 6 events with a v0 cursor");
for (const e of page.body.events) console.log(`   #${e.seq} ${e.summary}`);

// Resumable stream with a browser-style auth frame.
const frames = [];
const ws = new WebSocket(`${URL_.replace(/^http/, "ws")}/v1/repos/${repo}/stream?after=4`);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`stream timeout: ${JSON.stringify(frames)}`)), 10_000);
  ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: obs, id: "auth" }));
  ws.onmessage = async (e) => {
    const f = JSON.parse(e.data);
    frames.push(f);
    if (f.type === "replay.done") {
      await call("POST", `/v1/repos/${repo}/sessions/${A.session}/heartbeat`, ta, { type: "heartbeat" });
      await sub(ta, A.session, "commit", { kind: "intent", base_seq: 4, intent: "live event" });
    }
    if (f.type === "event" && f.event.seq === 7) {
      clearTimeout(timer);
      resolve();
    }
  };
  ws.onerror = (e) => reject(new Error(`ws error ${e.message ?? ""}`));
});
ws.close();
ok(frames.map((f) => f.type === "event" ? f.event.seq : f.type).join(",") === "auth.ok,5,6,replay.done,7", `stream frames: ${frames.map((f) => (f.type === "event" ? f.event.seq : f.type)).join(",")}`);
await call("DELETE", `/v1/repos/${repo}/sessions/${A.session}`, ta);
await call("DELETE", `/v1/repos/${repo}/sessions/${B.session}`, tb);
console.log(`smoke passed against ${URL_} (repo ${repo})`);
