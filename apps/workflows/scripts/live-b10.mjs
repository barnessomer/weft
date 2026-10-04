#!/usr/bin/env node
// LIVE proof for B10 (not part of the gate): per-revision evidence on the preview stack.
//
//   node apps/workflows/scripts/live-b10.mjs
//
//  1. seed weft-demo trunk with a static storefront + `.weft/preview.json` (routes / and
//     /pricing.html) on top of the B8 shop
//  2. task "Add kiwi to the pricing page" with acceptance criteria, 2 candidates:
//       claude-a  does it (pricing row + catalog price)
//       codex-b   misreads it (changes the home page hero, pricing page untouched)
//  3. each push -> ProcessRevision -> weft-job (rebase, tests, diff) -> preview URL (weft-previews,
//     straight from Artifacts) -> Browser Rendering screenshots of both routes, candidate vs trunk,
//     pixel diff -> R2 -> Workers AI risk -> review agent via AI Gateway -> D1 evidence +
//     checkpoint record with payload.x_evidence
//  4. BestOfN ranks with the review verdicts, lands the winner; the land record carries x_evidence
//
// Writes demo/evidence/b10-evidence-live/{run.json, *.png}. Tokens come from ~/.config/weft and
// are never printed.
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
const log = (...a) => console.log(`[b10 +${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a.map((x) => (typeof x === "string" ? scrub(x) : scrub(JSON.stringify(x)))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT_DIR = join(here, "../../../demo/evidence/b10-evidence-live");
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
async function wf(kind, id, method = "GET", body) {
  const r = await fetch(`${WF}/v1/workflows/${kind}/${id}${body ? "/events" : ""}`, { method, headers: { authorization: `Bearer ${WFTOK}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
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

// ------------------------------------------------------------------ demo storefront

const CSS = `:root { --ink: #1d2433; --accent: #2f7d4f; --bg: #f7f5ef; }
* { box-sizing: border-box; }
body { margin: 0; font: 18px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; color: var(--ink); background: var(--bg); }
header { padding: 20px 48px; background: var(--accent); color: #fff; display: flex; gap: 32px; align-items: center; }
header a { color: #fff; text-decoration: none; font-weight: 600; }
header .brand { font-size: 24px; font-weight: 800; margin-right: auto; }
main { padding: 48px; max-width: 960px; }
.hero h1 { font-size: 48px; margin: 0 0 8px; }
.hero p { font-size: 22px; color: #555; }
table { border-collapse: collapse; width: 480px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
th, td { padding: 14px 20px; text-align: left; border-bottom: 1px solid #eee; }
th { background: #eef3ee; }
td.price { font-variant-numeric: tabular-nums; text-align: right; }
`;
const NAV = `<header><span class="brand">Weft Fruit Co.</span><a href="/">Home</a><a href="/pricing.html">Pricing</a></header>`;
const page = (title, body) => `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/app.css"></head>\n<body>\n${NAV}\n<main>\n${body}\n</main>\n</body>\n</html>\n`;
const HOME = page("Weft Fruit Co.", `<section class="hero"><h1>Fresh fruit, priced per kilo.</h1><p>Apples and pears from local orchards, delivered weekly.</p></section>`);
const pricing = (rows) => page("Pricing · Weft Fruit Co.", `<h1>Pricing</h1>\n<table>\n<thead><tr><th>Fruit</th><th>Price per kg</th></tr></thead>\n<tbody>\n${rows.map(([f, p]) => `<tr><td>${f}</td><td class="price">$${p}.00</td></tr>`).join("\n")}\n</tbody>\n</table>`);
const PRICING = pricing([["Apple", 1], ["Pear", 2]]);
const PREVIEW = JSON.stringify({ root: "public", routes: ["/", "/pricing.html"] }, null, 2) + "\n";

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

async function download(url, file) {
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(join(OUT_DIR, file), buf);
  return { status: r.status, type: r.headers.get("content-type"), bytes: buf.length, file };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = Date.now().toString(36);
  // 1. repo binding (idempotent) + seed the storefront onto trunk
  await api("POST", "/v1/admin/repos", ADMIN, { repo: REPO }, [200, 201]);
  const bound = await api("POST", "/v1/admin/artifacts/repos", ADMIN, { repo: REPO, trunk: "weft-demo", config: CONFIG }, [200, 201]);
  step("bound trunk", { trunk: bound.trunk, namespace: bound.namespace });
  const tt = await api("POST", `/v1/repos/${REPO}/system/trunk-token`, SYS, { ttl: 900 }, 201);
  const seed = mkdtempSync(join(tmpdir(), "weft-b10-seed-"));
  git(["clone", "-q", tt.remote, seed], { token: tt.token.plaintext });
  const before = git(["rev-parse", "HEAD"], { cwd: seed });
  const shop = join(here, "../../../demo/ts-shop");
  const shopFiles = Object.fromEntries(["package.json", "README.md", "tsconfig.json", "src/pricing.ts", "src/cart.ts", "src/orders.ts"].map((f) => [f, read(shop, f)]));
  write(seed, { ...shopFiles, "src/catalog.ts": CATALOG, "test/shop.test.ts": TEST, ".weft/preview.json": PREVIEW, "public/index.html": HOME, "public/pricing.html": PRICING, "public/app.css": CSS });
  let base = before;
  if (git(["status", "--porcelain"], { cwd: seed })) {
    git(["add", "-A"], { cwd: seed });
    git(["commit", "-qm", "demo: storefront + .weft/preview.json (B10 live seed)"], { cwd: seed });
    git(["push", "-q", `--force-with-lease=refs/heads/main:${before}`, "origin", "HEAD:refs/heads/main"], { cwd: seed, token: tt.token.plaintext });
    base = git(["rev-parse", "HEAD"], { cwd: seed });
  }
  step("trunk seeded", { before, base });

  // 2. task with acceptance criteria + 2 candidates (+ per-fork push subscriptions)
  const queue = (await cf("GET", "/queues?per_page=100")).find((x) => x.queue_name === "weft-artifacts-events-preview");
  const subs = [];
  const task = `b10-${stamp}`;
  const acceptance = ["The pricing page lists kiwi at $4.00 per kg", "The home page is unchanged", "The catalog has a kiwi price and tests pass"];
  const created = await api("POST", `/v1/repos/${REPO}/tasks/${task}/candidates`, SYS, { count: 2, agents: ["claude-a", "codex-b"], title: "Add kiwi to the pricing page", acceptance, ttl: 3600 }, 201);
  const [ca, cb] = created.candidates;
  for (const c of created.candidates) {
    if (c.subscription.status !== "active") {
      const sub = await cf("POST", "/event_subscriptions/subscriptions", { name: `weft-${c.fork.namespace}-${c.fork.name}`.slice(0, 100), enabled: true, source: { type: "artifacts.repo", namespace: c.fork.namespace, repo_name: c.fork.name }, destination: { type: "queues.queue", queue_id: queue.queue_id }, events: ["pushed"] });
      await api("POST", "/v1/admin/artifacts/subscriptions", ADMIN, { change: c.change, subscription_id: sub.id }, 200);
      subs.push(sub.id);
    }
  }
  // agent sessions: the coordinator learns a change from its agent's `hello`
  const agentTokens = {};
  for (const c of created.candidates) {
    agentTokens[c.agent] ??= (await api("POST", "/v1/admin/tokens", ADMIN, { principal: c.agent, scopes: ["agent"], repos: [REPO], agent: c.agent }, 201)).token;
    const hello = { type: "hello", protocol: "wcp/0.1", agent: { id: c.agent, harness: "claude-code" }, capabilities: { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" }, task: { id: task, priority: 0 }, change: c.change };
    c.session = (await api("POST", `/v1/repos/${REPO}/sessions`, agentTokens[c.agent], hello, 201)).session;
  }
  const board = (await api("GET", `/v1/repos/${REPO}/tasks`, SYS, undefined, 200)).tasks.find((t) => t.task === task);
  step("task + candidates", { task, acceptance: board?.acceptance, a: [ca.agent, ca.change, ca.fork.name], b: [cb.agent, cb.change, cb.fork.name] });

  async function push(c, files, msg) {
    const d = mkdtempSync(join(tmpdir(), "weft-b10-agent-"));
    git(["clone", "-q", c.fork.remote, d], { token: c.token.plaintext });
    write(d, files);
    git(["add", "-A"], { cwd: d });
    git(["commit", "-qm", `${msg}\n\n${Object.entries(c.trailers).map(([k, v]) => `${k}: ${v}`).join("\n")}`], { cwd: d });
    git(["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: d, token: c.token.plaintext });
    return git(["rev-parse", "HEAD"], { cwd: d });
  }
  async function evidenced(c, sha, maxMs = 900_000) {
    const t = Date.now();
    for (;;) {
      const ch = await api("GET", `/v1/repos/${REPO}/changes/${c.change}`, SYS, undefined, 200);
      const rev = ch.revisions.find((r) => r.sha === sha);
      const rows = ch.evidence.filter((e) => e.sha === sha);
      if (rev && ["conflict", "failed"].includes(rev.status)) return { rev, rows };
      if (rows.some((e) => e.kind === "review")) return { rev, rows };
      if (Date.now() - t > maxMs) throw new Error(`revision ${sha} of ${c.change} still ${rev?.status ?? "unseen"} (${rows.map((e) => e.kind).join(",")})`);
      await sleep(4000);
    }
  }
  const parse = (e) => ({ kind: e.kind, status: e.status, uri: e.uri ?? null, data: JSON.parse(e.data ?? "{}") });

  // 3. pushes -> ProcessRevision -> evidence
  const shaA = await push(ca, { "src/catalog.ts": CATALOG.replace("  pear: 2,", "  pear: 2,\n  kiwi: 4,"), "public/pricing.html": pricing([["Apple", 1], ["Pear", 2], ["Kiwi", 4]]) }, "pricing: add kiwi at $4/kg");
  const shaB = await push(cb, { "src/catalog.ts": CATALOG.replace("  pear: 2,", "  pear: 2,\n  kiwi: 4,"), "public/index.html": HOME.replace("Fresh fruit, priced per kilo.", "Kiwi season is here!").replace("Apples and pears from local orchards", "Kiwis, apples and pears") }, "home: announce kiwi");
  step("pushed", { a: shaA, b: shaB });
  const [ea, eb] = await Promise.all([evidenced(ca, shaA), evidenced(cb, shaB)]);
  for (const [name, c, e] of [["claude-a", ca, ea], ["codex-b", cb, eb]]) {
    const rows = e.rows.map(parse);
    step(`evidence ${name}`, {
      change: c.change,
      revision: { status: e.rev?.status, onto: e.rev?.onto_sha, rebased: e.rev?.rebased_sha, layer: e.rev?.layer },
      rows: rows.map((r) => ({ kind: r.kind, status: r.status, uri: r.uri ? r.uri.replace(/(\/[pe]\/(?:[^/]+\/){0,2})[A-Za-z0-9_-]{22}\//, "$1<sig>/") : null, data: r.kind === "rebase" ? { status: r.data.status, layer: r.data.layer } : r.kind === "test" ? { status: r.data.status, summary: r.data.summary } : r.data })),
    });
  }

  // 4. the artifacts are real: preview pages, screenshots, diffs over HTTP
  const fetched = {};
  for (const [name, e] of [["a", ea], ["b", eb]]) {
    const rows = e.rows.map(parse);
    const pv = rows.find((r) => r.kind === "preview" && r.status === "pass");
    if (pv) {
      const home = await fetch(pv.uri);
      const pricingPage = await fetch(pv.uri + "pricing.html");
      const pricingText = await pricingPage.text();
      fetched[`${name}_preview`] = { home: home.status, csp: home.headers.get("content-security-policy"), pricing: pricingPage.status, kiwi_on_pricing: pricingText.includes("Kiwi"), css_rewritten: (await (await fetch(pv.uri)).text()).includes(new URL(pv.uri).pathname + "app.css") };
      const forged = pv.uri.replace(/\/[A-Za-z0-9_-]{22}\/$/, "/AAAAAAAAAAAAAAAAAAAAAA/");
      fetched[`${name}_preview`].forged_signature = (await fetch(forged)).status;
    }
    for (const s of rows.filter((r) => r.kind === "screenshot" && r.status === "pass")) {
      const slug = (s.data.route.replace(/^\/+|\/+$/g, "") || "index").replace(/[^A-Za-z0-9._-]+/g, "_");
      fetched[`${name}_${slug}`] = await download(s.uri, `${name}-${slug}.png`);
      if (s.data.trunk_uri) fetched[`trunk_${slug}`] = await download(s.data.trunk_uri, `trunk-${slug}.png`);
      if (s.data.diff_uri) fetched[`${name}_${slug}_diff`] = await download(s.data.diff_uri, `${name}-${slug}.diff.png`);
    }
  }
  step("fetched artifacts", fetched);

  // 5. vendor fields on checkpoint records (Hérmes Changes feed)
  for (const [name, c] of [["claude-a", ca], ["codex-b", cb]]) {
    const evs = (await api("GET", `/v1/repos/${REPO}/events?change=${c.change}&kind=checkpoint&limit=50`, SYS, undefined, 200)).events;
    const cp = evs.find((e) => e.payload?.ref === "refs/weft/evidence");
    step(`x_evidence checkpoint ${name}`, { seq: cp?.seq, summary: cp?.summary, x_task_title: cp?.payload?.x_task_title, x_evidence: cp?.payload?.x_evidence });
  }

  // 6. BestOfN with the review verdicts; land the winner
  const sel = await api("POST", `/v1/repos/${REPO}/tasks/${task}/select`, SYS, { n: 2, risk: "low", poll_s: 10 }, 202);
  step("select", sel);
  // Ranking is recorded as `rank` evidence; if the top candidate needs a human (review not a
  // clean pass, or classified risk above the task's), approve the top-ranked one as john.
  let bon;
  for (const t = Date.now(); ; ) {
    bon = await wf("best-of-n", sel.workflow);
    if (["complete", "errored", "terminated"].includes(bon.status)) break;
    const ch = await api("GET", `/v1/repos/${REPO}/changes/${ca.change}`, SYS, undefined, 200);
    const ranked = ch.evidence.some((e) => e.kind === "rank");
    if (ranked && !out.steps.some((s) => s.name === "approval required")) {
      await sleep(5000);
      bon = await wf("best-of-n", sel.workflow);
      if (["complete", "errored", "terminated"].includes(bon.status)) break;
      step("approval required", { status: bon.status, note: "top candidate's review/risk asked for a human; approving the top-ranked candidate as john" });
      await wf("best-of-n", sel.workflow, "POST", { type: "approve", payload: { by: "john" } });
    }
    if (Date.now() - t > 600_000) throw new Error(`best-of-n still ${bon.status}`);
    await sleep(3000);
  }
  step("best-of-n", { status: bon.status, winner: bon.output?.winner, approved_by: bon.output?.approved_by ?? null, ranking: bon.output?.ranking?.map((r) => ({ agent: r.agent, score: r.score, eligible: r.eligible, reasons: r.reasons })) });
  if (bon.output?.land_instance) {
    const land = await waitWf("land", bon.output.land_instance);
    step("land", { status: land.status, output: land.output });
    const winner = bon.output.winner;
    const evs = (await api("GET", `/v1/repos/${REPO}/events?change=${winner}&kind=land&limit=10`, SYS, undefined, 200)).events;
    const rec = evs[evs.length - 1];
    step("land record", { seq: rec?.seq, summary: rec?.summary, x_task_title: rec?.payload?.x_task_title, x_evidence: rec?.payload?.x_evidence });
  }

  for (const id of subs) await cf("DELETE", `/event_subscriptions/subscriptions/${id}`).catch(() => undefined);
  out.finished_at = new Date().toISOString();
  out.duration_s = +((Date.now() - T0) / 1000).toFixed(1);
  writeFileSync(join(OUT_DIR, "run.json"), scrub(JSON.stringify(out, null, 2)) + "\n");
  log("wrote", join(OUT_DIR, "run.json"));
}

main().catch((e) => {
  console.error(scrub(e.stack ?? e));
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "run.failed.json"), scrub(JSON.stringify({ ...out, error: String(e.message ?? e) }, null, 2)) + "\n");
  process.exit(1);
});
