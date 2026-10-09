#!/usr/bin/env node
// Local quickstart for Weft (docs/try-it.md §4): against a gateway started with
// `pnpm dev:local`, create a repo, mint one agent token per checkout plus a system token,
// and install the Claude Code adapter in each checkout. `--demo` also builds a tiny sample
// repo with two git worktrees and plays both collisions (stale_assumption, then
// stale_overwrite after a `land`) by driving the adapter's hook command, no LLM needed.
//
//   node scripts/local-quickstart.mjs [--url URL] [--repo NAME] [--agents a,b] <checkout> [<checkout> ...]
//   node scripts/local-quickstart.mjs --demo [--url URL] [--dir DIR]
//
// Tokens are never printed: agent tokens go to <checkout>/.weft/token (0600, gitignored by
// the adapter), the system token to apps/gateway/.wrangler/weft-local/<repo>.system-token.
// Zero dependencies beyond Node >= 22 and git; the adapter bundle is built if missing.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WEFT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BUNDLE = join(WEFT_ROOT, "packages/adapters/claude-code/dist/weft-claude.mjs");
const DEV_VARS = join(WEFT_ROOT, "apps/gateway/.dev.vars.test");
const START_HINT =
  "Start the local gateway first, in another terminal:\n" +
  "  cd apps/gateway && pnpm dev:local            # add `--port 8788` (and pass --url here) if 8787 is taken";

export class QuickstartError extends Error {}

export function parseArgs(argv) {
  const o = { url: process.env.WEFT_URL ?? "http://localhost:8787", repo: undefined, agents: undefined, dirs: [], demo: false, dir: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new QuickstartError(`${a} needs a value`);
      return v;
    };
    if (a === "--url") o.url = val().replace(/\/+$/, "");
    else if (a === "--repo") o.repo = val();
    else if (a === "--agents") o.agents = val().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--dir") o.dir = val();
    else if (a === "--demo") o.demo = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a.startsWith("--")) throw new QuickstartError(`unknown option ${a}`);
    else o.dirs.push(resolve(a));
  }
  if (o.agents && o.agents.length !== o.dirs.length) throw new QuickstartError(`--agents names ${o.agents.length} agent(s) but ${o.dirs.length} checkout(s) were given`);
  if (!/^https?:\/\//.test(o.url)) throw new QuickstartError(`--url must start with http:// or https:// (got ${o.url})`);
  return o;
}

/** Default agent ids: agent-a, agent-b, ... */
export const agentName = (i) => `agent-${i < 26 ? String.fromCharCode(97 + i) : i + 1}`;

/** Admin token: $WEFT_ADMIN_TOKEN, else the WEFT_ADMIN_TOKEN line of apps/gateway/.dev.vars.test. */
export function adminToken(env = process.env, file = DEV_VARS) {
  if (env.WEFT_ADMIN_TOKEN) return env.WEFT_ADMIN_TOKEN.trim();
  if (!existsSync(file))
    throw new QuickstartError(
      `no admin token: ${file} does not exist.\nCreate it, then (re)start the gateway:\n` +
        `  cd apps/gateway && echo "WEFT_ADMIN_TOKEN=$(openssl rand -hex 16)" > .dev.vars.test`,
    );
  const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("WEFT_ADMIN_TOKEN="));
  const v = line?.slice("WEFT_ADMIN_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
  if (!v) throw new QuickstartError(`${file} has no WEFT_ADMIN_TOKEN=... line`);
  return v;
}

/** Minimal client for the admin / observer / system API. Never logs tokens. */
export function client(url, fetchImpl = fetch) {
  async function call(method, path, token, body) {
    let r;
    try {
      r = await fetchImpl(url + path, {
        method,
        headers: { "wcp-version": "0.1", authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new QuickstartError(`cannot reach a gateway at ${url} (${err?.cause?.code ?? err?.message ?? err}).\n${START_HINT}`);
    }
    const text = await r.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!r.ok) {
      const code = json?.error?.code ?? r.status;
      const msg = json?.error?.message ?? text.slice(0, 200);
      let hint = "";
      if (r.status === 401 && path.startsWith("/v1/admin"))
        hint = "\nThe gateway's admin token differs from apps/gateway/.dev.vars.test. Restart `pnpm dev:local` after writing that file (Wrangler reads it at start).";
      if (r.status === 403 && /admin API disabled/.test(msg)) hint = "\nThe gateway has no WEFT_ADMIN_TOKEN. Write apps/gateway/.dev.vars.test and restart `pnpm dev:local`.";
      throw new QuickstartError(`${method} ${path} -> ${r.status} ${code}: ${msg}${hint}`);
    }
    return json;
  }
  return {
    async health() {
      let r;
      try {
        r = await fetchImpl(`${url}/v1/health`);
      } catch (err) {
        throw new QuickstartError(`cannot reach a gateway at ${url} (${err?.cause?.code ?? err?.message ?? err}).\n${START_HINT}`);
      }
      const body = await r.text();
      let j;
      try {
        j = JSON.parse(body);
      } catch {
        /* not JSON */
      }
      if (!r.ok || j?.service !== "weft-gateway")
        throw new QuickstartError(
          `${url} answers, but it is not a Weft gateway (HTTP ${r.status}). Another program probably owns that port.\n` +
            `Run the gateway on a free port and point this script at it:\n  cd apps/gateway && pnpm dev:local --port 8788\n  node scripts/local-quickstart.mjs --url http://localhost:8788 ...`,
        );
      return j;
    },
    createRepo: (admin, repo) => call("POST", "/v1/admin/repos", admin, { repo }),
    token: (admin, spec) => call("POST", "/v1/admin/tokens", admin, spec),
    events: (token, repo, q = "") => call("GET", `/v1/repos/${encodeURIComponent(repo)}/events${q}`, token),
    system: (token, repo, draft) => call("POST", `/v1/repos/${encodeURIComponent(repo)}/system/events`, token, draft),
  };
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function ensureBundle() {
  if (existsSync(BUNDLE)) return;
  console.log("building the Claude Code adapter bundle (once)...");
  const r = spawnSync(process.execPath, [join(WEFT_ROOT, "packages/adapters/claude-code/scripts/build.mjs")], { stdio: "inherit" });
  if (r.status !== 0 || !existsSync(BUNDLE)) throw new QuickstartError("adapter build failed; run `pnpm install --frozen-lockfile` at the repository root first");
}

export function systemTokenPath(repo) {
  return join(WEFT_ROOT, "apps/gateway/.wrangler/weft-local", `${repo}.system-token`);
}

function writeSecret(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Create the repo, mint tokens and install the adapter in every checkout.
 * Returns {repo, agents:[{dir, agent, change}], systemTokenFile}.
 */
export async function setup({ url, repo, dirs, agents, tasks }, api = client(url), log = console.log) {
  if (!dirs.length) throw new QuickstartError("give at least one checkout (a git repository or worktree), or use --demo");
  const roots = dirs.map((d) => {
    if (!existsSync(d)) throw new QuickstartError(`${d} does not exist`);
    try {
      return git(d, ["rev-parse", "--show-toplevel"]);
    } catch {
      throw new QuickstartError(`${d} is not inside a git repository (the adapter installs git hooks; run \`git init\` there first)`);
    }
  });
  const dup = roots.find((r, i) => roots.indexOf(r) !== i);
  if (dup) throw new QuickstartError(`${dup} was given twice; each agent needs its own checkout (use \`git worktree add\`)`);
  repo ??= basename(git(roots[0], ["rev-parse", "--path-format=absolute", "--git-common-dir"]).replace(/\/\.git$/, "")).replace(/[^A-Za-z0-9._-]/g, "-");
  await api.health();
  const admin = adminToken();
  const created = await api.createRepo(admin, repo);
  log(`repo ${repo}: ${created?.created ? "created" : "already exists (reusing it)"}`);
  ensureBundle();
  const out = [];
  for (const [i, root] of roots.entries()) {
    const agent = agents?.[i] ?? agentName(i);
    const t = await api.token(admin, { principal: agent, scopes: ["agent", "observe"], repos: [repo], agent });
    const task = tasks?.[i] ?? { id: `T-${i + 1}`, title: `${agent}'s task` };
    const r = spawnSync(
      process.execPath,
      [BUNDLE, "install", "--dir", root, "--url", url, "--repo", repo, "--agent", agent, "--task", task.id, "--title", task.title],
      { env: { ...process.env, WEFT_TOKEN: t.token }, encoding: "utf8" },
    );
    if (r.status !== 0) throw new QuickstartError(`adapter install failed in ${root}:\n${r.stderr || r.stdout}`);
    const cfg = JSON.parse(readFileSync(join(root, ".weft/claude.json"), "utf8"));
    out.push({ dir: root, agent, change: cfg.change, task: task.id });
    log(`installed ${agent} in ${root} (task ${task.id}, change ${cfg.change})`);
  }
  const sys = await api.token(admin, { principal: "lander", scopes: ["system", "observe"], repos: [repo] });
  const systemTokenFile = systemTokenPath(repo);
  writeSecret(systemTokenFile, sys.token);
  log(`system token (for land events) saved to ${systemTokenFile}`);
  return { repo, agents: out, systemTokenFile };
}

export function nextSteps({ url, repo, agents, systemTokenFile }) {
  const a = agents[0];
  return [
    "",
    "Next steps:",
    ...agents.map((x) => `  cd ${x.dir} && claude          # ${x.agent}; hooks load when the session starts`),
    "  Watch the log:   curl -s -H \"authorization: Bearer $(cat " + systemTokenFile + ")\" " + `${url}/v1/repos/${repo}/events | jq '.events[] | [.seq, .status, .kind, .agent, .summary]'`,
    `  Agent state:     ${join(a.dir, ".weft/bin/weft")} status    (adapter log: ${join(a.dir, ".weft/log/adapter.log")})`,
    "  Land a change:   once an agent's commit is merged into your main branch, post a land event so",
    "                   the others get stale_overwrite until they merge it:",
    `    node scripts/local-quickstart.mjs land --url ${url} --repo ${repo} --change <Change-Id> --sha <merged sha>`,
    "",
  ].join("\n");
}

/** Post a `land` for a change at the current head (the PM/merge queue does this in the hosted stack). */
export async function land({ url, repo, change, sha }, api = client(url)) {
  const token = readFileSync(systemTokenPath(repo), "utf8").trim();
  const head = (await api.events(token, repo, "?limit=1")).head_seq;
  const res = await api.system(token, repo, { kind: "land", base_seq: head, change, payload: { sha, op_id: `land-${Date.now().toString(36)}` } });
  return res;
}

// ---------------------------------------------------------------- demo (no LLM)

export const PRICING_V1 = `export type Item = { price: number; qty: number };

export function calcTotal(items: Item[]): number {
  return items.reduce((s, i) => s + i.price * i.qty, 0);
}
`;
export const CART_V1 = `import { calcTotal, type Item } from "./pricing";

export function cartSummary(items: Item[]): string {
  return \`\${items.length} items\`;
}
`;
const SIG_OLD = "export function calcTotal(items: Item[]): number {";
const SIG_NEW = "export type PriceOptions = { taxRate: number };\n\nexport function calcTotal(items: Item[], opts: PriceOptions): number {";

/** A tiny TypeScript repo with two worktrees, one per agent. */
export function makeSampleRepo(base) {
  const main = join(base, "shop");
  mkdirSync(join(main, "src"), { recursive: true });
  writeFileSync(join(main, "src/pricing.ts"), PRICING_V1);
  writeFileSync(join(main, "src/cart.ts"), CART_V1);
  const id = ["-c", "user.name=weft-demo", "-c", "user.email=demo@example.invalid"];
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  git(main, ["add", "-A"]);
  git(main, [...id, "commit", "-qm", "sample shop"]);
  const wa = join(base, "shop-agent-a");
  const wb = join(base, "shop-agent-b");
  git(main, ["worktree", "add", "-q", wa, "-b", "agent-a"]);
  git(main, ["worktree", "add", "-q", wb, "-b", "agent-b"]);
  for (const w of [wa, wb]) {
    git(w, ["config", "user.name", basename(w)]);
    git(w, ["config", "user.email", "demo@example.invalid"]);
  }
  return { main, wa, wb };
}

/** Run the adapter's hook command the way Claude Code does: JSON on stdin, JSON on stdout. */
export function runHook(dir, payload) {
  // Async (not spawnSync) so an in-process gateway, e.g. in tests, keeps serving meanwhile.
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [BUNDLE, "hook"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", fail);
    child.on("close", (code) => {
      if (code !== 0 && !out) return fail(new QuickstartError(`adapter hook exited ${code}: ${err.slice(0, 500)}`));
      try {
        done(out.trim() ? JSON.parse(out) : undefined);
      } catch {
        fail(new QuickstartError(`adapter hook printed non-JSON: ${out.slice(0, 200)}`));
      }
    });
    child.stdin.end(JSON.stringify({ cwd: dir, ...payload }));
  });
}

/** One Claude Code Edit: PreToolUse (may deny); if allowed, apply it and send PostToolUse. */
export async function claudeEdit(dir, session, id, rel, oldS, newS) {
  const tool_input = { file_path: join(dir, rel), old_string: oldS, new_string: newS };
  const pre = await runHook(dir, { hook_event_name: "PreToolUse", session_id: session, tool_name: "Edit", tool_use_id: id, tool_input });
  const deny = pre?.hookSpecificOutput?.permissionDecision === "deny" ? pre.hookSpecificOutput.permissionDecisionReason : undefined;
  if (deny) return { denied: true, reason: deny };
  const path = join(dir, rel);
  const text = readFileSync(path, "utf8");
  if (!text.includes(oldS)) throw new QuickstartError(`demo: ${rel} in ${dir} does not contain the expected text`);
  writeFileSync(path, text.replace(oldS, newS));
  const post = await runHook(dir, { hook_event_name: "PostToolUse", session_id: session, tool_name: "Edit", tool_use_id: id, tool_input, tool_response: {} });
  return { denied: false, context: post?.hookSpecificOutput?.additionalContext };
}

/** The diagnostic headline(s) and quoted diff lines of a deny reason, indented. */
const excerpt = (s, code) =>
  s
    .split("\n")
    .filter((l) => l.includes(`[weft error] ${code}`) || /^\s+[-+](?![-+])/.test(l))
    .map((l) => `    ${l.trim()}`)
    .join("\n");

export async function demo({ url, dir }, log = console.log) {
  const api = client(url);
  await api.health(); // fail before creating anything
  const base = dir ? resolve(dir) : mkdtempSync(join(tmpdir(), "weft-demo-"));
  if (existsSync(join(base, "shop"))) throw new QuickstartError(`${join(base, "shop")} already exists; pass a new --dir (or omit it for a temp dir)`);
  mkdirSync(base, { recursive: true });
  const { main, wa, wb } = makeSampleRepo(base);
  log(`sample repo ${main} with worktrees ${basename(wa)} (agent-a) and ${basename(wb)} (agent-b)`);
  const repo = `demo-${Date.now().toString(36)}`;
  const res = await setup(
    { url, repo, dirs: [wa, wb], tasks: [{ id: "T-1", title: "Add tax options to calcTotal" }, { id: "T-2", title: "Show the cart total" }] },
    api,
    log,
  );
  const [A, B] = res.agents;
  const checks = [];

  log("\n1) stale_assumption: agent-b starts, agent-a changes calcTotal's signature, agent-b calls the old one");
  await runHook(wb, { hook_event_name: "SessionStart", session_id: "demo-b", source: "startup" });
  await runHook(wa, { hook_event_name: "SessionStart", session_id: "demo-a", source: "startup" });
  const a1 = await claudeEdit(wa, "demo-a", "a1", "src/pricing.ts", SIG_OLD, SIG_NEW);
  log(`   agent-a edit src/pricing.ts: ${a1.denied ? "DENIED (unexpected)" : "allowed"}`);
  const b1 = await claudeEdit(wb, "demo-b", "b1", "src/cart.ts", "return `${items.length} items`;", "return `${items.length} items, total ${calcTotal(items)}`;");
  log(`   agent-b edit src/cart.ts: ${b1.denied ? "DENIED" : "allowed (unexpected)"}`);
  if (b1.denied) log(excerpt(b1.reason, "stale_assumption"));
  checks.push(["agent-b's stale call is denied with stale_assumption", b1.denied && /stale_assumption/.test(b1.reason)]);

  log("\n2) stale_overwrite: agent-a's change is merged and landed; agent-b edits calcTotal from its old base");
  git(wa, ["add", "-A"]);
  git(wa, ["commit", "-qm", "calcTotal takes PriceOptions"]);
  git(main, ["merge", "-q", "--ff-only", "agent-a"]);
  const sha = git(main, ["rev-parse", "HEAD"]);
  const landed = await land({ url, repo, change: A.change, sha }, api);
  log(`   land #${landed.record?.seq ?? landed.seq ?? "?"} posted for ${A.change.slice(0, 12)}… (${landed.record?.status ?? landed.status ?? "?"})`);
  const body = "  return items.reduce((s, i) => s + i.price * i.qty, 0);";
  const b2 = await claudeEdit(wb, "demo-b", "b2", "src/pricing.ts", body, "  return Math.round(items.reduce((s, i) => s + i.price * i.qty, 0));");
  log(`   agent-b edit src/pricing.ts: ${b2.denied ? "DENIED" : "allowed (unexpected)"}`);
  if (b2.denied) log(excerpt(b2.reason, "stale_overwrite"));
  checks.push(["agent-b's overwrite of landed code is denied with stale_overwrite", b2.denied && /stale_overwrite/.test(b2.reason)]);

  log(`\nresult (repo ${repo}, event log: ${url}/v1/repos/${repo}/events with the system token):`);
  for (const [name, ok] of checks) log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  log(`\nThe worktrees stay installed: open \`claude\` in ${wa} or ${wb} to keep going.`);
  return { ok: checks.every(([, ok]) => ok), repo, base, ...res };
}

// ---------------------------------------------------------------- CLI

const USAGE = `usage:
  node scripts/local-quickstart.mjs [--url URL] [--repo NAME] [--agents a,b] <checkout> [<checkout> ...]
      create the repo (default: the git repo's directory name), mint one agent token per checkout
      plus a system token, install the Claude Code adapter in each checkout
  node scripts/local-quickstart.mjs --demo [--url URL] [--dir DIR]
      also create a sample repo with two worktrees and show both collisions without an LLM
  node scripts/local-quickstart.mjs land --repo NAME --change CHANGE_ID --sha SHA [--url URL]
      post a land event (what the merge queue does in the hosted stack)

URL defaults to $WEFT_URL or http://localhost:8787. Start the gateway first: cd apps/gateway && pnpm dev:local`;

async function main(argv) {
  if (argv[0] === "land") {
    const rest = argv.slice(1);
    const get = (n) => {
      const i = rest.indexOf(`--${n}`);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const url = (get("url") ?? process.env.WEFT_URL ?? "http://localhost:8787").replace(/\/+$/, "");
    const [repo, change, sha] = [get("repo"), get("change"), get("sha")];
    if (!repo || !change || !sha) throw new QuickstartError(`land needs --repo, --change and --sha\n${USAGE}`);
    if (!existsSync(systemTokenPath(repo))) throw new QuickstartError(`no system token for ${repo} at ${systemTokenPath(repo)}; run the quickstart for that repo first`);
    const r = await land({ url, repo, change, sha });
    const rec = r.record ?? r;
    console.log(`land #${rec.seq} ${rec.status}${rec.diagnostics?.length ? `: ${rec.diagnostics.map((d) => d.code).join(", ")}` : ""}`);
    return rec.status === "accepted" ? 0 : 1;
  }
  const o = parseArgs(argv);
  if (o.help) {
    console.log(USAGE);
    return 0;
  }
  if (o.demo) {
    const r = await demo(o);
    return r.ok ? 0 : 1;
  }
  if (!o.dirs.length) {
    console.error(USAGE);
    return 2;
  }
  const r = await setup(o);
  console.log(nextSteps({ url: o.url, ...r }));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err) => {
      console.error(err instanceof QuickstartError ? `weft quickstart: ${err.message}` : err);
      process.exitCode = 1;
    },
  );
}
