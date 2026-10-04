#!/usr/bin/env node
// M2: the full design §8 demo, end to end on the deployed preview stack.
// Scenario and beats: demo/scenarios/full.md. One-command launcher: demo/run-full.sh.
//
//   6 tasks × 3 candidates = 18 live agents (Claude Code, Codex, OpenCode: one of each per task),
//   each in its own checkout of its own Artifacts fork, all on ONE coordinator (repo weft-demo):
//
//   t1 Session expiry     createSession(userId) -> createSession(userId, opts)      (risk medium)
//   t2 Signup endpoint    plans against the old createSession, implements after t1's change:
//                         live stale_assumption squiggle -> reroutes to the new signature
//   t3 Session refresh    same collision, but its product rule forbids adapting: proposes an
//                         overload to the t1 agent it collided with; t1 accepts and adds it
//   t4 Bulk discount      calcTotal  } adjacent one-liners in src/pricing.ts: plain git conflicts,
//   t5 Free shipping      shippingFee} the land rebase merges them structurally (Mergiraf)
//   t6 Kiwi on pricing    storefront change: preview + screenshots + review per candidate,
//                         a human compares and approves one                     (risk medium)
//
//   Every push -> ProcessRevision (rebase, tests, preview, screenshots, risk, review) ->
//   BestOfN per task (rank; human approval where risk/review asks) -> LandChange (submit queue,
//   CAS push) -> Workers Builds redeploys weft-demo. Then a planted bug lands -> Tail errors ->
//   auto-revert from the op log -> task reopened with the stack trace (B13 live.mjs prove).
//
// Usage: node demo/m2-full.mjs [--run N] [--out demo/evidence/m2] [--only t1,t2,...] [--skip-revert]
// Env: WEFT_URL (preview gateway), WEFT_WORKFLOWS_URL, WEFT_M2_OPENCODE_MODEL.
// Tokens come from ~/.config/weft (mode 600) or are minted per run; none is printed.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const GW = (process.env.WEFT_URL ?? "https://weft-gateway-preview.elier.ai").replace(/\/+$/, "");
const WF = (process.env.WEFT_WORKFLOWS_URL ?? "https://weft-workflows-preview.elier.ai").replace(/\/+$/, "");
const ACCOUNT = "2d659dee148763a8d64c80135da7165d";
const REPO = "weft-demo";
const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
const RUN = Number(opt("run", "1"));
const OUT = resolve(ROOT, opt("out", "demo/evidence/m2"), `run-${RUN}`);
const ONLY = opt("only", "t1,t2,t3,t4,t5,t6").split(",");
const SKIP_REVERT = argv.includes("--skip-revert");
const OC_MODEL = process.env.WEFT_M2_OPENCODE_MODEL ?? "opencode/big-pickle";
const TURN_TIMEOUT_MS = 15 * 60_000;
const cfg = (f) => readFileSync(join(homedir(), ".config/weft", f), "utf8").trim();
const ADMIN = cfg("preview-admin-token");
const SYS = cfg("preview-workflows-system-token");
const WFTOK = cfg("preview-workflows-token");
const HUMAN = JSON.parse(cfg("web-preview-token.json")).token; // principal john, observe+human (the web UI's token)
const BUNDLES = {
  claude: join(ROOT, "packages/adapters/claude-code/dist/weft-claude.mjs"),
  codex: join(ROOT, "packages/adapters/codex/dist/weft-codex.mjs"),
  opencode: join(ROOT, "packages/adapters/opencode/dist/weft-opencode.mjs"),
};
const HARNESSES = ["claude", "codex", "opencode"];

const scrub = (s) =>
  String(s)
    .replace(/art_v1_[0-9a-f]+(\?expires=\d+)?/g, "art_v1_***")
    .replace(/wcp_[A-Za-z0-9_-]+/g, "wcp_***")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***");
const T0 = Date.now();
const secs = () => +((Date.now() - T0) / 1000 + (globalThis.__m2_offset ?? 0)).toFixed(1);
const log = (...a) => console.log(`[m2 run-${RUN} +${secs()}s]`, ...a.map((x) => scrub(typeof x === "string" ? x : JSON.stringify(x))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { run: RUN, started_at: new Date().toISOString(), gateway: GW, workflows: WF, repo: REPO, marks: {}, steps: [] };
const mark = (k) => {
  out.marks[k] ??= secs();
  log(`mark ${k}`);
};
const step = (name, data) => {
  out.steps.push({ name, at_s: secs(), ...data });
  log(name, data);
};
const save = () => writeFileSync(join(OUT, "run.json"), scrub(JSON.stringify(out, null, 2)) + "\n");

// ------------------------------------------------------------------------------ HTTP

async function api(method, path, token, body, expect) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(`${GW}${path}`, { method, headers: { authorization: `Bearer ${token}`, "wcp-version": "0.1", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (err) {
      if (attempt < 4) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw err;
    }
    const t = await r.text();
    if (r.status >= 500 && attempt < 3 && method === "GET") {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (expect && ![].concat(expect).includes(r.status)) throw new Error(`${method} ${path} -> ${r.status}: ${scrub(t).slice(0, 600)}`);
    return t ? JSON.parse(t) : {};
  }
}
async function wf(kind, id, method = "GET", body) {
  const r = await fetch(`${WF}/v1/workflows/${kind}/${id}${body ? "/events" : ""}`, { method, headers: { authorization: `Bearer ${WFTOK}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return r.json();
}
let cfRefreshed = 0;
/** wrangler's OAuth access token lives about an hour; `wrangler whoami` refreshes it. */
function refreshCf(force = false) {
  if (!force && Date.now() - cfRefreshed < 5 * 60_000) return;
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  spawnSync("npx", ["wrangler", "whoami"], { cwd: join(ROOT, "apps/gateway"), env, stdio: "ignore", timeout: 60_000 });
  cfRefreshed = Date.now();
}
function cfToken() {
  refreshCf();
  return /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(join(homedir(), "Library/Preferences/.wrangler/config/default.toml"), "utf8"))[1];
}
async function cf(method, path, body, retried = false) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, { method, headers: { authorization: `Bearer ${cfToken()}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json();
  if (!j.success && !retried && (j.errors ?? []).some((e) => e.code === 10000 || e.code === 9109)) {
    refreshCf(true);
    return cf(method, path, body, true);
  }
  if (!j.success) throw new Error(`CF ${method} ${path}: ${JSON.stringify(j.errors)}`);
  return j.result;
}

// ------------------------------------------------------------------------------ git

const GIT_ID = { GIT_AUTHOR_NAME: "weft-m2", GIT_AUTHOR_EMAIL: "m2@agents.weft.invalid", GIT_COMMITTER_NAME: "weft-m2", GIT_COMMITTER_EMAIL: "m2@agents.weft.invalid" };
function git(args, { cwd, token, allowFail } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...GIT_ID };
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` });
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ").slice(0, 80)}: ${scrub(r.stderr)}`);
  return allowFail ? { code: r.status, out: (r.stdout ?? "").trim(), err: scrub(r.stderr ?? "") } : r.stdout.trim();
}
function listFiles(dir, base = dir) {
  const acc = [];
  for (const e of readdirSync(dir)) {
    if (e === ".git" || e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) acc.push(...listFiles(p, base));
    else acc.push(relative(base, p));
  }
  return acc;
}
const tryRun = (cmd, args, cwd, timeout = 180_000) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

// ------------------------------------------------------------------------------ the tasks

const WEFT_CLI = ".weft/bin/weft";
const COORD =
  "This checkout is coordinated by Weft with other agents working on the same codebase at the same time. If a Weft hook blocks an edit or reports a conflict, read its diagnostic and follow it. ";
const PROMPT_T1 =
  "Task (session expiry): sessions must expire. In src/auth/session.ts add `export type SessionOptions = { ttlMs: number }`, add `expiresAt: number` to Session, " +
  "change createSession to `createSession(userId: string, opts: SessionOptions): Session` (expiresAt = createdAt + opts.ttlMs), and make getSession return undefined " +
  "(and forget the session) once Date.now() >= expiresAt. Update the existing caller in src/api/routes.ts to pass `{ ttlMs: 60 * 60 * 1000 }`, and update " +
  "test/session.test.ts for the new signature with one extra test for expiry. Only touch those three files. Run `node --test`, then reply with a one-line summary. " +
  COORD +
  "Weft may relay requests from other agents; treat a reasonable request that is compatible with your task in good faith.";
const PROMPT_T1_RESUME = "Continue: handle anything Weft reports for you (including requests from other agents), then reply with a one-line summary.";
const PROMPT_T2_PLAN =
  "Task (signup): add `POST /api/signup` taking a JSON body {email, name, password}. It registers the user with createUser from src/auth/users.ts and signs them in " +
  "right away by starting a session the same way login in src/api/routes.ts does, responding 201 with {token, user: publicUser(user)}; a UserError becomes 400 {error}. " +
  "Add the route to the accountRoutes array in src/api/account.ts and add test/signup.test.ts. For now ONLY read the relevant files and reply with a short plan that " +
  "includes the exact code you will write. Do not edit any file yet.";
const PROMPT_T2_IMPL =
  "Implement your plan now. " +
  COORD +
  "Another agent's change will be merged before yours but is not in your checkout yet, so code written against it may not typecheck here; that is expected. " +
  "Run `node --test`, then reply with what you changed and anything that differed from your plan.";
const PROMPT_T3_PLAN =
  "Task (session refresh): add a new file src/auth/refresh.ts exporting `refreshSession(token: string): Session | undefined`. It looks up the live session with " +
  "getSession, returns undefined if there is none, otherwise revokes it with revokeSession and starts a fresh session for the same user with createSession from " +
  "src/auth/session.ts (start it exactly the way login in src/api/routes.ts does), returning the new session. Add test/refresh.test.ts (node:test, like " +
  "test/session.test.ts). Only create those two files. For now ONLY read the relevant files and reply with a short plan that includes the exact code you will " +
  "write. Do not create or edit any file yet.";
const PROMPT_T3_IMPL =
  "Implement your plan now. Product rule for this task: refreshed sessions use the platform's default lifetime, so refreshSession must call createSession with the " +
  "user id only; it must not choose session options itself. " +
  COORD +
  "If Weft blocks an edit because another agent changed an API you call, do not adapt your call to their new API: negotiate with that agent instead, proposing that " +
  `they keep the old call working as an overload, with \`${WEFT_CLI} negotiate propose overload "<what you need>" --wait 120\` (run \`${WEFT_CLI} inbox --wait 120\` ` +
  "if no reply came yet). Once they accept, continue with the old call. Only if they reject, adapt. The other agent's change will be merged before yours but is " +
  "not in your checkout, so typecheck errors about it here are expected. Run `node --test`, then reply with what you changed and how the negotiation went.";
const PROMPT_T4 =
  "Task (bulk discount): in src/pricing.ts change ONLY calcTotal: when the cart holds 10 or more units in total (sum of qty), the total gets 10% off. Keep its name " +
  "and signature. Do not touch shippingFee or any other function, and do not edit test/shop.test.ts. Add test/discount.test.ts (node:test) covering both cases, using " +
  "carts that total under $50. Run `node --test`, then reply with a one-line summary. " +
  COORD;
const PROMPT_T5 =
  "Task (free shipping): in src/pricing.ts change ONLY shippingFee: shipping is free (0) when calcTotal(items) is $50 or more, otherwise unchanged. Keep its name and " +
  "signature. Do not touch calcTotal or any other function, and do not edit test/shop.test.ts. Add test/shipping.test.ts (node:test) covering both cases, using carts " +
  "with fewer than 10 units. Run `node --test`, then reply with a one-line summary. " +
  COORD;
const PROMPT_T6 =
  "Task (pricing page): we now sell kiwi at $4.00 per kg. Add `kiwi: 4` to PRICES in src/catalog.ts and add a Kiwi row to the price table in public/pricing.html, " +
  "matching the existing rows. The home page must not change. Run `node --test`, then reply with a one-line summary. " +
  COORD;

const TASKS = [
  { key: "t1", title: "Session expiry", priority: 1, risk: "medium", prompt: PROMPT_T1, acceptance: ["createSession(userId, opts) sets expiresAt = createdAt + opts.ttlMs", "getSession returns undefined once a session expired", "login passes a one-hour ttl", "tests pass"] },
  { key: "t2", title: "Signup endpoint", priority: 0, risk: "low", plan: PROMPT_T2_PLAN, prompt: PROMPT_T2_IMPL, acceptance: ["POST /api/signup creates the user and returns 201 {token, user}", "a UserError becomes 400 {error}", "test/signup.test.ts covers it and tests pass"] },
  { key: "t3", title: "Session refresh", priority: 0, risk: "low", plan: PROMPT_T3_PLAN, prompt: PROMPT_T3_IMPL, acceptance: ["src/auth/refresh.ts exports refreshSession(token)", "an unknown token returns undefined", "a live session is revoked and replaced for the same user", "tests pass"] },
  { key: "t4", title: "Bulk discount", priority: 0, risk: "low", prompt: PROMPT_T4, acceptance: ["calcTotal gives 10% off for 10 or more units", "shippingFee is unchanged", "tests pass"] },
  { key: "t5", title: "Free shipping over $50", priority: 0, risk: "low", prompt: PROMPT_T5, acceptance: ["shippingFee is 0 when calcTotal(items) >= 50", "calcTotal is unchanged", "tests pass"] },
  { key: "t6", title: "Kiwi on the pricing page", priority: 0, risk: "medium", prompt: PROMPT_T6, acceptance: ["The pricing page lists kiwi at $4.00 per kg", "The home page is unchanged", "The catalog has a kiwi price and tests pass"] },
].filter((t) => ONLY.includes(t.key));

const REPO_CONFIG = { tests: { command: ["node", "--test"], timeout_s: 300 }, resolver: { kind: "llm", model: "@cf/qwen/qwen2.5-coder-32b-instruct" }, layers: ["git", "mergiraf", "resolver"], job_timeout_s: 900 };

// ------------------------------------------------------------------------------ harnesses

/** Spawn a harness turn; resolves with exit code + parsed stdout lines. */
function harness(cmd, args, cwd, outFile, env) {
  return new Promise((res) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env: { ...env, PWD: cwd }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGTERM"), TURN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(outFile, scrub(stdout));
      if (stderr.trim()) writeFileSync(outFile.replace(/\.jsonl$/, ".stderr.txt"), scrub(stderr));
      const lines = stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { raw: l };
          }
        });
      res({ code, lines, ms: Date.now() - started });
    });
  });
}
const CLAUDE_TOOLS = (dir) => `Read,Edit,Write,MultiEdit,Glob,Grep,Bash(node --test:*),Bash(git status:*),Bash(git diff:*),Bash(${dir}/${WEFT_CLI}:*),Bash(${WEFT_CLI}:*)`;

class Agent {
  constructor(task, harnessName, cand) {
    Object.assign(this, { task, harness: harnessName, cand, id: cand.agent, turns: [], session: undefined });
    this.dir = join(WORK, this.id);
    this.ev = join(OUT, "agents", this.id);
    mkdirSync(this.ev, { recursive: true });
  }
  env() {
    const e = { ...process.env, WEFT_HOOK_TRACE: "1" };
    delete e.WEFT_TOKEN;
    if (this.harness === "claude") delete e.OPENROUTER_API_KEY;
    if (this.harness === "opencode") {
      // Concurrent `opencode serve` processes lock each other's SQLite store ("database is
      // locked"): give each agent its own data dir, seeded with the user's opencode auth.
      const data = join(WORK, `.xdg-${this.id}`);
      if (!existsSync(join(data, "opencode"))) {
        mkdirSync(join(data, "opencode"), { recursive: true });
        const auth = join(homedir(), ".local/share/opencode/auth.json");
        if (existsSync(auth)) cpSync(auth, join(data, "opencode/auth.json"));
      }
      e.XDG_DATA_HOME = data;
    }
    return e;
  }
  async turn(name, prompt) {
    const f = join(this.ev, `${this.turns.length + 1}-${name}.jsonl`);
    writeFileSync(f.replace(/\.jsonl$/, ".prompt.txt"), `${this.harness}${this.session ? ` (resume ${this.session})` : ""}\n\n${prompt}\n`);
    let r;
    if (this.harness === "claude") {
      const args = ["-p", "--verbose", "--output-format", "stream-json", "--include-hook-events", "--setting-sources", "project,local", "--permission-mode", "acceptEdits", "--allowedTools", CLAUDE_TOOLS(this.dir)];
      if (this.session) args.push("--resume", this.session);
      r = await harness("claude", [...args, "--", prompt], this.dir, f, this.env());
      this.session ??= r.lines.find((l) => l.session_id)?.session_id;
    } else if (this.harness === "codex") {
      const common = ["--json", "--dangerously-bypass-hook-trust", "-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=true"];
      r = await harness("codex", this.session ? ["exec", "resume", ...common, this.session, prompt] : ["exec", ...common, "--cd", this.dir, prompt], this.dir, f, this.env());
      this.session ??= r.lines.find((l) => l.thread_id)?.thread_id;
    } else {
      if (!this.server) await this.startServer();
      r = await harness("opencode", ["run", "--attach", this.server.url, "--dir", this.dir, "-m", OC_MODEL, "--format", "json", "--auto", ...(this.session ? ["--session", this.session] : []), prompt], this.dir, f, this.env());
      this.session ??= r.lines.find((l) => l.sessionID)?.sessionID ?? r.lines.find((l) => l.part?.sessionID)?.part?.sessionID;
      if (this.session) await this.settle();
    }
    const failure =
      r.lines.find((l) => l.type === "turn.failed")?.error?.message ??
      r.lines.find((l) => l.type === "error")?.error?.data?.message ??
      (r.lines.find((l) => l.type === "result" && l.is_error) ? r.lines.find((l) => l.type === "result").result : undefined);
    this.turns.push({ name, code: r.code, ms: r.ms, ...(failure ? { failure: String(failure).slice(0, 300) } : {}) });
    return r;
  }
  async startServer() {
    const port = 4300 + Math.floor(Math.random() * 1500);
    const child = spawn("opencode", ["serve", "--port", String(port)], { cwd: this.dir, env: { ...this.env(), PWD: this.dir }, stdio: ["ignore", "pipe", "pipe"] });
    let o = "";
    child.stdout.on("data", (c) => (o += c));
    child.stderr.on("data", (c) => (o += c));
    child.on("close", () => writeFileSync(join(this.ev, "opencode-serve.log"), scrub(o)));
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) {
      if (await fetch(`${url}/config`).then((x) => x.ok, () => false)) break;
      await sleep(500);
    }
    this.server = { child, url };
  }
  /** OpenCode: stop-gate continuations run after `run --attach` exits; wait until idle for good. */
  async settle(quietMs = 20_000, maxMs = 8 * 60_000) {
    const p = join(this.dir, ".weft/log/hooks.jsonl");
    const size = () => (existsSync(p) ? readFileSync(p, "utf8").length : 0);
    const busy = async () => {
      try {
        const st = await (await fetch(`${this.server.url}/session/status`)).json();
        return st?.[this.session]?.type === "busy" || st?.[this.session]?.type === "retry";
      } catch {
        return false;
      }
    };
    const end = Date.now() + maxMs;
    let last = size();
    let since = Date.now();
    while (Date.now() < end) {
      await sleep(2000);
      const now = size();
      if (now !== last || (await busy())) {
        last = now;
        since = Date.now();
      } else if (Date.now() - since > quietMs) return;
    }
  }
  stop() {
    if (this.server) this.server.child.kill("SIGTERM");
  }
  /** Commit through the adapter's git hooks (trailers + pre-commit gate) and push to the fork. */
  commitAndPush() {
    git(["add", "-A"], { cwd: this.dir });
    if (!git(["status", "--porcelain"], { cwd: this.dir })) return (this.push = { ok: false, reason: "no changes" });
    const c = git(["commit", "-qm", `${this.task.title} (${this.id})`], { cwd: this.dir, allowFail: true });
    if (c.code !== 0) return (this.push = { ok: false, reason: "commit refused", detail: c.err.slice(0, 800) });
    const sha = git(["rev-parse", "HEAD"], { cwd: this.dir });
    const p = git(["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: this.dir, token: this.cand.token.plaintext, allowFail: true });
    if (p.code !== 0) return (this.push = { ok: false, reason: "push failed", detail: p.err.slice(0, 400) });
    this.push = { ok: true, sha, at_s: secs(), at_ms: Date.now(), trailers: git(["log", "-1", "--format=%(trailers:only)"], { cwd: this.dir }) };
    return this.push;
  }
}

// ------------------------------------------------------------------------------ main

let WORK;

async function preflight() {
  const ok = await fetch(`${GW}/v1/health`).then((r) => r.status, (e) => String(e));
  if (ok !== 200) throw new Error(`gateway ${GW} health: ${ok}`);
  const st = JSON.parse(tryRun("claude", ["auth", "status", "--json"], ROOT).out || "{}");
  if (!st.loggedIn && !process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY)
    throw new Error("claude is not authenticated: run `claude /login`, or set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY");
  const cx = tryRun("codex", ["login", "status"], ROOT);
  if (!/Logged in/.test(cx.out)) throw new Error(`codex is not logged in: ${cx.out.trim()}`);
  if (tryRun("opencode", ["--version"], ROOT).code !== 0) throw new Error("opencode is not installed");
  for (const b of Object.values(BUNDLES)) execFileSync(process.execPath, [join(dirname(dirname(b)), "scripts/build.mjs")], { stdio: "ignore" });
  step("preflight", { gateway: ok, claude: st.loggedIn ? "logged in" : process.env.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY", codex: cx.out.trim().split("\n")[0], opencode_model: OC_MODEL });
}

/** Reset trunk to the M2 seed: target-app + shop + storefront; keeps the deployed Worker files. */
async function seedTrunk() {
  await api("POST", "/v1/admin/repos", ADMIN, { repo: REPO }, [200, 201]);
  await api("POST", "/v1/admin/artifacts/repos", ADMIN, { repo: REPO, trunk: "weft-demo", config: REPO_CONFIG }, [200, 201]);
  const tt = await api("POST", `/v1/repos/${REPO}/system/trunk-token`, SYS, { ttl: 900 }, 201);
  const d = mkdtempSync(join(tmpdir(), "weft-m2-seed-"));
  git(["clone", "-q", tt.remote, d], { token: tt.token.plaintext });
  const before = git(["rev-parse", "HEAD"], { cwd: d });
  const keep = new Set(["src/worker.ts", "wrangler.jsonc"]);
  for (const f of listFiles(d)) if (!keep.has(f)) rmSync(join(d, f));
  cpSync(join(ROOT, "demo/target-app/src"), join(d, "src"), { recursive: true });
  cpSync(join(ROOT, "demo/target-app/test"), join(d, "test"), { recursive: true });
  cpSync(join(ROOT, "demo/m2-seed"), d, { recursive: true });
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "weft-demo", private: true, type: "module", scripts: { test: "node --test", typecheck: "tsc -p ." } }, null, 2) + "\n");
  let base = before;
  if (git(["status", "--porcelain"], { cwd: d })) {
    git(["add", "-A"], { cwd: d });
    git(["commit", "-qm", `demo: M2 seed (run ${RUN})`], { cwd: d });
    git(["push", "-q", `--force-with-lease=refs/heads/main:${before}`, "origin", "HEAD:refs/heads/main"], { cwd: d, token: tt.token.plaintext });
    base = git(["rev-parse", "HEAD"], { cwd: d });
  }
  const seedChecks = { test: tryRun(process.execPath, ["--test"], d).code };
  rmSync(d, { recursive: true, force: true });
  step("trunk seeded", { before, base, seed_tests_exit: seedChecks.test });
  return base;
}

async function createCandidates(stamp) {
  const queue = (await cf("GET", "/queues?per_page=100")).find((x) => x.queue_name === "weft-artifacts-events-preview");
  const agents = [];
  for (const t of TASKS) {
    t.id = `m2-${stamp}-${t.key}`;
    const names = HARNESSES.map((h) => `${h}-${t.key}-r${RUN}`); // run-unique: agent -> change lookups never cross runs
    const created = await api("POST", `/v1/repos/${REPO}/tasks/${t.id}/candidates`, SYS, { count: 3, agents: names, title: t.title, acceptance: t.acceptance, ttl: 7200 }, 201);
    for (const [i, c] of created.candidates.entries()) {
      if (c.subscription.status !== "active") {
        const sub = await cf("POST", "/event_subscriptions/subscriptions", { name: `weft-${c.fork.namespace}-${c.fork.name}`.slice(0, 100), enabled: true, source: { type: "artifacts.repo", namespace: c.fork.namespace, repo_name: c.fork.name }, destination: { type: "queues.queue", queue_id: queue.queue_id }, events: ["pushed"] });
        await api("POST", "/v1/admin/artifacts/subscriptions", ADMIN, { change: c.change, subscription_id: sub.id }, 200);
        SUBS.push(sub.id);
      }
      agents.push(new Agent(t, HARNESSES[i], c));
    }
  }
  step("tasks + candidates", { tasks: TASKS.map((t) => ({ task: t.id, title: t.title, risk: t.risk })), candidates: agents.map((a) => ({ agent: a.id, change: a.cand.change, fork: a.cand.fork.name })) });
  return agents;
}
const SUBS = [];

async function prepare(a) {
  git(["clone", "-q", a.cand.fork.remote, a.dir], { token: a.cand.token.plaintext });
  for (const [k, v] of Object.entries({ "user.name": a.id, "user.email": `${a.id}@agents.weft.invalid` })) git(["config", k, v], { cwd: a.dir });
  const tok = (await api("POST", "/v1/admin/tokens", ADMIN, { principal: a.id, scopes: ["agent", "observe"], repos: [REPO], agent: a.id, label: `m2 run ${RUN}` }, 201)).token;
  a.wcp = tok;
  execFileSync(process.execPath, [BUNDLES[a.harness], "install", "--url", GW, "--repo", REPO, "--agent", a.id, "--task", a.task.id, "--title", a.task.title, "--priority", String(a.task.priority), "--change", a.cand.change], {
    cwd: a.dir,
    env: { ...process.env, WEFT_TOKEN: tok },
    stdio: "ignore",
  });
}

const events = async (after = 0) => {
  const all = [];
  for (;;) {
    const p = await api("GET", `/v1/repos/${REPO}/events?after=${after}&limit=500`, SYS, undefined, 200);
    all.push(...p.events);
    if (!p.has_more) return all;
    after = p.next_after;
  }
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  await preflight();
  const stamp = Date.now().toString(36);
  WORK = realpathSync(mkdtempSync(join(tmpdir(), `weft-m2-${stamp}-`)));
  await seedTrunk();
  const head0 = (await api("GET", `/v1/repos/${REPO}/events?tail=true&limit=1`, SYS, undefined, 200)).head_seq;
  out.first_seq = head0 + 1;
  mark("seeded");
  const agents = await createCandidates(stamp);
  await Promise.all(agents.map(prepare));
  mark("agents_ready");
  const by = (k) => agents.filter((a) => a.task.key === k);
  const done = {};
  const finish = (a) => {
    const p = a.commitAndPush();
    step(`pushed ${a.id}`, p.ok ? { sha: p.sha } : p);
    a.stop();
  };

  // Phase A: t4/t5/t6 work straight away; t2/t3 read + plan (pins their base before t1's change)
  const independent = ["t4", "t5", "t6"].flatMap(by).map((a) => a.turn("work", a.task.prompt).then(() => finish(a)));
  const planners = ["t2", "t3"].flatMap(by);
  const planned = {};
  const plans = planners.map((a) => a.turn("plan", a.task.plan).then(() => (planned[a.id] = true)));
  for (let i = 0; i < 300 && planners.length; i++) {
    const joined = new Set((await events(head0)).filter((e) => e.kind === "join").map((e) => e.agent));
    if (planners.every((a) => joined.has(a.id) || planned[a.id])) break;
    await sleep(2000);
  }
  mark("planners_joined");

  // Phase B: t1 changes createSession's signature (three alternatives, §7.7: no conflicts among them)
  const t1 = by("t1");
  const t1first = t1.map((a) => a.turn("work", a.task.prompt).then(() => (done[a.id] = true)));
  let sigSeq;
  for (let i = 0; i < 900 && t1.length; i++) {
    sigSeq = (await events(head0)).find((e) => e.kind === "edit" && e.status === "accepted" && t1.some((a) => a.id === e.agent) && (e.writes ?? []).some((w) => w.key === "src/auth/session.ts#createSession" && w.kind === "signature"))?.seq;
    if (sigSeq || t1.every((a) => done[a.id])) break;
    await sleep(1000);
  }
  mark("t1_signature_accepted");
  step("t1 signature change", { seq: sigSeq ?? null });
  await Promise.all(plans);
  mark("plans_done");

  // Phase C: t2/t3 implement (resumed conversations). A negotiation watcher resumes an idle t1
  // agent when a proposal reaches it, so the asker's `--wait` gets an answer.
  let implementing = true;
  const resumed = new Map();
  const watcher = (async () => {
    while (implementing || [...resumed.values()].some((p) => p.pending)) {
      const ev = await events(head0).catch(() => []);
      for (const p of ev.filter((e) => e.kind === "negotiate.propose" && e.status === "accepted")) {
        const to = p.payload?.to ?? {};
        const owner = t1.find((a) => (to.change ? a.cand.change === to.change : a.id === to.agent));
        if (!owner || resumed.has(`${owner.id}#${p.seq}`)) continue;
        const answered = ev.some((r) => ["negotiate.accept", "negotiate.reject", "negotiate.counter"].includes(r.kind) && r.payload?.reply_to === p.seq);
        if (answered) continue;
        if (!done[owner.id]) continue; // still running: the proposal is injected at its next hook
        const job = { pending: true };
        resumed.set(`${owner.id}#${p.seq}`, job);
        done[owner.id] = false;
        step("resume t1 owner for a proposal", { owner: owner.id, proposal_seq: p.seq, from: p.agent });
        owner.turn("resume", PROMPT_T1_RESUME).then(() => {
          done[owner.id] = true;
          job.pending = false;
        });
      }
      await sleep(3000);
    }
  })();
  const impls = planners.map((a) => (a.session ? a.turn("implement", a.task.prompt) : Promise.resolve()).then(() => finish(a)));
  await Promise.all(impls);
  mark("t2_t3_done");
  await Promise.all(t1first);
  implementing = false;
  await watcher;
  for (const a of t1) finish(a);
  mark("t1_done");
  await Promise.all(independent);
  mark("all_agents_done");
  save();
  await finishRun(agents, head0, sigSeq);
}

/**
 * Fallback for a lost Artifacts `pushed` event (seen on the preview account 2026-10-04 from 13:20Z:
 * subscriptions on newly created forks never fired, trunk's kept working). Replays the envelope
 * Artifacts would have sent into the gateway's events queue; every replay is listed in run.json.
 */
let QUEUE_ID;
async function replayPush(a) {
  a.replayed = true;
  QUEUE_ID ??= (await cf("GET", "/queues?per_page=100")).find((x) => x.queue_name === "weft-artifacts-events-preview").queue_id;
  const sha = a.push.sha;
  const before = git(["rev-parse", `${sha}~1`], { cwd: a.dir });
  const commit = { id: sha, message: git(["log", "-1", "--format=%B", sha], { cwd: a.dir }), timestamp: new Date().toISOString(), parents: [before] };
  const envelope = { type: "cf.artifacts.repo.pushed", source: { type: "artifacts.repo", namespace: a.cand.fork.namespace ?? "weft-preview", repoName: a.cand.fork.name }, payload: { ref: "refs/heads/main", before, after: sha, commits: [commit], totalCommitsCount: 1 }, metadata: { accountId: ACCOUNT, eventTimestamp: new Date().toISOString(), x_replayed_by: "m2-full.mjs" } };
  await cf("POST", `/queues/${QUEUE_ID}/messages`, { body: envelope, content_type: "json" });
  (out.push_events_replayed ??= []).push({ agent: a.id, sha, after_push_s: Math.round((Date.now() - (a.push.at_ms ?? Date.now())) / 1000) });
  log(`replayed lost pushed event for ${a.id}`);
}

/** Phases D–G + verdict (also the entry point of `--resume`). */
async function finishRun(agents, head0, sigSeq) {

  // Phase D: evidence for every pushed revision (ProcessRevision on the preview stack)
  const pushed = agents.filter((a) => a.push?.ok);
  const evidence = {};
  void TASKS;
  await Promise.all(
    pushed.map(async (a) => {
      const t = Date.now();
      for (;;) {
        const ch = await api("GET", `/v1/repos/${REPO}/changes/${a.cand.change}`, SYS, undefined, 200);
        const rev = ch.revisions.find((r) => r.sha === a.push.sha);
        if (!rev && !a.replayed && Date.now() - (a.push.at_ms ?? 0) > 90_000) await replayPush(a);
        const rows = ch.evidence.filter((e) => e.sha === a.push.sha);
        // ProcessRevision skips the evidence stages when tests fail (status stays `processed`)
        const done = rows.some((e) => e.kind === "review") || (rev?.status === "processed" && rows.some((e) => e.kind === "test" && e.status === "fail"));
        if ((rev && ["conflict", "failed", "superseded"].includes(rev.status)) || done || Date.now() - t > 20 * 60_000) {
          evidence[a.id] = { revision: rev ? { status: rev.status, layer: rev.layer } : null, rows: rows.map((e) => ({ kind: e.kind, status: e.status, data: summarize(e) })), waited_s: Math.round((Date.now() - t) / 1000) };
          return;
        }
        await sleep(5000);
      }
    }),
  );
  out.evidence = evidence;
  mark("evidence_done");
  save();

  // Phase E: selection + landing per task (t1 first: its signature is what t2/t3 call)
  const selections = {};
  const negotiation = await negotiationSummary(head0, agents);
  out.negotiation = negotiation;
  for (const t of TASKS) {
    const cands = pushed.filter((a) => a.task === t);
    if (!cands.length) {
      selections[t.key] = { status: "no candidates pushed" };
      continue;
    }
    const prior = (out.steps.find((x) => x.name === "select started") ?? {})[t.key];
    let wfId = prior?.workflow;
    if (!wfId) wfId = (await api("POST", `/v1/repos/${REPO}/tasks/${t.id}/select`, SYS, { n: cands.length, risk: t.risk, poll_s: 10, approval_timeout_s: 1800 }, 202)).workflow;
    selections[t.key] = { workflow: wfId, n: cands.length, risk: t.risk, started_at_s: prior?.started_at_s ?? secs() };
    await sleep(2000);
  }
  step("select started", selections);
  await Promise.all(TASKS.map((t) => (selections[t.key].workflow ? settleSelection(t, selections[t.key], pushed, negotiation) : null)));
  out.selections = selections;
  mark("landed");
  save();

  // Phase F: trunk after all landings
  out.trunk = await checkTrunk();
  mark("trunk_checked");
  save();

  // Landing is done: drop this run's per-fork event subscriptions before the planted-bug beat
  // creates its own (fewer live subscriptions on the shared preview queue).
  for (const id of SUBS.splice(0)) await cf("DELETE", `/event_subscriptions/subscriptions/${id}`).catch(() => undefined);

  // Phase G: planted bug -> production errors -> auto-revert (B13)
  if (!SKIP_REVERT) {
    refreshCf(true);
    const r = tryRun(process.execPath, [join(ROOT, "apps/production-signal/scripts/live.mjs"), "prove"], ROOT, 15 * 60_000);
    writeFileSync(join(OUT, "auto-revert.log"), scrub(r.out));
    const proof = join(ROOT, "demo/evidence/b13-auto-revert-live/run.json");
    const pr = existsSync(proof) ? JSON.parse(readFileSync(proof, "utf8")) : null;
    if (pr) writeFileSync(join(OUT, "auto-revert.json"), JSON.stringify(pr, null, 2) + "\n");
    out.auto_revert = { exit: r.code, ...(pr ? { verdict: pr.verdict ?? pr.ok ?? pr.pass ?? null, duration_s: pr.duration_s ?? null, timings: pr.timings ?? null } : {}) };
    mark("auto_revert_done");
  }

  // ------------------------------------------------------------------ evidence + verdict
  const ev = await events(head0);
  const full = [];
  for (const e of ev) full.push(e.has_diff ? await api("GET", `/v1/repos/${REPO}/events/${e.seq}`, SYS, undefined, 200) : e);
  writeFileSync(join(OUT, "coordinator-log.json"), scrub(JSON.stringify({ repo: REPO, first_seq: head0 + 1, events: full }, null, 2)));
  for (const a of agents) {
    for (const f of ["adapter.log", "hooks.jsonl"]) {
      const p = join(a.dir, ".weft/log", f);
      if (existsSync(p)) writeFileSync(join(a.ev, f), scrub(readFileSync(p, "utf8").replaceAll(WORK, "$WORK")));
    }
  }
  out.agents = agents.map((a) => ({ agent: a.id, harness: a.harness, task: a.task.key, change: a.cand.change, turns: a.turns, push: a.push }));
  out.criteria = criteria(full, agents, sigSeq);
  out.pass = Object.values(out.criteria).every((c) => c.ok);
  out.finished_at = new Date().toISOString();
  out.duration_s = secs();
  save();
  for (const id of SUBS) await cf("DELETE", `/event_subscriptions/subscriptions/${id}`).catch(() => undefined);
  await releaseAll(agents);
  log(`${out.pass ? "PASS" : "FAIL"} ${JSON.stringify(Object.fromEntries(Object.entries(out.criteria).map(([k, v]) => [k, v.ok])))}`);
}

/** End of run: release every candidate's claims so the next run starts clean (claims outlive sessions). */
async function releaseAll(agents) {
  for (const a of agents) {
    if (!a.wcp) continue;
    try {
      const hello = { type: "hello", protocol: "wcp/0.1", agent: { id: a.id, harness: "m2-driver" }, capabilities: { level: 0, observe: "async", inject: false, deny_edit: false, refuse_stop: false, commit_gate: false }, task: { id: a.task.id }, change: a.cand.change };
      const w = await api("POST", `/v1/repos/${REPO}/sessions`, a.wcp, hello, 201);
      await api("POST", `/v1/repos/${REPO}/sessions/${w.session}/events`, a.wcp, { type: "submit", mode: "commit", event: { kind: "release", base_seq: w.delivered_through } });
      await api("POST", `/v1/repos/${REPO}/sessions/${w.session}/bye`, a.wcp, { type: "bye", reason: "m2 run finished" }).catch(() => undefined);
    } catch (err) {
      log(`release ${a.id}: ${String(err.message ?? err).slice(0, 160)}`);
    }
  }
}

function summarize(e) {
  const d = (() => {
    try {
      return JSON.parse(e.data ?? "{}");
    } catch {
      return {};
    }
  })();
  if (e.kind === "review") return { verdict: d.verdict, score: d.score, summary: String(d.summary ?? "").slice(0, 200) };
  if (e.kind === "test") return { status: d.status, summary: d.summary };
  if (e.kind === "rebase") return { status: d.status, layer: d.layer };
  if (e.kind === "risk") return { risk: d.risk };
  if (e.kind === "screenshot") return { route: d.route, ratio: d.ratio ?? d.diff_ratio ?? null };
  if (e.kind === "visual_diff") return d;
  if (e.kind === "rank") return { score: d.score, eligible: d.eligible, reasons: d.reasons };
  return Object.keys(d).length ? Object.fromEntries(Object.entries(d).slice(0, 8).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 160) : v])) : null;
}

/** Proposals from t3 to t1 owners and their answers. */
async function negotiationSummary(head0, agents) {
  const ev = await events(head0);
  const props = ev.filter((e) => e.kind === "negotiate.propose" && e.status === "accepted");
  return props.map((p) => {
    const ans = ev.find((r) => ["negotiate.accept", "negotiate.reject", "negotiate.counter"].includes(r.kind) && r.payload?.reply_to === p.seq);
    const to = p.payload?.to ?? {};
    const owner = agents.find((a) => (to.change ? a.cand.change === to.change : a.id === to.agent));
    return { seq: p.seq, from: p.agent, to: owner?.id ?? to.agent ?? null, to_change: owner?.cand.change ?? to.change ?? null, terms: p.payload?.terms, answer: ans ? { seq: ans.seq, kind: ans.kind, by: ans.agent } : null };
  });
}

/** Wait for a task's BestOfN; approve as the human where it asks; wait for its landing. */
async function settleSelection(t, s, pushed, negotiation) {
  const cands = pushed.filter((a) => a.task === t);
  const t0 = Date.now();
  let bon;
  for (;;) {
    bon = await wf("best-of-n", s.workflow);
    if (["complete", "errored", "terminated"].includes(bon.status)) break;
    if (!s.approved) {
      const ranks = [];
      for (const a of cands) {
        const ch = await api("GET", `/v1/repos/${REPO}/changes/${a.cand.change}`, SYS, undefined, 200);
        const r = ch.evidence.filter((e) => e.kind === "rank").pop();
        if (r) ranks.push({ a, d: JSON.parse(r.data ?? "{}") });
      }
      if (ranks.length) {
        await sleep(8000);
        bon = await wf("best-of-n", s.workflow);
        if (["complete", "errored", "terminated"].includes(bon.status)) break;
        // The human's pick: highest-ranked eligible candidate; for t1, the candidate that
        // accepted the t3 overload proposal (it honours the agreement both tasks rely on).
        const eligible = ranks.filter((r) => r.d.eligible !== false).sort((x, y) => (y.d.score ?? 0) - (x.d.score ?? 0));
        const acceptor = t.key === "t1" ? negotiation.find((n) => n.answer?.kind === "negotiate.accept")?.to_change : undefined;
        const pick = eligible.find((r) => r.a.cand.change === acceptor) ?? eligible[0] ?? ranks[0];
        const res = await api("POST", `/v1/repos/${REPO}/actions`, HUMAN, { type: "action", action: "approve", change: pick.a.cand.change, note: `M2 run ${RUN}: human approval` }, [200, 201]);
        s.approved = { by: "john (human token, as the web UI's Approve)", change: pick.a.cand.change, agent: pick.a.id, why: pick.a.cand.change === acceptor ? "honours the accepted overload agreement" : "highest-ranked eligible", forwarded_to: res.workflow ?? null, at_s: secs() };
        step(`human approved ${t.key}`, s.approved);
      }
    }
    if (Date.now() - t0 > 40 * 60_000) break;
    await sleep(4000);
  }
  s.status = bon.status;
  s.winner = bon.output?.winner ?? null;
  s.winner_agent = cands.find((a) => a.cand.change === s.winner)?.id ?? null;
  s.result = bon.output?.status ?? null;
  s.approved_by = bon.output?.approved_by ?? null;
  s.ranking = bon.output?.ranking?.map((r) => ({ agent: r.agent, score: r.score, eligible: r.eligible, layer: r.layer, reasons: r.reasons }));
  s.selected_at_s = secs();
  if (bon.output?.land_instance) {
    let land;
    for (const t1 = Date.now(); ; ) {
      land = await wf("land", bon.output.land_instance);
      if (["complete", "errored", "terminated"].includes(land.status) || Date.now() - t1 > 30 * 60_000) break;
      await sleep(4000);
    }
    s.land = { workflow_status: land.status, ...(land.output ?? {}), ...(land.error ? { error: String(land.error?.message ?? land.error).slice(0, 300) } : {}) };
    s.landed_at_s = secs();
  }
  step(`selection ${t.key}`, { status: s.status, result: s.result, winner: s.winner_agent, approved_by: s.approved_by, land: s.land });
}

async function checkTrunk() {
  const tt = await api("POST", `/v1/repos/${REPO}/system/trunk-token`, SYS, { ttl: 600 }, 201);
  const d = mkdtempSync(join(tmpdir(), "weft-m2-trunk-"));
  git(["clone", "-q", tt.remote, d], { token: tt.token.plaintext });
  symlinkSync(join(ROOT, "node_modules"), join(d, "node_modules"));
  const tsc = tryRun(join(ROOT, "node_modules/.bin/tsc"), ["-p", "."], d);
  const test = tryRun(process.execPath, ["--test"], d);
  const read = (f) => (existsSync(join(d, f)) ? readFileSync(join(d, f), "utf8") : null);
  const r = {
    head: git(["rev-parse", "HEAD"], { cwd: d }),
    log: git(["log", "--oneline", "-15"], { cwd: d }).split("\n"),
    tsc: { exit: tsc.code, out: tsc.out.trim().split("\n").slice(0, 15) },
    test: { exit: test.code, summary: test.out.split("\n").filter((l) => /^ℹ (tests|pass|fail)/.test(l)) },
    files: {
      "src/auth/session.ts": read("src/auth/session.ts"),
      "src/auth/refresh.ts": read("src/auth/refresh.ts"),
      "src/pricing.ts": read("src/pricing.ts"),
      "public/pricing.html#kiwi": /kiwi/i.test(read("public/pricing.html") ?? ""),
    },
  };
  writeFileSync(join(OUT, "trunk.txt"), [`head ${r.head}`, ...r.log, "--- tsc", tsc.out, "--- node --test", test.out, "--- src/auth/session.ts", r.files["src/auth/session.ts"], "--- src/pricing.ts", r.files["src/pricing.ts"]].join("\n"));
  rmSync(d, { recursive: true, force: true });
  return r;
}

function criteria(full, agents, sigSeq) {
  const t1ids = agents.filter((a) => a.task.key === "t1").map((a) => a.id);
  const t1edits = new Set(full.filter((e) => t1ids.includes(e.agent) && e.kind === "edit" && e.status === "accepted" && (e.writes ?? []).some((w) => w.kind === "signature")).map((e) => e.seq));
  const hooksDeny = (a) => {
    const p = join(a.ev, "hooks.jsonl");
    if (!existsSync(p)) return false;
    return readFileSync(p, "utf8").split("\n").filter(Boolean).some((l) => {
      try {
        const h = JSON.parse(l);
        return h.decision === "deny" && /stale_assumption/.test(h.injected ?? "");
      } catch {
        return false;
      }
    });
  };
  const collided = (key) =>
    agents
      .filter((a) => a.task.key === key)
      .map((a) => {
        const rej = full.find((e) => e.agent === a.id && e.status === "rejected" && (e.diagnostics ?? []).some((d) => d.code === "stale_assumption" && t1edits.has(d.caused_by_seq)));
        const after = rej ? full.filter((e) => e.agent === a.id && e.kind === "edit" && e.status === "accepted" && e.seq > rej.seq).length : 0;
        return { agent: a.id, rejected_seq: rej?.seq ?? null, caused_by: rej ? (rej.diagnostics.find((d) => d.code === "stale_assumption")?.caused_by_seq ?? null) : null, deny_in_transcript: hooksDeny(a), accepted_edits_after: after };
      });
  const t2 = collided("t2");
  const t3 = collided("t3");
  const sel = out.selections ?? {};
  const landOk = (k) => ["landed", "already_landed"].includes(sel[k]?.land?.status);
  const neg = out.negotiation ?? [];
  const isT = (agent, key) => agents.some((a) => a.id === agent && a.task.key === key);
  const accepted = neg.filter((n) => n.answer?.kind === "negotiate.accept" && isT(n.from, "t3") && isT(n.to, "t1"));
  const overloadOnTrunk = /createSession\(userId: string\)\s*:\s*Session\s*;/.test(out.trunk?.files?.["src/auth/session.ts"] ?? "") || /opts\?\s*:/.test(out.trunk?.files?.["src/auth/session.ts"] ?? "");
  const layers = ["t4", "t5"].map((k) => sel[k]?.land?.layer ?? null);
  const t6 = agents.filter((a) => a.task.key === "t6");
  const shots = t6.filter((a) => (out.evidence?.[a.id]?.rows ?? []).some((r) => r.kind === "screenshot" && r.status === "pass"));
  return {
    agents_live: { ok: agents.length === TASKS.length * 3 && agents.every((a) => a.turns.length > 0), detail: { agents: agents.length, pushed: agents.filter((a) => a.push?.ok).length, harness_failures: agents.filter((a) => a.turns.some((t) => t.failure || t.code !== 0)).map((a) => ({ agent: a.id, turns: a.turns })) } },
    collision_squiggle_reroute: { ok: !!sigSeq && t2.some((x) => x.rejected_seq && x.deny_in_transcript && x.accepted_edits_after > 0), detail: { t1_signature_seq: sigSeq ?? null, t2 } },
    structural_merge: { ok: landOk("t4") && landOk("t5") && layers.includes("mergiraf"), detail: { layers, t4: sel.t4?.land ?? null, t5: sel.t5?.land ?? null } },
    negotiation_both_land: { ok: accepted.length > 0 && landOk("t1") && landOk("t3") && accepted.some((n) => n.to_change === sel.t1?.winner) && overloadOnTrunk, detail: { t3, proposals: neg, t1_winner: sel.t1?.winner_agent ?? null, overload_on_trunk: overloadOnTrunk } },
    comparison_and_human_approval: { ok: shots.length >= 2 && !!sel.t6?.approved_by && landOk("t6"), detail: { t6_with_screenshots: shots.map((a) => a.id), approved_by: sel.t6?.approved_by ?? null, approved: sel.t6?.approved ?? null, winner: sel.t6?.winner_agent ?? null } },
    trunk_green: { ok: out.trunk?.tsc?.exit === 0 && out.trunk?.test?.exit === 0, detail: { tsc: out.trunk?.tsc?.exit, test: out.trunk?.test?.exit } },
    auto_revert: { ok: SKIP_REVERT ? false : out.auto_revert?.exit === 0, detail: out.auto_revert ?? "skipped" },
  };
}

/** `--resume`: an earlier run of this number stopped after its agents pushed; rebuild and finish it. */
async function resume() {
  const prev = JSON.parse(readFileSync(join(OUT, "run.json"), "utf8"));
  Object.assign(out, { started_at: prev.started_at, first_seq: prev.first_seq, marks: prev.marks, steps: prev.steps, resumed_at: new Date().toISOString(), resumed_after: prev.error ?? null });
  const resumedAt = prev.marks.all_agents_done ?? 0;
  // keep the original clock: marks continue from the moment the agents were done
  Object.defineProperty(globalThis, "__m2_offset", { value: resumedAt });
  const tc = prev.steps.find((x) => x.name === "tasks + candidates");
  const stamp = tc.tasks[0].task.split("-")[1];
  WORK = readdirSync(tmpdir()).map((d) => join(tmpdir(), d)).find((d) => d.includes(`weft-m2-${stamp}-`));
  for (const t of TASKS) t.id = `m2-${stamp}-${t.key}`;
  const agents = tc.candidates.map((c) => {
    const t = TASKS.find((x) => c.agent.split("-")[1] === x.key);
    const a = new Agent(t, c.agent.split("-")[0], { agent: c.agent, change: c.change, fork: { name: c.fork } });
    const pushed = prev.steps.find((x) => x.name === `pushed ${c.agent}`);
    a.push = pushed ? (pushed.sha ? { ok: true, sha: pushed.sha } : { ok: false, reason: pushed.reason, detail: pushed.detail }) : { ok: false, reason: "no push recorded" };
    a.turns = readdirSync(a.ev).filter((f) => f.endsWith(".prompt.txt")).map((f) => ({ name: f.replace(/^\d+-|\.prompt\.txt$/g, ""), code: existsSync(join(a.ev, f.replace(".prompt.txt", ".jsonl"))) ? 0 : null }));
    return a;
  });
  const sig = prev.steps.find((x) => x.name === "t1 signature change")?.seq;
  for (const x of await cf("GET", "/event_subscriptions/subscriptions?per_page=100")) if (x.name.includes(`m2-${stamp}-`)) SUBS.push(x.id);
  for (const a of agents) a.wcp = (await api("POST", "/v1/admin/tokens", ADMIN, { principal: a.id, scopes: ["agent", "observe"], repos: [REPO], agent: a.id, label: `m2 run ${RUN} resume` }, 201)).token;
  log(`resuming run ${RUN} (${stamp}) after: ${prev.error ?? "?"}`);
  await finishRun(agents, prev.first_seq - 1, sig);
}

/** `--rescore`: recompute `criteria` for a finished run from its saved run.json + coordinator-log.json
 * (no network; used when a criterion's code was wrong, never to change what happened). */
async function rescore() {
  const prev = JSON.parse(readFileSync(join(OUT, "run.json"), "utf8"));
  Object.assign(out, prev);
  const full = JSON.parse(readFileSync(join(OUT, "coordinator-log.json"), "utf8")).events;
  const agents = (prev.agents ?? []).map((a) => ({ id: a.agent, harness: a.harness, task: TASKS.find((t) => t.key === a.task), cand: { change: a.change }, turns: a.turns, push: a.push, ev: join(OUT, "agents", a.agent) }));
  const sig = prev.steps.find((x) => x.name === "t1 signature change")?.seq;
  const before = Object.fromEntries(Object.entries(prev.criteria ?? {}).map(([k, v]) => [k, v.ok]));
  out.criteria = criteria(full, agents, sig);
  out.pass = Object.values(out.criteria).every((c) => c.ok);
  out.rescored = { at: new Date().toISOString(), before, after: Object.fromEntries(Object.entries(out.criteria).map(([k, v]) => [k, v.ok])) };
  save();
  console.log(JSON.stringify(out.rescored));
}

(argv.includes("--rescore") ? rescore() : argv.includes("--resume") ? resume() : main()).catch((e) => {
  console.error(scrub(e.stack ?? e));
  out.error = scrub(String(e.message ?? e));
  try {
    save();
  } catch {}
  for (const id of SUBS) cf("DELETE", `/event_subscriptions/subscriptions/${id}`).catch(() => undefined);
  process.exit(1);
});
