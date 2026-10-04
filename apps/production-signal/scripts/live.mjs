#!/usr/bin/env node
// LIVE proof for B13 (not part of the gate): production signal -> auto-revert on the preview stack.
//
//   node apps/production-signal/scripts/live.mjs seed    # make the weft-demo trunk a deployable Worker
//   node apps/production-signal/scripts/live.mjs prove   # planted bug: land -> deploy -> errors -> revert
//
// Target: Worker `weft-demo`, built and deployed by Workers Builds from the Artifacts trunk
// (namespace `weft-preview`, repo `weft-demo`, branch `main`). Its wrangler config (on trunk) names
// `weft-production-signal-preview` as Tail Consumer. The detector writes to Analytics Engine
// `weft_prod_preview`, fans out over Queue `weft-prod-events-preview`, and starts
// `RevertOperation` (`weft-revert-operation-preview`) as `prod-revert-<land op id>`.
//
// prove:
//  1. preflight: the demo Worker serves the current trunk (GET /quote -> 200)
//  2. task + 1 candidate; the agent pushes a planted bug in src/worker.ts (tests still pass)
//  3. ProcessRevision (tests in the sandbox) -> POST /land -> LandChange -> `land` op
//  4. Workers Builds deploys trunk; /quote now throws -> N requests
//  5. Tail Worker -> AE + Queue -> detector -> RevertOperation (no human involved)
//  6. revert commit on trunk -> Workers Builds redeploys -> /quote 200 again
//  7. task reopened, change `reverted`, evidence = the production stack trace
//
// Writes demo/evidence/b13-auto-revert-live/run.json. Tokens come from ~/.config/weft and the
// wrangler OAuth config and are never printed (git gets them via GIT_CONFIG_* env).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const GW = process.env.WEFT_URL ?? "https://weft-gateway-preview.redacted-subdomain.workers.dev";
const WF = process.env.WEFT_WORKFLOWS_URL ?? "https://weft-workflows-preview.redacted-subdomain.workers.dev";
const DEMO = process.env.WEFT_DEMO_URL ?? "https://weft-demo.redacted-subdomain.workers.dev";
const ACCOUNT = "2d659dee148763a8d64c80135da7165d";
const REPO = process.env.WEFT_DEMO_REPO ?? "weft-demo";
const SPIKE_REQUESTS = Number(process.env.WEFT_SPIKE_REQUESTS ?? 8);
const cfg = (f) => readFileSync(join(homedir(), ".config/weft", f), "utf8").trim();
const ADMIN = cfg("preview-admin-token");
const SYS = cfg("preview-workflows-system-token");
const WFTOK = cfg("preview-workflows-token");
const scrub = (s) => String(s).replace(/art_v1_[0-9a-f]+(\?expires=\d+)?/g, "art_v1_***").replace(/wcp_[A-Za-z0-9_-]+/g, "wcp_***");
const T0 = Date.now();
const log = (...a) => console.log(`[live +${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a.map((x) => (typeof x === "string" ? scrub(x) : scrub(JSON.stringify(x)))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { started_at: new Date().toISOString(), gateway: GW, workflows: WF, demo: DEMO, repo: REPO, steps: [] };
const step = (name, data) => {
  out.steps.push({ name, at_s: +((Date.now() - T0) / 1000).toFixed(1), ...data });
  log(name, data);
};

async function api(method, path, token, body, expect) {
  const r = await fetch(`${GW}${path}`, { method, headers: { authorization: `Bearer ${token}`, "wcp-version": "0.1", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const t = await r.text();
  if (expect && ![].concat(expect).includes(r.status)) throw new Error(`${method} ${path} -> ${r.status}: ${scrub(t).slice(0, 600)}`);
  return t ? JSON.parse(t) : {};
}
async function wf(kind, id) {
  const r = await fetch(`${WF}/v1/workflows/${kind}/${id}`, { headers: { authorization: `Bearer ${WFTOK}` } });
  // The operator API answers 400 `instance.not_found` for an id nobody has started yet.
  if (r.status === 404 || r.status === 400) return { status: "absent", http: r.status };
  return r.json();
}
async function waitWf(kind, id, until = ["complete", "errored", "terminated"], maxMs = 900_000) {
  const t = Date.now();
  let last;
  for (;;) {
    const s = await wf(kind, id);
    if (s.status !== last?.status) log(`workflow ${kind}/${id}:`, s.status);
    last = s;
    if (until.includes(s.status)) return s;
    if (Date.now() - t > maxMs) throw new Error(`workflow ${kind}/${id} still ${s.status}`);
    await sleep(3000);
  }
}
async function cf(method, path, body) {
  const tok = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(join(homedir(), "Library/Preferences/.wrangler/config/default.toml"), "utf8"))[1];
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json();
  if (!j.success) throw new Error(`CF ${method} ${path}: ${JSON.stringify(j.errors)}`);
  return j.result;
}
function git(args, { cwd, token } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "weft-live", GIT_AUTHOR_EMAIL: "live@agents.weft.dev", GIT_COMMITTER_NAME: "weft-live", GIT_COMMITTER_EMAIL: "live@agents.weft.dev" };
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` });
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${scrub(r.stderr)}`);
  return r.stdout.trim();
}
function write(dir, files) {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
}
const read = (dir, f) => readFileSync(join(dir, f), "utf8");
const D1_PREVIEW = "7bd18baa-103a-4712-8dcd-5bbac18000b1";
async function d1(sql, params = []) {
  const r = await cf("POST", `/d1/database/${D1_PREVIEW}/query`, { sql, params });
  return r[0]?.results ?? [];
}
async function aeSql(sql) {
  const tok = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(join(homedir(), "Library/Preferences/.wrangler/config/default.toml"), "utf8"))[1];
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`, { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: sql });
  const t = await r.text();
  try { return JSON.parse(t).data; } catch { return { status: r.status, body: t.slice(0, 300) }; }
}
async function demo(path) {
  const t = Date.now();
  try {
    const r = await fetch(`${DEMO}${path}`, { headers: { "cache-control": "no-cache" } });
    return { status: r.status, ms: Date.now() - t, body: (await r.text()).slice(0, 300) };
  } catch (e) {
    return { status: 0, ms: Date.now() - t, body: String(e.message ?? e) };
  }
}
async function waitDemo(path, ok, label, maxMs = 900_000) {
  const t = Date.now();
  for (;;) {
    const r = await demo(path);
    if (ok(r)) return { ...r, waited_s: (Date.now() - t) / 1000 };
    if (Date.now() - t > maxMs) throw new Error(`demo ${label}: still ${r.status} ${r.body}`);
    await sleep(5000);
  }
}
async function demoVersions() {
  const v = await cf("GET", `/workers/scripts/weft-demo/versions`).catch((e) => ({ error: e.message }));
  const items = v.items ?? v;
  return Array.isArray(items) ? items.slice(0, 4).map((x) => ({ id: x.id, created_on: x.metadata?.created_on, source: x.metadata?.source, message: x.annotations?.["workers/message"], triggered_by: x.annotations?.["workers/triggered_by"] })) : items;
}

// ------------------------------------------------------------------ demo target (on trunk)

const WORKER = `import { calcTotal } from "./pricing.ts";
import { PRICES, priceOf } from "./catalog.ts";

/** Weft demo target: the shop's quote API, deployed from trunk by Workers Builds. */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/quote") {
      const sku = url.searchParams.get("sku") ?? "apple";
      const qty = Number(url.searchParams.get("qty") ?? "1");
      if (!(sku in PRICES)) return Response.json({ error: \`unknown sku \${sku}\` }, { status: 404 });
      return Response.json({ sku, qty, total: calcTotal([{ sku, price: priceOf(sku), qty }]) });
    }
    return Response.json({ service: "weft-demo", prices: PRICES });
  },
};
`;
// Tail Consumer: the target names the consumer (Cloudflare attaches it on deploy).
const WRANGLER = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "weft-demo",
  "main": "src/worker.ts",
  "compatibility_date": "2025-09-06",
  "workers_dev": true,
  "tail_consumers": [{ "service": "weft-production-signal-preview" }],
  "observability": { "enabled": true }
}
`;
// The planted bug: a "unit" option that crashes when the parameter is absent. The unit tests
// cover pricing/catalog only, so presubmit is green and the change lands.
const PLANTED = WORKER.replace(
  `      const qty = Number(url.searchParams.get("qty") ?? "1");\n`,
  `      const qty = Number(url.searchParams.get("qty") ?? "1");\n      const unit = url.searchParams.get("unit")!.toLowerCase(); // planted bug: throws when ?unit is absent\n      if (unit === "g") return Response.json({ sku, qty, total: calcTotal([{ sku, price: priceOf(sku) / 1000, qty }]) });\n`,
);

async function trunkClone(scope = "write") {
  const tt = await api("POST", `/v1/repos/${REPO}/system/trunk-token`, SYS, { scope, ttl: 900 }, 201);
  const d = mkdtempSync(join(tmpdir(), "weft-b13-trunk-"));
  git(["clone", "-q", tt.remote, d], { token: tt.token.plaintext });
  return { dir: d, token: tt.token.plaintext };
}

async function seed() {
  const { dir, token } = await trunkClone();
  const before = git(["rev-parse", "HEAD"], { cwd: dir });
  write(dir, { "src/worker.ts": WORKER, "wrangler.jsonc": WRANGLER });
  if (git(["status", "--porcelain"], { cwd: dir })) {
    git(["add", "-A"], { cwd: dir });
    git(["commit", "-qm", "demo: deploy the shop as Worker weft-demo (quote API, tail consumer)"], { cwd: dir });
    git(["push", "-q", `--force-with-lease=refs/heads/main:${before}`, "origin", "HEAD:refs/heads/main"], { cwd: dir, token });
  }
  log("seeded", { before, head: git(["rev-parse", "HEAD"], { cwd: dir }), files: git(["ls-files"], { cwd: dir }).split("\n") });
}

async function prove() {
  const stamp = Date.now().toString(36);
  // 1. preflight
  const head0 = git(["rev-parse", "HEAD"], { cwd: (await trunkClone("read")).dir });
  const pre = await waitDemo("/quote?sku=pear&qty=2", (r) => r.status === 200, "preflight", 120_000);
  step("preflight: demo serves trunk", { trunk_head: head0, quote: pre, versions: await demoVersions() });

  // 2. task + candidate + planted bug
  const queue = (await cf("GET", "/queues?per_page=100")).find((x) => x.queue_name === "weft-artifacts-events-preview");
  const human = (await api("POST", "/v1/admin/tokens", ADMIN, { principal: "john", scopes: ["human"], repos: [REPO] }, 201)).token;
  const task = `b13-${stamp}`;
  const agent = "claude-b13";
  const r = await api("POST", `/v1/repos/${REPO}/tasks/${task}/candidates`, SYS, { count: 1, agents: [agent], title: "Quote API: support ?unit=g", ttl: 3600 }, 201);
  const [c] = r.candidates;
  let sub = null;
  if (c.subscription.status !== "active") {
    sub = await cf("POST", "/event_subscriptions/subscriptions", { name: `weft-${c.fork.namespace}-${c.fork.name}`.slice(0, 100), enabled: true, source: { type: "artifacts.repo", namespace: c.fork.namespace, repo_name: c.fork.name }, destination: { type: "queues.queue", queue_id: queue.queue_id }, events: ["pushed"] });
    await api("POST", "/v1/admin/artifacts/subscriptions", ADMIN, { change: c.change, subscription_id: sub.id }, 200);
  }
  try {
    const agentTok = (await api("POST", "/v1/admin/tokens", ADMIN, { principal: agent, scopes: ["agent"], repos: [REPO], agent }, 201)).token;
    const hello = { type: "hello", protocol: "wcp/0.1", agent: { id: agent, harness: "claude-code" }, capabilities: { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" }, task: { id: task, priority: 0 }, change: c.change };
    await api("POST", `/v1/repos/${REPO}/sessions`, agentTok, hello, 201);
    step("task + candidate", { task, change: c.change, fork: c.fork.name });

    const d = mkdtempSync(join(tmpdir(), "weft-b13-agent-"));
    git(["clone", "-q", c.fork.remote, d], { token: c.token.plaintext });
    if (read(d, "src/worker.ts") !== WORKER) throw new Error("trunk src/worker.ts differs from the seeded target; run `seed` first");
    write(d, { "src/worker.ts": PLANTED });
    git(["add", "-A"], { cwd: d });
    git(["commit", "-qm", `quote: support ?unit=g\n\n${Object.entries(c.trailers).map(([k, v]) => `${k}: ${v}`).join("\n")}`], { cwd: d });
    git(["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: d, token: c.token.plaintext });
    const sha = git(["rev-parse", "HEAD"], { cwd: d });
    step("planted bug pushed", { sha, diff: git(["show", "--format=", "--unified=0", "HEAD", "--", "src/worker.ts"], { cwd: d }).split("\n").filter((l) => /^[+-][^+-]/.test(l)) });

    // 3. ProcessRevision -> land
    const t = Date.now();
    let rev;
    for (;;) {
      const ch = await api("GET", `/v1/repos/${REPO}/changes/${c.change}`, SYS, undefined, 200);
      rev = ch.revisions.find((x) => x.sha === sha);
      if (rev && ["processed", "conflict", "failed"].includes(rev.status)) {
        const tests = [...ch.evidence].reverse().find((e) => e.sha === sha && e.kind === "test");
        step("processed (ProcessRevision)", { revision: rev.status, tests: tests ? { status: tests.status, summary: JSON.parse(tests.data ?? "{}").summary } : null });
        break;
      }
      if (Date.now() - t > 600_000) throw new Error(`revision still ${rev?.status ?? "unseen"}`);
      await sleep(3000);
    }
    if (rev.status !== "processed") throw new Error(`revision ${rev.status}`);
    const land = await api("POST", `/v1/repos/${REPO}/changes/${c.change}/land`, human, { note: "live B13: land the unit option" }, 202);
    const landed = await waitWf("land", land.workflow);
    if (landed.output?.status !== "landed") throw new Error(`land: ${JSON.stringify(landed.output ?? landed.error)}`);
    const landedAt = Date.now();
    const landRow = (await d1(`SELECT op_id, kind, status, created_at FROM landings WHERE op_id = ?`, [landed.output.op_id]))[0];
    const opId = landed.output.op_id;
    step("landed (LandChange)", { workflow: land.workflow, output: landed.output, d1_landing: landRow });

    // 4. Workers Builds deploys the bug; production traffic hits it
    const broken = await waitDemo("/quote?sku=pear&qty=2", (x) => x.status >= 500, "bug deploy");
    step("Workers Builds deployed trunk with the bug", { land_to_broken_s: (Date.now() - landedAt) / 1000, sample: broken, versions: await demoVersions() });
    const hits = [];
    for (let i = 0; i < SPIKE_REQUESTS; i++) hits.push((await demo(`/quote?sku=pear&qty=${i + 1}`)).status);
    step("production traffic", { requests: SPIKE_REQUESTS, statuses: hits });

    // 5. detector -> RevertOperation (system, no human)
    const revertId = `prod-revert-${opId}`;
    const tr = Date.now();
    let started;
    for (;;) {
      started = await wf("revert", revertId);
      if (started.status !== "absent") break;
      if (Date.now() - tr > 300_000) throw new Error(`no ${revertId} after 300 s`);
      await sleep(3000);
    }
    const latch = await d1(`SELECT land_op_id, triggered_at, error_count, workflow_id FROM production_reverts WHERE land_op_id = ?`, [opId]);
    step("detector started RevertOperation", { workflow: revertId, status: started.status, d1_latch: latch, land_row_to_trigger_s: latch[0] && landRow ? (latch[0].triggered_at - landRow.created_at) / 1000 : null });
    const rv = await waitWf("revert", revertId);
    step("reverted (RevertOperation)", { status: rv.status, output: rv.output, error: rv.error ?? null });
    if (rv.output?.status !== "reverted") throw new Error("revert did not complete");

    // 6. Workers Builds redeploys the revert
    const healed = await waitDemo("/quote?sku=pear&qty=2", (x) => x.status === 200, "revert deploy");
    step("Workers Builds deployed the revert", { land_to_healed_s: (Date.now() - landedAt) / 1000, sample: healed, versions: await demoVersions() });

    // 7. final state
    const fin = await trunkClone("read");
    const ch = await api("GET", `/v1/repos/${REPO}/changes/${c.change}`, SYS, undefined, 200);
    const prodEv = ch.evidence.filter((e) => e.kind === "production_tail_error").map((e) => ({ status: e.status, ...JSON.parse(e.data ?? "{}") }));
    const tasks = (await api("GET", `/v1/repos/${REPO}/tasks`, SYS, undefined, 200)).tasks.filter((x) => (x.task ?? x.id) === task).map((x) => ({ id: x.task ?? x.id, status: x.status, candidates: x.candidates.map((y) => [y.agent, y.status]) }));
    const ops = (await api("GET", `/v1/repos/${REPO}/system/ops`, SYS, undefined, 200)).ops.filter((o) => [opId, rv.output.op_id].includes(o.op_id));
    const events = (await api("GET", `/v1/repos/${REPO}/events?kind=land,revert,message&after=0&limit=500`, SYS, undefined, 200)).events.filter((e) => e.change === c.change).map((e) => ({ seq: e.seq, kind: e.kind, actor: e.actor, summary: e.summary }));
    await sleep(20_000); // Analytics Engine ingestion lag
    const ae = await aeSql(`SELECT blob1 AS script, count() AS errors, min(double1) AS first_ms, max(double1) AS last_ms FROM weft_prod_preview WHERE index1 = '${REPO}' AND double1 >= ${landedAt - 120_000} GROUP BY blob1`);
    step("final", { analytics_engine_weft_prod_preview: ae, change_status: ch.change?.status ?? ch.status, task: tasks, ops, events, evidence: prodEv, trunk_log: git(["log", "--format=%h %an %s", "-3"], { cwd: fin.dir }).split("\n"), worker_ts_matches_seed: read(fin.dir, "src/worker.ts") === WORKER });
  } finally {
    if (sub) await cf("DELETE", `/event_subscriptions/subscriptions/${sub.id}`).catch(() => undefined);
  }
  out.finished_at = new Date().toISOString();
  out.total_s = (Date.now() - T0) / 1000;
}

const dir = join(here, "../../../demo/evidence/b13-auto-revert-live");
const cmd = process.argv[2];
(cmd === "seed" ? seed() : cmd === "prove" ? prove().then(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), scrub(JSON.stringify(out, null, 2)) + "\n");
  log("wrote", join(dir, "run.json"));
}) : Promise.reject(new Error("usage: live.mjs seed|prove"))).catch((e) => {
  console.error("[live] FAILED:", scrub(e.stack ?? e));
  if (cmd === "prove") {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "run.failed.json"), scrub(JSON.stringify({ ...out, error: String(e.message ?? e) }, null, 2)) + "\n");
    } catch {}
  }
  process.exit(1);
});
