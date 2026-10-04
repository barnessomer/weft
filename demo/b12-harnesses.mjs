#!/usr/bin/env node
// B12: three live harnesses (+ the L0 file watcher) on one Weft coordinator.
//
//   claude-a    Claude Code (claude -p)      T-1 "Session expiry"  createSession(userId) -> createSession(userId, opts)
//   codex-b     Codex CLI (codex exec)       T-2 "Signup endpoint" POST /api/signup, starts a session like login
//   opencode-c  OpenCode (opencode run)      T-3 "Session refresh" refreshSession(token) re-issues a session
//   human-w     file watcher (L0, scripted)  T-4 "Health check"    a human edit, reported after the fact
//
// Timeline: B and C read the code and plan (their bases are pinned before A's change); A
// changes createSession's signature; once that is accepted, B and C implement in the same
// conversations (codex exec resume / opencode run --session). Each must be denied at edit
// time with a stale_assumption caused by A's event, change approach, and finish. The human's
// stale call is only reported (L0), and git's pre-commit hook refuses it until fixed. All
// four branches merge into main; tsc + node --test must be green.
//
// Usage: node demo/b12-harnesses.mjs [--agents a,b,c,w] [--sim-a] [--out demo/evidence/b12]
//   --sim-a   replace the live Claude agent by a scripted signature change (smoke runs)
// Env: WEFT_URL (preview gateway), WEFT_ADMIN_TOKEN_FILE, WEFT_B12_OPENCODE_MODEL
// (default opencode/big-pickle). Tokens are minted per run and never printed.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const BUNDLES = {
  a: join(REPO, "packages/adapters/claude-code/dist/weft-claude.mjs"),
  b: join(REPO, "packages/adapters/codex/dist/weft-codex.mjs"),
  c: join(REPO, "packages/adapters/opencode/dist/weft-opencode.mjs"),
  w: join(REPO, "packages/adapters/watcher/dist/weft-watch.mjs"),
};
const TSC = join(REPO, "node_modules/.bin/tsc");
const URL_ = (process.env.WEFT_URL ?? "https://weft-gateway-preview.redacted-subdomain.workers.dev").replace(/\/+$/, "");
const ADMIN = readFileSync((process.env.WEFT_ADMIN_TOKEN_FILE ?? "~/.config/weft/preview-admin-token").replace(/^~/, homedir()), "utf8").trim();
const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
const AGENTS = new Set(opt("agents", "a,b,c,w").split(","));
const SIM_A = argv.includes("--sim-a");
// --give-up: C is told to stop as soon as Weft blocks it (proves OpenCode's stop gate, L3)
const GIVE_UP = argv.includes("--give-up");
const OUT = resolve(REPO, opt("out", "demo/evidence/b12"));
const OC_MODEL = process.env.WEFT_B12_OPENCODE_MODEL ?? "opencode/big-pickle";
const TIMEOUT_MS = 20 * 60_000;

const log = (m) => console.log(`[b12 ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryRun = (cmd, args, cwd) => {
  try {
    return { code: 0, out: execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};
const readJsonl = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

async function api(method, path, token, body) {
  const r = await fetch(URL_ + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "wcp-version": "0.1", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${JSON.stringify(json?.error ?? json)}`);
  return json;
}

/** Spawn a harness; resolves with exit code + stdout lines (JSONL where the harness emits it). */
function harness(cmd, args, cwd, outFile, env) {
  return new Promise((res) => {
    const started = Date.now();
    // PWD too: OpenCode resolves its project from $PWD, not the process cwd.
    const child = spawn(cmd, args, { cwd, env: { ...env, PWD: cwd }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(outFile, stdout);
      if (stderr.trim()) writeFileSync(outFile.replace(/\.jsonl$/, ".stderr.txt"), stderr);
      const lines = stdout.split("\n").filter(Boolean).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { raw: l };
        }
      });
      res({ code, lines, ms: Date.now() - started, started });
    });
  });
}

const claude = (cwd, out, prompt, env) => {
  writeFileSync(out.replace(/\.jsonl$/, ".prompt.txt"), `cwd: ${cwd}\nclaude -p …\n\n${prompt}\n`);
  return harness("claude", ["-p", "--verbose", "--output-format", "stream-json", "--include-hook-events", "--setting-sources", "project,local", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,MultiEdit,Glob,Grep,Bash(node --test:*),Bash(git status:*),Bash(git diff:*)", "--", prompt], cwd, out, env);
};
const codex = (cwd, out, prompt, env, resumeId) => {
  writeFileSync(out.replace(/\.jsonl$/, ".prompt.txt"), `cwd: ${cwd}\ncodex exec ${resumeId ? `resume ${resumeId} ` : ""}…\n\n${prompt}\n`);
  const common = ["--json", "--dangerously-bypass-hook-trust", "-c", 'sandbox_mode="workspace-write"'];
  return harness("codex", resumeId ? ["exec", "resume", ...common, resumeId, prompt] : ["exec", ...common, "--cd", cwd, prompt], cwd, out, env);
};
// OpenCode runs as a headless server (`opencode serve`, where the Weft plugin lives) and each
// turn is an `opencode run --attach`. A one-shot `opencode run` exits on session.idle, before
// the stop gate's continuation prompt can run; the server keeps the session alive for it.
let ocServer;
async function startOpencodeServer(cwd, env, logFile) {
  const port = 4300 + Math.floor(Math.random() * 600);
  const child = spawn("opencode", ["serve", "--port", String(port)], { cwd, env: { ...env, PWD: cwd }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  child.on("close", () => writeFileSync(logFile, out));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${url}/config`).then((r) => r.ok, () => false)) break;
    await sleep(500);
  }
  ocServer = { child, url };
  return url;
}
const opencode = (cwd, out, prompt, env, sessionId) => {
  writeFileSync(out.replace(/\.jsonl$/, ".prompt.txt"), `cwd: ${cwd}\nopencode run --attach <opencode serve in cwd> --dir <cwd> -m ${OC_MODEL} --format json ${sessionId ? `--session ${sessionId} ` : ""}…\n\n${prompt}\n`);
  return harness("opencode", ["run", "--attach", ocServer.url, "--dir", cwd, "-m", OC_MODEL, "--format", "json", "--auto", ...(sessionId ? ["--session", sessionId] : []), prompt], cwd, out, env);
};
/** Wait until the OpenCode server's session is quiet (no hook activity for `quietMs`): stop-gate continuations run after `run` exits. */
async function settleOpencode(dir, quietMs = 25_000, maxMs = 8 * 60_000) {
  const p = join(dir, ".weft/log/hooks.jsonl");
  const size = () => (existsSync(p) ? readFileSync(p, "utf8").length : 0);
  const end = Date.now() + maxMs;
  let last = size();
  let since = Date.now();
  while (Date.now() < end) {
    await sleep(2000);
    const now = size();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since > quietMs) return;
  }
}

const PROMPT_A =
  'Task T-1 (session expiry): sessions must expire. In src/auth/session.ts add `export type SessionOptions = { ttlMs: number }`, add `expiresAt: number` to Session, ' +
  "change createSession to `createSession(userId: string, opts: SessionOptions): Session` (expiresAt = createdAt + opts.ttlMs), and make getSession return undefined " +
  "(and forget the session) once Date.now() >= expiresAt. Update the existing caller in src/api/routes.ts to pass `{ ttlMs: 60 * 60 * 1000 }`, and update " +
  'test/session.test.ts for the new signature with one extra test for expiry. Run `node --test "test/**/*.test.ts"`, then reply with a one-line summary. Only touch those three files.';
const PROMPT_B1 =
  "Task T-2 (signup): add `POST /api/signup` taking a JSON body {email, name, password}. It registers the user with createUser from src/auth/users.ts and signs them in " +
  "right away by starting a session the same way login in src/api/routes.ts does, responding 201 with {token, user: publicUser(user)}; a UserError becomes 400 {error}. " +
  "Add the route to the accountRoutes array in src/api/account.ts and add test/signup.test.ts. For now ONLY read the relevant files and reply with a short plan that " +
  "includes the exact code you will write. Do not edit any file yet.";
const PROMPT_IMPL =
  "Implement your plan now. This checkout is coordinated by Weft with other agents: if a Weft hook blocks an edit, follow its diagnostic " +
  "and continue. The other agent's change will be merged before yours but is not in your checkout yet, so code written against it may not typecheck here; that is " +
  'expected. Run `node --test "test/**/*.test.ts"`, then reply with what you changed and anything that differed from your plan.';
const PROMPT_B2 = PROMPT_IMPL.replace("Implement your plan now.", "Implement your plan now (use apply_patch for edits).");
const PROMPT_C1 =
  "Task T-3 (session refresh): add a new file src/auth/refresh.ts exporting `refreshSession(token: string): Session | undefined`. It looks up the live session with " +
  "getSession, returns undefined if there is none, otherwise revokes it with revokeSession and starts a fresh session for the same user with createSession from " +
  "src/auth/session.ts (start it exactly the way login in src/api/routes.ts does), returning the new session. Add test/refresh.test.ts (node:test, like " +
  "test/session.test.ts). Only create those two files. For now ONLY read the relevant files and reply with a short plan that includes the exact code you will " +
  "write. Do not create or edit any file yet.";
const PROMPT_C2 = GIVE_UP
  ? "Implement your plan now: create the two files with your write tool. If a Weft hook blocks a write, do NOT retry and do NOT adapt your code: stop immediately and reply with the single word BLOCKED."
  : PROMPT_IMPL.replace("Implement your plan now.", "Implement your plan now: create the two files with your write tool.");

const HEALTH_STALE = `import { createSession } from "../auth/session.ts";\n\n/** Smoke check used by ops: can we mint a session? */\nexport function sessionSmoke(): boolean {\n  return createSession("u_health").token.length > 0;\n}\n`;
const HEALTH_FIXED = HEALTH_STALE.replace('createSession("u_health")', 'createSession("u_health", { ttlMs: 1000 })');

async function run() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-").toLowerCase();
  const repo = `demo-b12-${stamp}`;
  const evidence = OUT;
  rmSync(evidence, { recursive: true, force: true });
  mkdirSync(evidence, { recursive: true });
  mkdirSync(join(process.env.WEFT_DEMO_DIR ?? tmpdir(), `weft-b12-${stamp}`), { recursive: true });
  const work = realpathSync(join(process.env.WEFT_DEMO_DIR ?? tmpdir(), `weft-b12-${stamp}`));
  symlinkSync(join(REPO, "node_modules"), join(work, "node_modules"));
  const origin = join(work, "origin");
  cpSync(join(REPO, "demo/target-app"), origin, { recursive: true });
  git(origin, "init", "-q", "-b", "main");
  git(origin, "config", "user.email", "demo@weft.invalid");
  git(origin, "config", "user.name", "weft demo");
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "target-app: initial");
  const dirs = {};
  for (const k of ["a", "b", "c", "w"]) {
    if (!AGENTS.has(k) && !(k === "a" && SIM_A)) continue;
    dirs[k] = join(work, `agent-${k}`);
    git(origin, "worktree", "add", "-q", dirs[k], "-b", `agent-${k}`);
  }

  await api("POST", "/v1/admin/repos", ADMIN, { repo });
  const mint = async (spec) => (await api("POST", "/v1/admin/tokens", ADMIN, { ...spec, repos: [repo], label: `b12 ${stamp}` })).token;
  const ids = { a: "claude-a", b: "codex-b", c: "opencode-c", w: "human-w" };
  const tasks = { a: ["T-1", "Session expiry", 1], b: ["T-2", "Signup endpoint", 0], c: ["T-3", "Session refresh", 0], w: ["T-4", "Health check", 0] };
  const tokens = {};
  for (const k of Object.keys(dirs)) tokens[k] = await mint({ principal: ids[k], scopes: ["agent", "observe"], agent: ids[k] });
  const tokObs = await mint({ principal: `b12-evidence-${stamp}`, scopes: ["observe"] });
  log(`repo ${repo}, work ${work}, agents ${Object.keys(dirs).join(",")}${SIM_A ? " (A simulated)" : ""} (tokens minted, not printed)`);

  let install = "";
  for (const k of Object.keys(dirs)) {
    if (k === "a" && SIM_A) continue;
    const [task, title, priority] = tasks[k];
    install += execFileSync(process.execPath, [BUNDLES[k], "install", "--url", URL_, "--repo", repo, "--agent", ids[k], "--task", task, "--title", title, "--priority", String(priority)], {
      cwd: dirs[k],
      env: { ...process.env, WEFT_TOKEN: tokens[k] },
      encoding: "utf8",
    });
  }
  writeFileSync(join(evidence, "install.txt"), install.replaceAll(work, "$WORK").replaceAll(REPO, "$REPO"));
  const env = { ...process.env, WEFT_HOOK_TRACE: "1" };
  delete env.WEFT_TOKEN;

  const events = async () => (await api("GET", `/v1/repos/${repo}/events?after=0&limit=500`, tokObs)).events ?? [];
  const t0 = Date.now();
  const marks = {};
  const mark = (k) => (marks[k] = Date.now() - t0);

  // 0. the watcher (L0) starts first, in its own checkout
  let watcher;
  let watchOut = "";
  if (dirs.w) {
    watcher = spawn(process.execPath, [BUNDLES.w, "run", "--debounce", "300", "--tick", "5000"], { cwd: dirs.w, stdio: ["ignore", "pipe", "pipe"] });
    watcher.stdout.on("data", (c) => (watchOut += c));
    watcher.stderr.on("data", (c) => (watchOut += c));
  }

  // 1. B and C plan (bases pinned before A's change)
  const b1p = dirs.b ? codex(dirs.b, join(evidence, "b1-plan.jsonl"), PROMPT_B1, env) : undefined;
  if (dirs.c) await startOpencodeServer(dirs.c, env, join(evidence, "c-opencode-serve.log"));
  const c1p = dirs.c ? opencode(dirs.c, join(evidence, "c1-plan.jsonl"), PROMPT_C1, env) : undefined;
  const want = [dirs.b && "codex-b", dirs.c && "opencode-c", dirs.w && "human-w"].filter(Boolean);
  for (let i = 0; i < 480; i++) {
    const ev = await events();
    if (want.every((a) => ev.some((e) => e.kind === "join" && e.agent === a))) break;
    await sleep(500);
  }
  mark("planners_joined");

  // 2. A changes createSession's signature (live Claude, or scripted with --sim-a)
  let ap = Promise.resolve({ code: 0, lines: [], ms: 0 });
  let sigSeq;
  if (SIM_A) {
    const s = await api("POST", `/v1/repos/${repo}/sessions`, tokens.a, { type: "hello", protocol: "wcp/0.1", agent: { id: "claude-a", harness: "scripted" }, capabilities: { level: 0, observe: "async", inject: false, deny_edit: false, refuse_stop: false, commit_gate: false }, task: { id: "T-1", title: "Session expiry", priority: 1 } });
    const before = readFileSync(join(dirs.a, "src/auth/session.ts"), "utf8");
    const after = before
      .replace("export type Session = { token: string; userId: string; createdAt: number };", "export type SessionOptions = { ttlMs: number };\nexport type Session = { token: string; userId: string; createdAt: number; expiresAt: number };")
      .replace("export function createSession(userId: string): Session {\n  const session: Session = { token: randomBytes(24).toString(\"base64url\"), userId, createdAt: Date.now() };", "export function createSession(userId: string, opts: SessionOptions): Session {\n  const now = Date.now();\n  const session: Session = { token: randomBytes(24).toString(\"base64url\"), userId, createdAt: now, expiresAt: now + opts.ttlMs };");
    writeFileSync(join(dirs.a, "src/auth/session.ts"), after);
    const diff = tryRun("git", ["-C", dirs.a, "diff", "--", "src/auth/session.ts"], dirs.a).out;
    const v = await api("POST", `/v1/repos/${repo}/sessions/${s.session}/events`, tokens.a, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: s.delivered_through, files: ["src/auth/session.ts"], reads: [], writes: [{ key: "src/auth/session.ts#createSession", kind: "signature" }, { key: "src/auth/session.ts#SessionOptions", kind: "new" }, { key: "src/auth/session.ts#Session", kind: "signature" }], diff } });
    sigSeq = v.seq;
  } else {
    log("A (claude): change createSession's signature");
    const envA = { ...env };
    delete envA.OPENROUTER_API_KEY;
    mark("a_started");
    ap = claude(dirs.a, join(evidence, "a-expiry.jsonl"), PROMPT_A, envA);
    let aDone = false;
    ap.then(() => {
      aDone = true;
      mark("a_done");
    });
    while (!sigSeq) {
      sigSeq = (await events()).find((e) => e.agent === "claude-a" && e.status === "accepted" && e.kind === "edit" && (e.writes ?? []).some((w) => w.key === "src/auth/session.ts#createSession" && w.kind === "signature"))?.seq;
      if (!sigSeq && aDone) break;
      if (!sigSeq) await sleep(1000);
    }
  }
  mark("a_signature_accepted");
  log(`A's signature change: ${sigSeq ? `#${sigSeq}` : "NOT SEEN"}`);

  // 3. the human (L0) writes a stale call; B and C implement concurrently
  if (dirs.w) {
    mkdirSync(join(dirs.w, "src/ops"), { recursive: true });
    writeFileSync(join(dirs.w, "src/ops/health.ts"), HEALTH_STALE);
  }
  const b1 = b1p ? await b1p : undefined;
  const c1 = c1p ? await c1p : undefined;
  mark("plans_done");
  const thread = b1?.lines.find((l) => l.thread_id)?.thread_id;
  const ocSession = c1?.lines.find((l) => l.sessionID)?.sessionID ?? c1?.lines.find((l) => l.part?.sessionID)?.part?.sessionID;
  log(`B thread ${thread ?? "-"}, C session ${ocSession ?? "-"}; implementing`);
  mark("impl_started");
  const [b2, c2] = await Promise.all([
    dirs.b ? (thread ? codex(dirs.b, join(evidence, "b2-implement.jsonl"), PROMPT_B2, env, thread) : { code: -1, lines: [], ms: 0 }) : undefined,
    dirs.c ? (ocSession ? opencode(dirs.c, join(evidence, "c2-implement.jsonl"), PROMPT_C2, env, ocSession).then(async (r) => (await settleOpencode(dirs.c), r)) : { code: -1, lines: [], ms: 0 }) : undefined,
  ]);
  if (ocServer) {
    // the whole conversation as the server holds it (incl. turns started by the stop gate)
    try {
      const msgs = await (await fetch(`${ocServer.url}/session/${ocSession}/message`)).json();
      writeFileSync(join(evidence, "c-session-messages.json"), JSON.stringify(msgs, null, 1).replaceAll(work, "$WORK"));
    } catch (err) {
      log(`could not fetch the OpenCode session: ${err}`);
    }
    ocServer.child.kill("SIGTERM");
  }
  mark("impl_done");
  const a = await ap;

  // the human sees the L0 diagnostic, tries to commit (refused), fixes, commits
  const commit = (dir, msg) => {
    git(dir, "add", "-A");
    try {
      execFileSync("git", ["-C", dir, "commit", "-qm", msg], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true, sha: git(dir, "rev-parse", "HEAD"), message: git(dir, "log", "-1", "--format=%B") };
    } catch (err) {
      return { ok: false, error: String(err.stderr ?? err) };
    }
  };
  let human = {};
  if (dirs.w) {
    const refused = commit(dirs.w, "ops: session smoke check (T-4)");
    writeFileSync(join(dirs.w, "src/ops/health.ts"), HEALTH_FIXED);
    await sleep(3000); // debounce + report
    const accepted = commit(dirs.w, "ops: session smoke check (T-4)");
    human = { refused_first: !refused.ok, refusal: refused.error?.slice(0, 600), committed_after_fix: accepted.ok };
    await sleep(6000); // a tick reports the checkpoint
    watcher.kill("SIGINT");
    await new Promise((r) => watcher.on("close", r));
    writeFileSync(join(evidence, "w-watcher-stdout.txt"), watchOut.replaceAll(work, "$WORK"));
  }

  // ------------------------------------------------------------- evidence
  const full = [];
  for (const e of await events()) full.push(e.has_diff ? await api("GET", `/v1/repos/${repo}/events/${e.seq}`, tokObs) : e);
  writeFileSync(join(evidence, "coordinator-log.json"), JSON.stringify({ url: URL_, repo, events: full }, null, 2));
  for (const [who, dir] of Object.entries(dirs)) {
    for (const f of ["adapter.log", "hooks.jsonl"]) {
      const p = join(dir, ".weft/log", f);
      if (existsSync(p)) writeFileSync(join(evidence, `${who}-${f}`), readFileSync(p, "utf8").replaceAll(work, "$WORK"));
    }
  }

  const commits = {};
  if (dirs.a && !SIM_A) commits.a = commit(dirs.a, "auth: sessions expire (T-1)");
  if (dirs.b) commits.b = commit(dirs.b, "api: POST /api/signup (T-2)");
  if (dirs.c) commits.c = commit(dirs.c, "auth: refreshSession (T-3)");
  const checks = (cwd) => ({ tsc: tryRun(TSC, ["-p", "."], cwd), test: tryRun(process.execPath, ["--test", "test/**/*.test.ts"], cwd) });
  const merge = (branch) => {
    try {
      execFileSync("git", ["-C", origin, "merge", "--no-ff", "--no-edit", branch], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true };
    } catch (err) {
      const conflicts = tryRun("git", ["-C", origin, "diff", "--name-only", "--diff-filter=U"], origin).out.trim();
      tryRun("git", ["-C", origin, "merge", "--abort"], origin);
      return { ok: false, conflicts, error: String(err.stderr ?? err).slice(0, 500) };
    }
  };
  const merges = {};
  for (const k of ["a", "b", "c", "w"]) if (dirs[k] && !(k === "a" && SIM_A)) merges[k] = merge(`agent-${k}`);
  const merged = SIM_A ? null : checks(origin);
  const final = (rel) => (existsSync(join(origin, rel)) ? readFileSync(join(origin, rel), "utf8") : "");
  writeFileSync(
    join(evidence, "landing.txt"),
    [
      ...Object.entries(commits).map(([k, c]) => `agent-${k} commit: ${c.ok ? c.message : c.error}`),
      `--- merges: ${JSON.stringify(merges)}`,
      git(origin, "log", "--oneline", "--graph", "-10"),
      merged ? `--- main after merges: tsc exit ${merged.tsc.code}\n${merged.tsc.out.trim()}\n--- main: node --test exit ${merged.test.code}\n${merged.test.out.split("\n").filter((l) => /^(ℹ|✔|✖)/.test(l)).join("\n")}` : "(A simulated: no merged checks)",
      "--- main:src/auth/refresh.ts",
      final("src/auth/refresh.ts"),
      "--- main:src/api/account.ts",
      final("src/api/account.ts"),
      "--- main:src/ops/health.ts",
      final("src/ops/health.ts"),
    ].join("\n") + "\n",
  );

  // ------------------------------------------------------------- verdict
  const deniedBy = (agent, hooksFile) => {
    const rejected = full.filter((e) => e.agent === agent && e.status === "rejected");
    const caused = rejected.find((e) => (e.diagnostics ?? []).some((d) => d.severity === "error" && d.code === "stale_assumption" && d.caused_by_seq === sigSeq));
    const hooks = readJsonl(join(evidence, hooksFile));
    const denied = hooks.find((h) => (h.decision === "deny" || h.event === "PreToolUse") && h.decision === "deny" && /stale_assumption/.test(h.injected ?? ""));
    const acceptedAfter = caused ? full.filter((e) => e.agent === agent && e.status === "accepted" && e.kind === "edit" && e.seq > caused.seq).map((e) => e.seq) : [];
    return { rejected_seq: caused?.seq ?? null, deny_hook: !!denied, accepted_after: acceptedAfter };
  };
  const joins = Object.fromEntries(full.filter((e) => e.kind === "join").map((e) => [e.agent, e.payload]));
  const per = {};
  if (dirs.b) per.b = deniedBy("codex-b", "b-hooks.jsonl");
  if (dirs.c) per.c = deniedBy("opencode-c", "c-hooks.jsonl");
  const humanEdits = full.filter((e) => e.agent === "human-w" && e.kind === "edit");
  if (dirs.w) per.w = { reported_stale: humanEdits.some((e) => e.status === "rejected" && (e.diagnostics ?? []).some((d) => d.code === "stale_assumption" && d.caused_by_seq === sigSeq)), reported_fix_accepted: humanEdits.some((e) => e.status === "accepted"), ...human };
  const accountTs = final("src/api/account.ts");
  const refreshTs = final("src/auth/refresh.ts");
  const backendFailure = [...(b1?.lines ?? []), ...(b2?.lines ?? [])].find((l) => l.type === "turn.failed")?.error?.message?.slice(0, 200) ?? [...(c1?.lines ?? []), ...(c2?.lines ?? [])].find((l) => l.type === "error")?.error?.data?.message?.slice(0, 200);
  const resultA = a.lines.find((l) => l.type === "result");
  const criteria = {
    ...(SIM_A ? {} : { a_finished: a.code === 0 && resultA?.subtype === "success" }),
    ...(dirs.b ? { b_denied_at_edit_time_by_a: !!per.b.rejected_seq && per.b.deny_hook, b_changed_approach: per.b.accepted_after.length > 0 && (SIM_A || /createSession\(\s*[^()]*?,\s*[^)]/.test(accountTs)), b_finished: b1.code === 0 && b2.code === 0 } : {}),
    ...(dirs.c && GIVE_UP ? (() => {
      const hooks = readJsonl(join(evidence, "c-hooks.jsonl"));
      const msgs = existsSync(join(evidence, "c-session-messages.json")) ? JSON.parse(readFileSync(join(evidence, "c-session-messages.json"), "utf8")) : [];
      // each refusal must arrive as a new user turn that the model answers
      const refusalTurns = msgs.filter((m, i) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && p.text.startsWith("[weft] Not done")) && msgs[i + 1]?.info.role === "assistant").length;
      per.c.stop_refusals = hooks.filter((h) => h.event === "Stop" && h.decision === "block").length;
      per.c.refusal_turns = refusalTurns;
      return { c_denied_at_edit_time_by_a: !!per.c.rejected_seq && per.c.deny_hook, c_stop_refused: per.c.stop_refusals > 0, c_refusal_started_new_turns: refusalTurns > 0 && refusalTurns === per.c.stop_refusals, c_finished: c1.code === 0 && c2.code === 0 };
    })() : {}),
    ...(dirs.c && !GIVE_UP ? { c_denied_at_edit_time_by_a: !!per.c.rejected_seq && per.c.deny_hook, c_changed_approach: per.c.accepted_after.length > 0 && (SIM_A || /createSession\(\s*[^()]*?,\s*[^)]/.test(refreshTs)), c_finished: c1.code === 0 && c2.code === 0 } : {}),
    ...(dirs.w ? { w_l0_reported_and_commit_gated: per.w.reported_stale && per.w.refused_first && per.w.reported_fix_accepted && per.w.committed_after_fix } : {}),
    ...(SIM_A ? {} : { merged_cleanly: Object.values(merges).every((m) => m.ok), tests_green: merged.tsc.code === 0 && merged.test.code === 0 }),
  };
  const summary = {
    repo,
    url: URL_,
    pass: Object.values(criteria).every(Boolean),
    ...(backendFailure ? { backend_failure: backendFailure } : {}),
    criteria,
    a_signature_seq: sigSeq ?? null,
    per_agent: per,
    harnesses: {
      a: SIM_A ? "scripted" : "claude-code (claude -p)",
      ...(dirs.b ? { b: "codex exec (+ resume)" } : {}),
      ...(dirs.c ? { c: `opencode run (${OC_MODEL}, + --session)` } : {}),
      ...(dirs.w ? { w: "weft-watch run (L0 file watcher)" } : {}),
    },
    declared_capabilities: joins,
    timeline_ms: marks,
    durations_ms: { a: a.ms, b1: b1?.ms, b2: b2?.ms, c1: c1?.ms, c2: c2?.ms },
    work,
  };
  writeFileSync(join(evidence, "summary.json"), JSON.stringify(summary, null, 2));
  log(`${summary.pass ? "PASS" : "FAIL"} ${JSON.stringify(criteria)}`);
  return summary;
}

for (const k of ["a", "b", "c", "w"]) {
  const pkg = dirname(dirname(BUNDLES[k]));
  execFileSync(process.execPath, [join(pkg, "scripts/build.mjs")], { stdio: "inherit" });
}
mkdirSync(OUT, { recursive: true });
const s = await run();
console.log(JSON.stringify({ pass: s.pass, criteria: s.criteria, per_agent: s.per_agent }, null, 2));
