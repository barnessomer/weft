#!/usr/bin/env node
// M1 milestone: Claude Code (agent A) and Codex (agent B) work concurrently on one Weft
// coordinator; their tasks collide on one function. See demo/scenarios/m1.md.
//
//   claude-a  T-1 "Session expiry"   changes createSession(userId) -> createSession(userId, opts)
//   codex-b   T-2 "Signup endpoint"  adds POST /api/signup, which must start a session
//
// Timeline per run (both agents are live processes at the same time):
//   1. B turn 1 (codex exec): read the code, plan the signup route (calls createSession(user.id)).
//   2. As soon as B's SessionStart hook has said hello (base pinned), A (claude -p) starts.
//   3. When A's signature change of createSession is ACCEPTED in the log, B turn 2 starts
//      (codex exec resume: same conversation, still believes the old signature) while A is
//      typically still working on its caller and tests.
//   4. Required: B's apply_patch is denied at PreToolUse with a stale_assumption diagnostic
//      caused by A's event; B changes approach; both finish; A then B merge into main with
//      no conflict; `tsc` and `node --test` are green on the merge.
//
// Usage: node demo/m1-collision.mjs [--runs N] [--out demo/evidence/m1]
// Env: WEFT_URL (default preview gateway), WEFT_ADMIN_TOKEN_FILE (default
// ~/.config/weft/preview-admin-token). Tokens are minted per run and never printed.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CLAUDE_BUNDLE = join(REPO, "packages/adapters/claude-code/dist/weft-claude.mjs");
const CODEX_BUNDLE = join(REPO, "packages/adapters/codex/dist/weft-codex.mjs");
const TSC = join(REPO, "node_modules/.bin/tsc");
const URL_ = (process.env.WEFT_URL ?? "https://weft-gateway-preview.redacted-subdomain.workers.dev").replace(/\/+$/, "");
const ADMIN = readFileSync((process.env.WEFT_ADMIN_TOKEN_FILE ?? "~/.config/weft/preview-admin-token").replace(/^~/, homedir()), "utf8").trim();
const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
const RUNS = Number(opt("runs", "1"));
const OUT = resolve(REPO, opt("out", "demo/evidence/m1"));
const FIRST = Number(opt("first", "1"));
const TIMEOUT_MS = 15 * 60_000;
// Codex's model backend. Default: the logged-in ChatGPT account. WEFT_M1_CODEX_PROVIDER=openrouter
// runs the same Codex CLI (same hooks, same adapter) against OpenRouter's Responses API with
// OPENROUTER_API_KEY from the environment (model: WEFT_M1_CODEX_MODEL, default openai/gpt-6-sol).
const CODEX_PROVIDER = process.env.WEFT_M1_CODEX_PROVIDER ?? "chatgpt";
const CODEX_MODEL = process.env.WEFT_M1_CODEX_MODEL ?? (CODEX_PROVIDER === "openrouter" ? "openai/gpt-6-sol" : undefined);
const CODEX_MODEL_ARGS =
  CODEX_PROVIDER === "openrouter"
    ? ["-c", "model_provider=openrouter", "-c", `model=${JSON.stringify(CODEX_MODEL)}`, "-c", 'model_providers.openrouter={name="OpenRouter",base_url="https://openrouter.ai/api/v1",env_key="OPENROUTER_API_KEY",wire_api="responses"}']
    : CODEX_MODEL
      ? ["-c", `model=${JSON.stringify(CODEX_MODEL)}`]
      : [];
if (CODEX_PROVIDER === "openrouter" && !process.env.OPENROUTER_API_KEY) throw new Error("WEFT_M1_CODEX_PROVIDER=openrouter needs OPENROUTER_API_KEY");

const log = (m) => console.log(`[m1 ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryRun = (cmd, args, cwd) => {
  try {
    return { code: 0, out: execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

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

/** Spawn a harness; resolves with exit code + stdout lines (JSONL). */
function harness(cmd, args, cwd, outFile, env) {
  return new Promise((res) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(outFile, stdout);
      if (stderr.trim()) writeFileSync(outFile.replace(/\.jsonl$/, ".stderr.txt"), stderr);
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
      res({ code, lines, ms: Date.now() - started, started, ended: Date.now() });
    });
  });
}

function claude(cwd, out, prompt, env) {
  writeFileSync(out.replace(/\.jsonl$/, ".prompt.txt"), `cwd: ${cwd}\nclaude -p …\n\n${prompt}\n`);
  return harness(
    "claude",
    [
      "-p", "--verbose", "--output-format", "stream-json", "--include-hook-events",
      "--setting-sources", "project,local",
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read,Edit,Write,MultiEdit,Glob,Grep,Bash(node --test:*),Bash(git status:*),Bash(git diff:*)",
      "--", prompt,
    ],
    cwd,
    out,
    env,
  );
}

function codex(cwd, out, prompt, env, resumeId) {
  writeFileSync(out.replace(/\.jsonl$/, ".prompt.txt"), `cwd: ${cwd}\ncodex exec ${resumeId ? `resume ${resumeId} ` : ""}…\n\n${prompt}\n`);
  // workspace-write sandbox for the model's shell commands (hooks run outside it, unsandboxed)
  const common = ["--json", "--dangerously-bypass-hook-trust", "-c", 'sandbox_mode="workspace-write"', ...CODEX_MODEL_ARGS];
  const args = resumeId ? ["exec", "resume", ...common, resumeId, prompt] : ["exec", ...common, "--cd", cwd, prompt];
  return harness("codex", args, cwd, out, env);
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
const PROMPT_B2 =
  "Implement your plan now (use apply_patch for edits). This checkout is coordinated by Weft with other agents: if a Weft hook blocks an edit, follow its diagnostic " +
  "and continue. The other agent's change will be merged before yours but is not in your checkout yet, so code written against it may not typecheck here; that is " +
  'expected. Run `node --test "test/**/*.test.ts"`, then reply with what you changed and anything that differed from your plan.';

async function oneRun(n) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-").toLowerCase();
  const repo = `demo-m1-${stamp}-r${n}`;
  const evidence = join(OUT, `run-${n}`);
  const work = join(process.env.WEFT_DEMO_DIR ?? tmpdir(), `weft-m1-${stamp}-r${n}`);
  rmSync(evidence, { recursive: true, force: true });
  mkdirSync(evidence, { recursive: true });
  mkdirSync(work, { recursive: true });
  // node_modules for tsc's @types/node (resolution walks up from the worktrees)
  symlinkSync(join(REPO, "node_modules"), join(work, "node_modules"));
  const origin = join(work, "origin");
  cpSync(join(REPO, "demo/target-app"), origin, { recursive: true });
  git(origin, "init", "-q", "-b", "main");
  git(origin, "config", "user.email", "demo@weft.invalid");
  git(origin, "config", "user.name", "weft demo");
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "target-app: initial");
  const dirA = join(work, "agent-a");
  const dirB = join(work, "agent-b");
  git(origin, "worktree", "add", "-q", dirA, "-b", "agent-a");
  git(origin, "worktree", "add", "-q", dirB, "-b", "agent-b");

  await api("POST", "/v1/admin/repos", ADMIN, { repo });
  const mint = async (spec) => (await api("POST", "/v1/admin/tokens", ADMIN, { ...spec, repos: [repo], label: `m1 ${stamp}` })).token;
  const tokA = await mint({ principal: "claude-a", scopes: ["agent", "observe"], agent: "claude-a" });
  const tokB = await mint({ principal: "codex-b", scopes: ["agent", "observe"], agent: "codex-b" });
  const tokObs = await mint({ principal: `m1-evidence-${stamp}`, scopes: ["observe"] });
  log(`run ${n}: repo ${repo}, work ${work} (tokens minted, not printed)`);

  const install = (bundle, dir, tok, agent, task, title, priority) =>
    execFileSync(process.execPath, [bundle, "install", "--url", URL_, "--repo", repo, "--agent", agent, "--task", task, "--title", title, "--priority", String(priority)], {
      cwd: dir,
      env: { ...process.env, WEFT_TOKEN: tok },
      encoding: "utf8",
    });
  writeFileSync(
    join(evidence, "install.txt"),
    install(CLAUDE_BUNDLE, dirA, tokA, "claude-a", "T-1", "Session expiry", 1) + install(CODEX_BUNDLE, dirB, tokB, "codex-b", "T-2", "Signup endpoint", 0),
  );
  const env = { ...process.env, WEFT_HOOK_TRACE: "1" };
  delete env.WEFT_TOKEN;

  const events = async () => (await api("GET", `/v1/repos/${repo}/events?after=0&limit=500`, tokObs)).events ?? [];
  const t0 = Date.now();
  const marks = {};
  const mark = (k) => (marks[k] = Date.now() - t0);

  // 1. B turn 1 (plan); A starts once B's SessionStart has said hello.
  log("B1 (codex): read + plan");
  const b1p = codex(dirB, join(evidence, "b1-plan.jsonl"), PROMPT_B1, env);
  for (let i = 0; i < 240; i++) {
    if ((await events()).some((e) => e.kind === "join" && e.agent === "codex-b")) break;
    await sleep(500);
  }
  mark("b_joined");
  log("A (claude): change createSession's signature — running concurrently with B");
  const envA = { ...env };
  delete envA.OPENROUTER_API_KEY;
  const ap = claude(dirA, join(evidence, "a-expiry.jsonl"), PROMPT_A, envA);
  mark("a_started");

  // 2. wait for A's accepted signature change, and for B's plan turn to end
  let sigSeq;
  let aDone = false;
  ap.then(() => {
    aDone = true;
    mark("a_done");
  });
  while (!sigSeq) {
    const ev = await events();
    sigSeq = ev.find((e) => e.agent === "claude-a" && e.status === "accepted" && e.kind === "edit" && (e.writes ?? []).some((w) => w.key === "src/auth/session.ts#createSession" && w.kind === "signature"))?.seq;
    if (!sigSeq && aDone) break;
    if (!sigSeq) await sleep(1000);
  }
  mark("a_signature_accepted");
  const b1 = await b1p;
  mark("b1_done");
  const thread = b1.lines.find((l) => l.thread_id)?.thread_id;
  log(`A's signature change: ${sigSeq ? `#${sigSeq}` : "NOT SEEN"}; B thread ${thread}`);

  // 3. B turn 2 (implement) — resumed conversation, concurrent with whatever A still does
  log(`B2 (codex resume): implement — A ${aDone ? "already finished" : "still running"}`);
  const aRunningAtB2 = !aDone;
  mark("b2_started");
  const b2 = thread ? await codex(dirB, join(evidence, "b2-implement.jsonl"), PROMPT_B2, env, thread) : { code: -1, lines: [], ms: 0 };
  mark("b2_done");
  const a = await ap;

  // ------------------------------------------------------------- evidence
  const full = [];
  for (const e of await events()) full.push(e.has_diff ? await api("GET", `/v1/repos/${repo}/events/${e.seq}`, tokObs) : e);
  writeFileSync(join(evidence, "coordinator-log.json"), JSON.stringify({ url: URL_, repo, events: full }, null, 2));
  for (const [who, dir] of [["a", dirA], ["b", dirB]]) {
    for (const f of ["adapter.log", "hooks.jsonl"]) {
      const p = join(dir, ".weft/log", f);
      if (existsSync(p)) writeFileSync(join(evidence, `${who}-${f}`), readFileSync(p, "utf8"));
    }
  }
  // Codex's own rollout (full transcript incl. hook feedback as the model saw it)
  if (thread) {
    const day = join(homedir(), ".codex/sessions", ...new Date(b1.started).toISOString().slice(0, 10).split("-"));
    const dirs = [day, join(homedir(), ".codex/sessions", ...new Date().toISOString().slice(0, 10).split("-"))];
    for (const d of dirs) {
      if (!existsSync(d)) continue;
      const f = readdirSync(d).find((x) => x.includes(thread));
      if (f) {
        // Keep the conversation (messages, tool calls/outputs incl. hook feedback); drop
        // session/turn metadata that carries the operator's global Codex instructions/config.
        const keep = readFileSync(join(d, f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((e) => {
            const p = e.payload ?? {};
            if (e.type !== "response_item") return false;
            if (p.type === "function_call" || p.type === "function_call_output") return true;
            const txt = JSON.stringify(p.content ?? "");
            return p.type === "message" && (p.role === "assistant" || txt.includes("[weft") || txt.includes("Task T-2") || txt.includes("Implement your plan"));
          });
        writeFileSync(join(evidence, "b-codex-rollout.jsonl"), keep.map((e) => JSON.stringify(e)).join("\n") + "\n");
        break;
      }
    }
  }

  // commit both checkouts through the installed git hooks, merge A then B, run the checks
  const commit = (dir, msg) => {
    git(dir, "add", "-A");
    try {
      execFileSync("git", ["-C", dir, "commit", "-qm", msg], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true, sha: git(dir, "rev-parse", "HEAD"), message: git(dir, "log", "-1", "--format=%B") };
    } catch (err) {
      return { ok: false, error: String(err.stderr ?? err) };
    }
  };
  const commitA = commit(dirA, "auth: sessions expire (T-1)");
  const commitB = commit(dirB, "api: POST /api/signup (T-2)");
  const checks = (cwd) => ({ tsc: tryRun(TSC, ["-p", "."], cwd), test: tryRun(process.execPath, ["--test", "test/**/*.test.ts"], cwd) });
  const perBranch = { a: checks(dirA), b: checks(dirB) };
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
  const mergeA = merge("agent-a");
  const mergeB = mergeA.ok ? merge("agent-b") : { ok: false, error: "skipped" };
  const merged = checks(origin);
  const final = (rel) => (existsSync(join(origin, rel)) ? readFileSync(join(origin, rel), "utf8") : "");
  const accountTs = final("src/api/account.ts");
  writeFileSync(
    join(evidence, "landing.txt"),
    [
      `agent-a commit: ${commitA.ok ? commitA.message : commitA.error}`,
      `agent-b commit: ${commitB.ok ? commitB.message : commitB.error}`,
      `--- agent-a alone: tsc exit ${perBranch.a.tsc.code}, tests exit ${perBranch.a.test.code}`,
      `--- agent-b alone (A's change not merged yet): tsc exit ${perBranch.b.tsc.code}, tests exit ${perBranch.b.test.code}`,
      perBranch.b.tsc.out.trim(),
      `--- merge agent-a: ${JSON.stringify(mergeA)}; merge agent-b: ${JSON.stringify(mergeB)}`,
      git(origin, "log", "--oneline", "--graph", "-6"),
      `--- main after both merges: tsc exit ${merged.tsc.code}`,
      merged.tsc.out.trim(),
      `--- main: node --test exit ${merged.test.code}`,
      merged.test.out.split("\n").filter((l) => /^(ℹ|✔|✖)/.test(l)).join("\n"),
      `--- main:src/api/account.ts`,
      accountTs,
      `--- main:src/auth/session.ts`,
      final("src/auth/session.ts"),
    ].join("\n") + "\n",
  );

  // ------------------------------------------------------------- verdict + metrics
  const rejected = full.filter((e) => e.agent === "codex-b" && e.status === "rejected");
  const caused = rejected.find((e) => (e.diagnostics ?? []).some((d) => d.severity === "error" && d.code === "stale_assumption" && d.caused_by_seq === sigSeq));
  const bHooks = readJsonl(join(evidence, "b-hooks.jsonl"));
  const aHooks = readJsonl(join(evidence, "a-hooks.jsonl"));
  const denied = bHooks.find((h) => h.event === "PreToolUse" && h.decision === "deny" && /stale_assumption/.test(h.injected ?? ""));
  const acceptedAfter = caused ? full.filter((e) => e.agent === "codex-b" && e.status === "accepted" && e.kind === "edit" && e.seq > caused.seq) : [];
  const usesNewSignature = /createSession\(\s*[^()]*?,\s*[^)]/.test(accountTs);
  const resultA = a.lines.find((l) => l.type === "result");
  const usageB = [...b1.lines, ...b2.lines].filter((l) => l.type === "turn.completed").map((l) => l.usage);
  const tokensB = usageB.reduce((s, u) => s + (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0), 0);
  const tokensA = resultA?.usage ? (resultA.usage.input_tokens ?? 0) + (resultA.usage.cache_read_input_tokens ?? 0) + (resultA.usage.cache_creation_input_tokens ?? 0) + (resultA.usage.output_tokens ?? 0) : 0;
  const weft = (hooks) => hooks.reduce((s, h) => s + (h.weft_chars ?? 0), 0);
  // A turn that failed in the model backend (quota, budget, outage) is not a Weft result.
  const backendFailure = [...b1.lines, ...b2.lines].find((l) => l.type === "turn.failed")?.error?.message?.slice(0, 200);
  const criteria = {
    b_got_edit_time_diagnostic_from_a: !!caused && !!denied,
    b_changed_approach: acceptedAfter.length > 0 && usesNewSignature,
    both_finished: a.code === 0 && b1.code === 0 && b2.code === 0 && !!resultA && resultA.subtype === "success",
    merged_cleanly: mergeA.ok && mergeB.ok,
    tests_green: merged.tsc.code === 0 && merged.test.code === 0,
  };
  const summary = {
    run: n,
    repo,
    url: URL_,
    pass: Object.values(criteria).every(Boolean),
    ...(backendFailure ? { aborted: `Codex model backend failed: ${backendFailure}` } : {}),
    criteria,
    a_signature_seq: sigSeq ?? null,
    b_rejected_seq: caused?.seq ?? null,
    b_accepted_after: acceptedAfter.map((e) => e.seq),
    a_running_when_b2_started: aRunningAtB2,
    timeline_ms: marks,
    durations_ms: { a: a.ms, b1: b1.ms, b2: b2.ms },
    hooks: { a: hookStats(aHooks), b: hookStats(bHooks) },
    injected: {
      a_weft_chars: weft(aHooks),
      b_weft_chars: weft(bHooks),
      b_deny_chars: denied?.injected?.length ?? 0,
      est_tokens: { a: Math.round(weft(aHooks) / 4), b: Math.round(weft(bHooks) / 4), b_deny: Math.round((denied?.injected?.length ?? 0) / 4) },
    },
    model_tokens: { a: tokensA, b: tokensB, a_cost_usd: resultA?.total_cost_usd ?? null },
    checks: { a: codes(perBranch.a), b: codes(perBranch.b), merged: codes(merged) },
    harnesses: { a: "claude-code (claude -p)", b: `codex exec (provider ${CODEX_PROVIDER}${CODEX_MODEL ? `, model ${CODEX_MODEL}` : ""})` },
    b_thread: thread ?? null,
    work,
  };
  writeFileSync(join(evidence, "summary.json"), JSON.stringify(summary, null, 2));
  log(`run ${n}: ${summary.pass ? "PASS" : "FAIL"} ${JSON.stringify(criteria)}`);
  return summary;
}

function readJsonl(p) {
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const codes = (c) => ({ tsc: c.tsc.code, test: c.test.code });
function pct(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function hookStats(hooks) {
  const by = {};
  for (const h of hooks) {
    const k = `${h.event}${h.tool ? `:${h.tool}` : ""}`;
    (by[k] ??= []).push(h);
  }
  const out = {};
  for (const [k, hs] of Object.entries(by)) {
    const total = hs.map((h) => h.total_ms);
    const rtt = hs.flatMap((h) => (h.calls ?? []).map((c) => c.ms));
    out[k] = { n: hs.length, total_ms_p50: pct(total, 50), total_ms_max: Math.max(...total), coordinator_call_ms_p50: pct(rtt, 50), calls: rtt.length };
  }
  const all = hooks.map((h) => h.total_ms);
  const rtts = hooks.flatMap((h) => (h.calls ?? []).map((c) => c.ms));
  out._all = { n: hooks.length, total_ms_p50: pct(all, 50), total_ms_p95: pct(all, 95), coordinator_call_ms_p50: pct(rtts, 50), coordinator_call_ms_p95: pct(rtts, 95) };
  return out;
}

// Preflight: agent A must have noninteractive Claude auth, or `claude -p` answers
// "Not logged in" and the run is wasted (M1 run 5). Checked before any run starts, so it
// never changes how a started run is scored. Headless options: CLAUDE_CODE_OAUTH_TOKEN
// (from `claude setup-token`), ANTHROPIC_API_KEY, or a working `claude /login` keychain entry.
{
  let st = {};
  try {
    st = JSON.parse(execFileSync("claude", ["auth", "status"], { encoding: "utf8", env: { ...process.env, OPENROUTER_API_KEY: "" } }));
  } catch (err) {
    try {
      st = JSON.parse(String(err.stdout ?? ""));
    } catch {
      st = { error: String(err.message ?? err) };
    }
  }
  if (!st.loggedIn) {
    throw new Error(`claude is not authenticated (claude auth status: ${JSON.stringify(st)}); set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, or run claude /login`);
  }
  console.log(`[m1] claude auth: ${st.authMethod}`);
}

for (const b of [CLAUDE_BUNDLE, CODEX_BUNDLE]) {
  const pkg = dirname(dirname(b));
  execFileSync(process.execPath, [join(pkg, "scripts/build.mjs")], { stdio: "inherit" });
}
mkdirSync(OUT, { recursive: true });
const results = [];
for (let i = FIRST; i < FIRST + RUNS; i++) {
  try {
    results.push(await oneRun(i));
  } catch (err) {
    log(`run ${i} crashed: ${err.stack ?? err}`);
    results.push({ run: i, pass: false, error: String(err) });
  }
}
console.log(JSON.stringify(results.map((r) => ({ run: r.run, pass: r.pass, criteria: r.criteria, error: r.error })), null, 2));
