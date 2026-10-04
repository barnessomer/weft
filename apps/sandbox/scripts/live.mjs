#!/usr/bin/env node
// LIVE proof for the sandbox runner against Cloudflare (not part of the gate).
//
//   node scripts/live.mjs bench [N] [instances]  cold/warm start benchmark per instance type
//                                     (N new containers + 1 warm reuse; default standard-1)
//   node scripts/live.mjs e2e         full candidate run: Artifacts fork (gateway preview) -> sandbox
//                                     agent calls the model through AI Gateway, commits, runner pushes
//                                     through Outbound -> Artifacts pushed event -> WCP checkpoint
//   node scripts/live.mjs claude      e2e with the real Claude Code harness + WCP adapter
//                                     (needs ANTHROPIC_API_KEY or AI_GATEWAY_TOKEN on the Worker)
//
// Env: WEFT_SANDBOX_URL (default preview), WEFT_URL (gateway preview); tokens are read from
// ~/.config/weft/{preview-sandbox-token,preview-admin-token} and never printed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SBX = process.env.WEFT_SANDBOX_URL ?? "https://weft-sandbox-preview.elier.ai";
const GW = process.env.WEFT_URL ?? "https://weft-gateway-preview.elier.ai";
const ACCOUNT = "2d659dee148763a8d64c80135da7165d";
const cfg = (f) => readFileSync(join(homedir(), ".config/weft", f), "utf8").trim();
const SBX_TOKEN = cfg("preview-sandbox-token");
const log = (...a) => console.log("[live]", ...a);
const scrub = (s) => String(s).replace(/art_v1_[0-9a-f]+(\?expires=\d+)?/g, "art_v1_***").replace(/wcp_[A-Za-z0-9_-]+/g, "wcp_***");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sbx(method, path, body) {
  const r = await fetch(`${SBX}${path}`, { method, headers: { authorization: `Bearer ${SBX_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const t = await r.text();
  try {
    return { status: r.status, body: JSON.parse(t) };
  } catch {
    return { status: r.status, body: t };
  }
}

async function gw(method, path, token, body, expect) {
  const r = await fetch(`${GW}${path}`, { method, headers: { authorization: `Bearer ${token}`, "wcp-version": "0.1", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const t = await r.text();
  if (expect && r.status !== expect) throw new Error(`${method} ${path} -> ${r.status}: ${scrub(t)}`);
  return t ? JSON.parse(t) : {};
}

async function cf(method, path, body) {
  execFileSync("npx", ["wrangler", "whoami"], { stdio: "ignore", env: { ...process.env, CLOUDFLARE_API_TOKEN: "" } });
  const tok = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(join(homedir(), "Library/Preferences/.wrangler/config/default.toml"), "utf8"))[1];
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json();
  if (!j.success) throw new Error(`CF ${method} ${path}: ${JSON.stringify(j.errors)}`);
  return j.result;
}

async function waitRun(run, maxMs = 900_000) {
  const t0 = Date.now();
  for (;;) {
    const s = (await sbx("GET", `/v1/runs/${run}`)).body;
    if (["succeeded", "failed", "lost", "killed"].includes(s.state)) return s;
    if (Date.now() - t0 > maxMs) throw new Error(`run ${run} still ${s.state}`);
    await sleep(2000);
  }
}

const CHANGE0 = "I" + "0".repeat(40);

async function bench(n, instances) {
  const stamp = Date.now().toString(36);
  const rows = [];
  for (const instance of instances) {
    for (let i = 0; i < n; i++) {
      const run = `bench-${stamp}-${instance.replace(/[^a-z0-9]/g, "")}-${i}`;
      const t0 = Date.now();
      const s = await sbx("POST", "/v1/runs", { run, repo: "bench", task: "bench", change: CHANGE0, agent: "bench", harness: "script", command: ["true"], instance });
      if (s.status !== 202) throw new Error(JSON.stringify(s.body));
      const done = await waitRun(run);
      const t = done.timings;
      rows.push({ run, instance, warm: done.warm, state: done.state, accept_ms: t.requested_at - t0 > 0 ? t.requested_at - t0 : 0, boot_wait_ms: t.container_start_at - t.requested_at, cold_start_ms: t.cold_start_ms, launch_ms: t.launched_at - t.ready_at, request_to_done_ms: t.finished_at - t.requested_at, client_roundtrip_ms: Date.now() - t0 });
      if (i === 0) {
        // warm reuse: same DO (same run id) while its container is still up
        const w = await sbx("POST", "/v1/runs", { run, repo: "bench", task: "bench", change: CHANGE0, agent: "bench", harness: "script", command: ["true"], instance });
        if (w.status !== 202) throw new Error(JSON.stringify(w.body));
        const wd = await waitRun(run);
        const wt = wd.timings;
        rows.push({ run: `${run} (again)`, instance, warm: wd.warm, state: wd.state, cold_start_ms: wt.cold_start_ms, launch_ms: wt.launched_at - wt.ready_at, request_to_done_ms: wt.finished_at - wt.requested_at });
      }
      await sbx("POST", `/v1/runs/${run}/destroy`);
    }
  }
  console.table(rows);
  writeFileSync(join(tmpdir(), `weft-sandbox-bench-${stamp}.json`), JSON.stringify(rows, null, 2));
  return rows;
}

function commitTrunk(remote, token) {
  const dir = mkdtempSync(join(tmpdir(), "weft-live-trunk-"));
  const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`, GIT_TERMINAL_PROMPT: "0" };
  const g = (...a) => execFileSync("git", a, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "greet.ts"), "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n");
  writeFileSync(join(dir, "AGENTS.md"), "# demo repo\nKeep functions small and typed.\n");
  g("add", "-A");
  g("-c", "user.name=weft-live", "-c", "user.email=live@elier.ai", "commit", "-qm", "init trunk");
  g("push", "-q", remote, "HEAD:refs/heads/main");
  return g("rev-parse", "HEAD");
}

async function e2e(harness) {
  const admin = cfg("preview-admin-token");
  const stamp = Date.now().toString(36);
  const repo = `weft-sbx-${stamp}`;
  const task = `t_sbx${stamp}`;
  const agent = harness === "claude-code" ? "claude-sbx" : "kimi-sbx";
  await gw("POST", "/v1/admin/repos", admin, { repo }, 201);
  const bound = await gw("POST", "/v1/admin/artifacts/repos", admin, { repo, create: true }, 201);
  const sys = (await gw("POST", "/v1/admin/tokens", admin, { principal: "sbx-dispatcher", scopes: ["system"], repos: [repo] }, 201)).token;
  const obs = (await gw("POST", "/v1/admin/tokens", admin, { principal: "sbx-observer", scopes: ["observe"], repos: [repo] }, 201)).token;
  const tt = await gw("POST", `/v1/repos/${repo}/system/trunk-token`, sys, { ttl: 600 }, 201);
  const base = commitTrunk(bound.remote, tt.token.plaintext);
  log("trunk", bound.namespace, bound.trunk, "main =", base.slice(0, 7));

  const cand = (await gw("POST", `/v1/repos/${repo}/tasks/${task}/candidates`, sys, { agent, title: "Add a farewell function" }, 201)).candidates[0];
  log("candidate", cand.fork.name, cand.change, "subscription:", cand.subscription.status);
  let subId = cand.subscription.id;
  if (cand.subscription.status !== "active") {
    const q = (await cf("GET", "/queues?per_page=100")).find((x) => x.queue_name === "weft-artifacts-events-preview");
    const sub = await cf("POST", "/event_subscriptions/subscriptions", { name: `weft-${cand.fork.namespace}-${cand.fork.name}`.slice(0, 100), enabled: true, source: { type: "artifacts.repo", namespace: cand.fork.namespace, repo_name: cand.fork.name }, destination: { type: "queues.queue", queue_id: q.queue_id }, events: ["pushed"] });
    subId = sub.id;
    await gw("POST", "/v1/admin/artifacts/subscriptions", admin, { change: cand.change, subscription_id: sub.id }, 200);
    log("operator subscription", sub.id);
  }
  const agentTok = (await gw("POST", "/v1/admin/tokens", admin, { principal: agent, scopes: ["agent", "observe"], repos: [repo], agent }, 201)).token;

  const run = `e2e-${stamp}`;
  // The "agent" for the script harness: asks a model (through Outbound -> AI Gateway, metadata
  // attached by the Worker) to write a function, commits it, and proves the Weft token swap.
  const script = [
    "set -e",
    `curl -sS -m 120 -D /tmp/aig.h -X POST "$WEFT_AIG_BASE_URL/workers-ai/v1/chat/completions" -H 'content-type: application/json' -d '{"model":"@cf/moonshotai/kimi-k2.6","max_tokens":600,"messages":[{"role":"system","content":"You write TypeScript. Output only code, no fences."},{"role":"user","content":"Write: export function farewell(name: string): string that returns bye <name>. One function only."}]}' > /tmp/aig.json`,
    "grep -i '^cf-aig-log-id' /tmp/aig.h",
    `node -e 'const j=require("/tmp/aig.json"); let c=j.choices[0].message.content.trim().replace(/^\`\`\`\\w*\\n?|\`\`\`$/g,""); require("fs").appendFileSync("greet.ts","\\n"+c+"\\n"); console.log("model wrote", c.length, "chars")'`,
    "git add greet.ts && git commit -qm 'feat: farewell (written by kimi via AI Gateway)'",
    `curl -sS -m 30 -o /dev/null -w 'weft coordinator via Outbound (placeholder token swapped) -> %{http_code}\\n' -H 'authorization: Bearer weft-outbound-injected' -H 'wcp-version: 0.1' "${GW}/v1/repos/${repo}/events?limit=1"`,
    "curl -sS -m 30 -o /dev/null -w 'example.com -> %{http_code}\\n' https://example.com/ || true",
    `curl -sS -m 30 -o /dev/null -w 'trunk (not this run fork) -> %{http_code}\\n' "${bound.remote}/info/refs?service=git-upload-pack" || true`,
  ].join("\n");
  const req =
    harness === "claude-code"
      ? { run, repo, task, change: cand.change, agent, title: "Add a farewell function", harness: "claude-code", model: process.env.WEFT_MODEL ?? "claude-sonnet-4-5", max_turns: 20, prompt: "Add `export function farewell(name: string): string` to greet.ts returning `bye ${name}`. Commit it.", fork: { remote: cand.fork.remote, token: cand.token.plaintext }, weft: { url: GW, repo, token: agentTok, mode: "enforce" }, trailers: cand.trailers }
      : { run, repo, task, change: cand.change, agent, title: "Add a farewell function", harness: "script", command: ["sh", "-c", script], fork: { remote: cand.fork.remote, token: cand.token.plaintext }, weft: { url: GW, repo, token: agentTok }, trailers: cand.trailers };
  const t0 = Date.now();
  const s = await sbx("POST", "/v1/runs", req);
  if (s.status !== 202) throw new Error(scrub(JSON.stringify(s.body)));
  log("run", run, "accepted in", Date.now() - t0, "ms");
  const done = await waitRun(run);
  log("run finished:", done.state, JSON.stringify(done.timings));
  log("result:", scrub(JSON.stringify(done.result)));
  const stdout = (await sbx("GET", `/v1/runs/${run}/logs/agent.stdout.log`)).body;
  const runner = (await sbx("GET", `/v1/runs/${run}/logs/runner.log`)).body;
  log("agent.stdout.log (R2):\n" + scrub(String(stdout)).slice(0, 3000));
  log("runner.log (R2):\n" + scrub(String(runner)));
  const stderr = (await sbx("GET", `/v1/runs/${run}/logs/agent.stderr.log`)).body;
  if (String(stderr).trim()) log("agent.stderr.log (R2):\n" + scrub(String(stderr)).slice(-1500));
  const logId = /cf-aig-log-id:\s*(\S+)/i.exec(String(stdout))?.[1];
  if (logId) {
    await sleep(5000);
    const l = (await sbx("GET", `/v1/aig/logs/${logId}`)).body;
    log("AI Gateway log", logId, JSON.stringify({ model: l.model, provider: l.provider, metadata: l.metadata, tokens_in: l.tokens_in, tokens_out: l.tokens_out, cost: l.cost, status_code: l.status_code, duration: l.duration }));
  }
  const head = done.result?.pushed;
  if (head) {
    const pushedAt = done.timings.finished_at;
    let rec;
    while (!rec && Date.now() - pushedAt < 120_000) {
      const page = await gw("GET", `/v1/repos/${repo}/events?kind=checkpoint`, obs, undefined, 200);
      rec = page.events.find((e) => e.payload?.sha === head);
      if (!rec) await sleep(1000);
    }
    log(rec ? `WCP checkpoint #${rec.seq} for ${head.slice(0, 7)} (change ${rec.change}, actor ${JSON.stringify(rec.actor)}): "${rec.summary}"` : "no checkpoint within 120s");
    const ch = await gw("GET", `/v1/repos/${repo}/changes/${cand.change}`, obs, undefined, 200);
    log("change", JSON.stringify({ head_sha: ch.head_sha, base_sha: ch.base_sha, revisions: ch.revisions?.map((r) => ({ sha: r.sha?.slice(0, 7), seq: r.seq, status: r.status, trailer_change_id: r.trailer_change_id })) }));
  }
  await sbx("POST", `/v1/runs/${run}/destroy`);
  if (process.env.WEFT_KEEP !== "1") {
    await gw("DELETE", `/v1/repos/${repo}/changes/${cand.change}`, sys, undefined, 200).catch(() => undefined);
    if (subId) await cf("DELETE", `/event_subscriptions/subscriptions/${subId}`).catch(() => undefined);
    await cf("DELETE", `/artifacts/namespaces/${bound.namespace}/repos/${bound.trunk}`).catch(() => undefined);
    log("cleaned up fork, subscription, trunk");
  }
  return done;
}

const [cmd = "e2e", arg] = process.argv.slice(2);
const main = cmd === "bench" ? () => bench(Number(arg ?? 3), (process.argv[4] ?? "standard-1").split(",")) : cmd === "claude" ? () => e2e("claude-code") : () => e2e("script");
main().catch((e) => {
  console.error("[live] FAILED:", scrub(e.stack ?? e));
  process.exit(1);
});
