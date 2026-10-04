#!/usr/bin/env node
// LIVE proof for B8 (not part of the gate): the four workflows on the demo repo `weft-demo`
// against the preview stack (gateway, workflows, sandbox, Artifacts, D1, Queues, Workers AI).
//
//   node apps/workflows/scripts/live.mjs
//
//  1. bind Weft repo `weft-demo` to its Artifacts trunk with a workflow config
//     (tests: `node --test`, resolver: Workers AI LLM) and seed ts-shop + a catalog + node tests
//  2. task A (1 candidate): push -> ProcessRevision -> POST /land -> LandChange (CAS) -> `land`
//  3. task B (3 candidates, risk high): POST /select -> BestOfN; pushes: b1 adjacent edit
//     (Mergiraf), b2 broken (tests fail, bounced), b3 same-line conflict (resolver agent);
//     ranking evidence; human `approve` -> BestOfN -> LandChange
//  4. human `undo` of A's land -> RevertOperation -> revert commit on trunk, task A reopened
//
// Writes demo/evidence/b8-workflows-live/run.json. Tokens come from ~/.config/weft and are
// never printed (git gets them via GIT_CONFIG_* env).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const GW = process.env.WEFT_URL ?? "https://weft-gateway-preview.redacted-subdomain.workers.dev";
const WF = process.env.WEFT_WORKFLOWS_URL ?? "https://weft-workflows-preview.redacted-subdomain.workers.dev";
const ACCOUNT = "2d659dee148763a8d64c80135da7165d";
const REPO = process.env.WEFT_DEMO_REPO ?? "weft-demo";
const cfg = (f) => readFileSync(join(homedir(), ".config/weft", f), "utf8").trim();
const ADMIN = cfg("preview-admin-token");
const SYS = cfg("preview-workflows-system-token");
const WFTOK = cfg("preview-workflows-token");
const scrub = (s) => String(s).replace(/art_v1_[0-9a-f]+(\?expires=\d+)?/g, "art_v1_***").replace(/wcp_[A-Za-z0-9_-]+/g, "wcp_***");
const T0 = Date.now();
const log = (...a) => console.log(`[live +${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a.map((x) => (typeof x === "string" ? scrub(x) : scrub(JSON.stringify(x)))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { started_at: new Date().toISOString(), gateway: GW, workflows: WF, repo: REPO, steps: [] };
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
  execFileSync("pnpm", ["exec", "wrangler", "whoami"], { stdio: "ignore", env: { ...process.env, CLOUDFLARE_API_TOKEN: "" }, cwd: here });
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

// ------------------------------------------------------------------ demo content

const CATALOG = `/** Catalog prices per kg (Weft demo). */
export const PRICES: Record<string, number> = {
  apple: 1,
  pear: 2,
};

export function priceOf(sku: string): number {
  const p = PRICES[sku];
  if (p === undefined) throw new Error(\`unknown sku \${sku}\`);
  return p;
}
`;
const TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { calcTotal } from "../src/pricing.ts";
import { PRICES, priceOf } from "../src/catalog.ts";

test("calcTotal sums price x qty", () => {
  assert.equal(calcTotal([{ sku: "a", price: 3, qty: 4 }, { sku: "b", price: 5, qty: 2 }]), 22);
});

test("every catalog price is positive", () => {
  for (const sku of Object.keys(PRICES)) assert.ok(priceOf(sku) > 0, sku);
});
`;
const CONFIG = { tests: { command: ["node", "--test"], timeout_s: 300 }, resolver: { kind: "llm", model: "@cf/qwen/qwen2.5-coder-32b-instruct" }, layers: ["git", "mergiraf", "resolver"], job_timeout_s: 900 };

async function main() {
  const stamp = Date.now().toString(36);
  // 1. repo + trunk binding + seed
  await api("POST", "/v1/admin/repos", ADMIN, { repo: REPO }, [200, 201]);
  const bound = await api("POST", "/v1/admin/artifacts/repos", ADMIN, { repo: REPO, trunk: "weft-demo", config: CONFIG }, 201);
  step("bound trunk", { trunk: bound.trunk, namespace: bound.namespace, config: bound.config });
  const human = (await api("POST", "/v1/admin/tokens", ADMIN, { principal: "john", scopes: ["human"], repos: [REPO] }, 201)).token;
  const tt = await api("POST", `/v1/repos/${REPO}/system/trunk-token`, SYS, { ttl: 900 }, 201);
  const seed = mkdtempSync(join(tmpdir(), "weft-b8-seed-"));
  git(["clone", "-q", tt.remote, seed], { token: tt.token.plaintext });
  const before = git(["rev-parse", "HEAD"], { cwd: seed });
  let base = before;
  // Seed (or reset) the demo files; idempotent across runs.
  const shop = join(here, "../../../demo/ts-shop");
  const shopFiles = Object.fromEntries(["package.json", "README.md", "tsconfig.json", "src/pricing.ts", "src/cart.ts", "src/orders.ts"].map((f) => [f, read(shop, f)]));
  write(seed, { ...shopFiles, "src/catalog.ts": CATALOG, "test/shop.test.ts": TEST });
  if (git(["status", "--porcelain"], { cwd: seed })) {
    git(["add", "-A"], { cwd: seed });
    git(["commit", "-qm", "demo: catalog prices + node tests (B8 live seed)"], { cwd: seed });
    git(["push", "-q", `--force-with-lease=refs/heads/main:${before}`, "origin", "HEAD:refs/heads/main"], { cwd: seed, token: tt.token.plaintext });
    base = git(["rev-parse", "HEAD"], { cwd: seed });
  }
  step("trunk seeded", { before, base, files: git(["ls-files"], { cwd: seed }).split("\n") });

  // 2. tasks + candidates + subscriptions + agent sessions
  const queue = (await cf("GET", "/queues?per_page=100")).find((x) => x.queue_name === "weft-artifacts-events-preview");
  const subs = [];
  const agentTokens = {};
  async function candidates(task, title, agents) {
    const r = await api("POST", `/v1/repos/${REPO}/tasks/${task}/candidates`, SYS, { count: agents.length, agents, title, ttl: 3600 }, 201);
    for (const c of r.candidates) {
      if (c.subscription.status !== "active") {
        const sub = await cf("POST", "/event_subscriptions/subscriptions", { name: `weft-${c.fork.namespace}-${c.fork.name}`.slice(0, 100), enabled: true, source: { type: "artifacts.repo", namespace: c.fork.namespace, repo_name: c.fork.name }, destination: { type: "queues.queue", queue_id: queue.queue_id }, events: ["pushed"] });
        await api("POST", "/v1/admin/artifacts/subscriptions", ADMIN, { change: c.change, subscription_id: sub.id }, 200);
        subs.push(sub.id);
      }
      agentTokens[c.agent] ??= (await api("POST", "/v1/admin/tokens", ADMIN, { principal: c.agent, scopes: ["agent"], repos: [REPO], agent: c.agent }, 201)).token;
      const hello = { type: "hello", protocol: "wcp/0.1", agent: { id: c.agent, harness: "claude-code" }, capabilities: { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" }, task: { id: task, priority: 0 }, change: c.change };
      c.session = (await api("POST", `/v1/repos/${REPO}/sessions`, agentTokens[c.agent], hello, 201)).session;
    }
    return r.candidates;
  }
  const taskA = `b8a-${stamp}`;
  const taskB = `b8b-${stamp}`;
  const [a1] = await candidates(taskA, "Raise the apple price", ["claude-a"]);
  const [b1, b2, b3] = await candidates(taskB, "Catalog price tweaks (best of 3)", ["codex-b", "cursor-b", "claude-b"]);
  step("candidates", { taskA, taskB, a1: [a1.change, a1.fork.name], b: [b1, b2, b3].map((c) => [c.agent, c.change, c.fork.name]), subscriptions: subs.length });

  async function push(c, files, msg) {
    const d = mkdtempSync(join(tmpdir(), "weft-b8-agent-"));
    git(["clone", "-q", c.fork.remote, d], { token: c.token.plaintext });
    write(d, files(d));
    git(["add", "-A"], { cwd: d });
    git(["commit", "-qm", `${msg}\n\n${Object.entries(c.trailers).map(([k, v]) => `${k}: ${v}`).join("\n")}`], { cwd: d });
    git(["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: d, token: c.token.plaintext });
    return git(["rev-parse", "HEAD"], { cwd: d });
  }
  async function processed(c, sha, maxMs = 600_000) {
    const t = Date.now();
    for (;;) {
      const ch = await api("GET", `/v1/repos/${REPO}/changes/${c.change}`, SYS, undefined, 200);
      const rev = ch.revisions.find((r) => r.sha === sha);
      if (rev && ["processed", "conflict", "failed"].includes(rev.status)) return { rev, evidence: ch.evidence.filter((e) => e.sha === sha) };
      if (Date.now() - t > maxMs) throw new Error(`revision ${sha} of ${c.change} still ${rev?.status ?? "unseen"}`);
      await sleep(3000);
    }
  }
  const ev = (rows, kind) => {
    const e = [...rows].reverse().find((x) => x.kind === kind);
    return e ? { status: e.status, ...JSON.parse(e.data ?? "{}") } : null;
  };

  // 3. task A: push -> ProcessRevision -> land
  const catA = CATALOG.replace("apple: 1,", "apple: 5,");
  const shaA = await push(a1, () => ({ "src/catalog.ts": catA }), "catalog: apple costs 5");
  const pushedA = Date.now();
  const pa = await processed(a1, shaA);
  const rbA = ev(pa.evidence, "rebase");
  const tA = ev(pa.evidence, "test");
  step("A processed (ProcessRevision)", { sha: shaA, push_to_processed_s: (Date.now() - pushedA) / 1000, revision: pa.rev.status, workflow: pa.rev.workflow_id ?? null, rebase: { status: rbA?.status, layer: rbA?.layer, run: rbA?.run, timings: rbA?.timings }, tests: { status: tA?.status, summary: tA?.summary, command: tA?.command } });
  const landA = await api("POST", `/v1/repos/${REPO}/changes/${a1.change}/land`, human, { note: "live: land A" }, 202);
  const landAst = await waitWf("land", landA.workflow);
  step("A landed (LandChange)", { workflow: landA.workflow, status: landAst.status, output: landAst.output, error: landAst.error ?? null });
  if (landAst.output?.status !== "landed") throw new Error("A did not land");

  // 4. task B: BestOfN (risk high) with three candidates
  const sel = await api("POST", `/v1/repos/${REPO}/tasks/${taskB}/select`, SYS, { n: 3, risk: "high", poll_s: 15, collect_timeout_s: 1500, approval_timeout_s: 1800 }, 202);
  step("B selection started (BestOfN)", sel);
  const shas = {};
  shas.b1 = await push(b1, () => ({ "src/catalog.ts": CATALOG.replace("pear: 2,", "pear: 3,") }), "catalog: pear costs 3");
  shas.b2 = await push(b2, (d) => ({ "src/pricing.ts": read(d, "src/pricing.ts").replace("item.price * item.qty", "item.price + item.qty") }), "pricing: simplify total (wrong)");
  // b3 rewrites the same value A changed (apple: 1 -> 1 * KG): git and Mergiraf both conflict; the resolver agent merges intent.
  shas.b3 = await push(b3, () => ({ "src/catalog.ts": CATALOG.replace("export const PRICES", "/** Unit: prices are per kilogram. */\nexport const KG = 1;\n\nexport const PRICES").replace("  apple: 1,", "  apple: 1 * KG,").replace("  pear: 2,", "  pear: 2 * KG,\n  kiwi: 4 * KG,") }), "catalog: explicit per-kg unit, add kiwi");
  const pushedB = Date.now();
  const res = {};
  for (const [k, c] of [["b1", b1], ["b2", b2], ["b3", b3]]) {
    const p = await processed(c, shas[k]);
    const rb = ev(p.evidence, "rebase");
    const t = ev(p.evidence, "test");
    res[k] = { agent: c.agent, change: c.change, sha: shas[k], revision: p.rev.status, layer: rb?.layer ?? null, rebase: rb?.status, resolver: rb?.resolver ?? (rb?.commits ?? []).find((x) => x.layer === "resolver") ?? null, conflicts: rb?.conflicts ?? null, tests: t ? { status: t.status, summary: t.summary } : null, run: rb?.run ?? null, timings: rb?.timings ?? null };
  }
  step("B processed (3 × ProcessRevision)", { wall_s: (Date.now() - pushedB) / 1000, ...res });

  // inbox of the broken candidate: the bounce
  const inbox = await api("POST", `/v1/repos/${REPO}/sessions/${b2.session}/inbox`, agentTokens[b2.agent], { type: "inbox.drain" }, 200).catch((e) => ({ error: e.message }));
  const bounce = (inbox.items ?? []).find((i) => i.kind === "message");
  step("b2 bounced to its agent", { message_seq: bounce?.seq ?? null, text: bounce?.record?.payload?.text?.split("\n")[0] ?? null });

  // ranking + approval
  let bon;
  for (let i = 0; i < 120; i++) {
    bon = await wf("best-of-n", sel.workflow);
    const ranked = await api("GET", `/v1/repos/${REPO}/changes/${b1.change}`, SYS, undefined, 200);
    if (ranked.evidence.some((e) => e.kind === "rank")) break;
    await sleep(5000);
  }
  const ranking = [];
  for (const c of [b1, b2, b3]) {
    const ch = await api("GET", `/v1/repos/${REPO}/changes/${c.change}`, SYS, undefined, 200);
    const r = ev(ch.evidence, "rank");
    ranking.push({ agent: c.agent, change: c.change, position: r?.position, score: r?.score, eligible: r?.eligible, reasons: r?.reasons });
  }
  ranking.sort((x, y) => (x.position ?? 99) - (y.position ?? 99));
  step("B ranked, waiting for approval", { workflow_status: bon.status, ranking });
  const pick = ranking.find((r) => r.eligible);
  const appr = await api("POST", `/v1/repos/${REPO}/actions`, human, { type: "action", action: "approve", change: pick.change, note: "live: approve top candidate" }, 200);
  step("human approve", { change: pick.change, agent: pick.agent, seq: appr.seq, workflow: appr.workflow ?? null });
  const bonDone = await waitWf("best-of-n", sel.workflow);
  step("BestOfN finished", { status: bonDone.status, output: { ...bonDone.output, ranking: undefined } });
  const landB = await waitWf("land", bonDone.output.land_instance);
  step("B winner landed (LandChange)", { workflow: bonDone.output.land_instance, status: landB.status, output: landB.output });

  // 5. undo A
  const opA = landAst.output.op_id;
  const undo = await api("POST", `/v1/repos/${REPO}/actions`, human, { type: "action", action: "undo", op_id: opA, reason: "live demo: error spike after landing A" }, 200);
  step("human undo of A", { op_id: opA, control_seq: undo.seq, workflow: undo.workflow ?? null });
  const rv = await waitWf("revert", undo.workflow);
  step("A reverted (RevertOperation)", { status: rv.status, output: rv.output });

  // 6. final state: trunk content, log, tasks, ops
  const tt2 = await api("POST", `/v1/repos/${REPO}/system/trunk-token`, SYS, { scope: "read", ttl: 600 }, 201);
  const fin = mkdtempSync(join(tmpdir(), "weft-b8-final-"));
  git(["clone", "-q", tt2.remote, fin], { token: tt2.token.plaintext });
  const trunkLog = git(["log", "--format=%h %an %s", `${base}..HEAD`], { cwd: fin }).split("\n");
  const ops = (await api("GET", `/v1/repos/${REPO}/system/ops`, SYS, undefined, 200)).ops;
  const events = (await api("GET", `/v1/repos/${REPO}/events?kind=land,revert,message,checkpoint&after=0&limit=500`, SYS, undefined, 200)).events.filter((e) => [a1, b1, b2, b3].some((c) => c.change === e.change));
  const tasks = (await api("GET", `/v1/repos/${REPO}/tasks`, SYS, undefined, 200)).tasks.filter((t) => t.id === taskA || t.id === taskB).map((t) => ({ id: t.id, status: t.status, candidates: t.candidates.map((c) => [c.agent, c.status]) }));
  step("final", { trunk_head: git(["rev-parse", "HEAD"], { cwd: fin }), trunk_log: trunkLog, catalog: read(fin, "src/catalog.ts").split("\n").slice(1, 6), ops: ops.filter((o) => [opA, landB.output?.op_id, rv.output?.op_id].includes(o.op_id)), events: events.map((e) => ({ seq: e.seq, kind: e.kind, actor: e.actor?.id, summary: e.summary })), tasks });

  // cleanup: per-fork subscriptions (forks + evidence stay for the demo)
  for (const id of subs) await cf("DELETE", `/event_subscriptions/subscriptions/${id}`).catch(() => undefined);
  out.finished_at = new Date().toISOString();
  out.total_s = (Date.now() - T0) / 1000;
  const dir = join(here, "../../../demo/evidence/b8-workflows-live");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), scrub(JSON.stringify(out, null, 2)) + "\n");
  log("wrote", join(dir, "run.json"));
}

main().catch((e) => {
  console.error("[live] FAILED:", scrub(e.stack ?? e));
  try {
    const dir = join(here, "../../../demo/evidence/b8-workflows-live");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.failed.json"), scrub(JSON.stringify({ ...out, error: String(e.message ?? e) }, null, 2)) + "\n");
  } catch {}
  process.exit(1);
});
