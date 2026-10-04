#!/usr/bin/env node
// B11 demo: negotiation between two live agents (design §8 beat 4: "B proposes an overload;
// A accepts; both land"). See demo/scenarios/b11-negotiation.md.
//
//   claude-a  T-1 "Session expiry"   (priority 1) createSession(userId) -> createSession(userId, opts)
//   claude-b  T-2 "Signup endpoint"  (priority 0) adds POST /api/signup; product rule: signup
//             sessions use the default lifetime, so B must keep calling createSession(user.id)
//
// Timeline (both agents are live `claude -p` processes):
//   1. B turn 1: read + plan (pins B's base before A's change).
//   2. A starts as soon as B has joined; A changes createSession's signature.
//   3. Once A's signature change is accepted, B turn 2 (resumed conversation) implements.
//      Its stale call is denied (stale_assumption, with options). B runs
//      `weft negotiate propose overload "…" --wait`, which reaches A as injected context (and
//      holds A's stop gate). A accepts and adds the overload (its stop gate holds until it
//      does). B's wait returns the acceptance; B keeps createSession(user.id).
//   4. If A already exited before the proposal, it is resumed with a neutral "continue"
//      prompt: its new WCP session gets the pending proposal redelivered (spec §8.4).
//   5. Both checkouts commit through the git hooks, merge into main (A then B), and the
//      landing posts `land` records to the coordinator; tsc + tests on main.
//
// Usage: node demo/b11-negotiation.mjs [--runs N] [--first K] [--out demo/evidence/b11]
// Env: WEFT_URL (default http://127.0.0.1:8799 = local `wrangler dev --env test`),
//      WEFT_ADMIN_TOKEN_FILE (default ~/.config/weft/b11-local-admin-token). Tokens are
//      minted per run and never printed.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CLAUDE_BUNDLE = join(REPO, "packages/adapters/claude-code/dist/weft-claude.mjs");
const TSC = join(REPO, "node_modules/.bin/tsc");
const URL_ = (process.env.WEFT_URL ?? "http://127.0.0.1:8799").replace(/\/+$/, "");
const ADMIN = readFileSync((process.env.WEFT_ADMIN_TOKEN_FILE ?? "~/.config/weft/b11-local-admin-token").replace(/^~/, homedir()), "utf8").trim();
const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
const RUNS = Number(opt("runs", "1"));
const FIRST = Number(opt("first", "1"));
const OUT = resolve(REPO, opt("out", "demo/evidence/b11"));
const TIMEOUT_MS = 20 * 60_000;
const SIG_KEY = "src/auth/session.ts#createSession";

const log = (m) => console.log(`[b11 ${new Date().toISOString().slice(11, 19)}] ${m}`);
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

function claude(cwd, out, prompt, env, { resume, cli } = {}) {
  writeFileSync(out.replace(/\.jsonl$/, ".prompt.txt"), `cwd: ${cwd}\nclaude -p ${resume ? `--resume ${resume} ` : ""}…\n\n${prompt}\n`);
  const tools = ["Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "Bash(node --test:*)", "Bash(git status:*)", "Bash(git diff:*)", ...(cli ? [`Bash(${cli}:*)`, "Bash(.weft/bin/weft:*)", "Bash(./.weft/bin/weft:*)"] : [])];
  return harness(
    "claude",
    [
      "-p", "--verbose", "--output-format", "stream-json", "--include-hook-events",
      "--setting-sources", "project,local",
      "--permission-mode", "acceptEdits",
      "--allowedTools", tools.join(","),
      ...(resume ? ["--resume", resume] : []),
      "--", prompt,
    ],
    cwd,
    out,
    env,
  );
}

const sessionIdOf = (run) => run.lines.find((l) => l.type === "system" && l.session_id)?.session_id ?? run.lines.find((l) => l.session_id)?.session_id;

const PROMPT_A =
  'Task T-1 (session expiry): sessions must expire. In src/auth/session.ts add `export type SessionOptions = { ttlMs: number }`, add `expiresAt: number` to Session, ' +
  "change createSession to `createSession(userId: string, opts: SessionOptions): Session` (expiresAt = createdAt + opts.ttlMs), and make getSession return undefined " +
  "(and forget the session) once Date.now() >= expiresAt. Update the existing caller in src/api/routes.ts to pass `{ ttlMs: 60 * 60 * 1000 }`, and update " +
  'test/session.test.ts for the new signature with one extra test for expiry. Run `node --test "test/**/*.test.ts"`, then reply with a one-line summary. Only touch those three files. ' +
  "Other agents work on this codebase at the same time; Weft may relay requests from them. Treat a reasonable request that is compatible with your task in good faith.";
const PROMPT_B1 =
  "Task T-2 (signup): add `POST /api/signup` taking a JSON body {email, name, password}. It registers the user with createUser from src/auth/users.ts and signs them in " +
  "right away by starting a session exactly the way login in src/api/routes.ts does, responding 201 with {token, user: publicUser(user)}; a UserError becomes 400 {error}. " +
  "Add the route to the accountRoutes array in src/api/account.ts and add test/signup.test.ts. For now ONLY read the relevant files and reply with a short plan that " +
  "includes the exact code you will write. Do not edit any file yet.";
const PROMPT_B2 = (cli) =>
  "Implement your plan now. Product rule for T-2: signup sessions use the platform's default lifetime, so the signup route must call createSession exactly as login " +
  "originally did, with the user id only; it must not choose session options itself. This checkout is coordinated by Weft with other agents. If Weft blocks an edit " +
  "because another agent changed an API you call, do not adapt your call to their new API: negotiate with that agent instead, proposing that they keep the old call " +
  `working as an overload, with \`${cli} negotiate propose overload "<what you need>" --wait 100\` (run \`${cli} inbox --wait 100\` if no reply came yet). ` +
  "Once they accept, continue with the old call. Only if they reject, adapt. The other agent's change will be merged before yours but is not in your checkout, " +
  'so typecheck errors about it here are expected. Run `node --test "test/**/*.test.ts"`, then reply with what you changed and how the negotiation went.';
const PROMPT_A_RESUME = "Continue: handle anything Weft reports for you, then reply with a one-line summary.";

async function oneRun(n) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-").toLowerCase();
  const repo = `demo-b11-${stamp}-r${n}`;
  const evidence = join(OUT, `run-${n}`);
  const work = join(process.env.WEFT_DEMO_DIR ?? tmpdir(), `weft-b11-${stamp}-r${n}`);
  rmSync(evidence, { recursive: true, force: true });
  mkdirSync(evidence, { recursive: true });
  mkdirSync(work, { recursive: true });
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
  const mint = async (spec) => (await api("POST", "/v1/admin/tokens", ADMIN, { ...spec, repos: [repo], label: `b11 ${stamp}` })).token;
  const tokA = await mint({ principal: "claude-a", scopes: ["agent", "observe"], agent: "claude-a" });
  const tokB = await mint({ principal: "claude-b", scopes: ["agent", "observe"], agent: "claude-b" });
  const tokObs = await mint({ principal: `b11-evidence-${stamp}`, scopes: ["observe"] });
  const tokSys = await mint({ principal: "weft-landing-queue", scopes: ["system", "observe"] });
  log(`run ${n}: repo ${repo} on ${URL_}, work ${work} (tokens minted, not printed)`);

  const install = (dir, tok, agent, task, title, priority) =>
    execFileSync(process.execPath, [CLAUDE_BUNDLE, "install", "--url", URL_, "--repo", repo, "--agent", agent, "--task", task, "--title", title, "--priority", String(priority)], {
      cwd: dir,
      env: { ...process.env, WEFT_TOKEN: tok },
      encoding: "utf8",
    });
  writeFileSync(join(evidence, "install.txt"), install(dirA, tokA, "claude-a", "T-1", "Session expiry", 1) + install(dirB, tokB, "claude-b", "T-2", "Signup endpoint", 0));
  const cliA = join(dirA, ".weft/bin/weft");
  const cliB = join(dirB, ".weft/bin/weft");
  const env = { ...process.env, WEFT_HOOK_TRACE: "1" };
  delete env.WEFT_TOKEN;

  const events = async () => (await api("GET", `/v1/repos/${repo}/events?after=0&limit=500`, tokObs)).events ?? [];
  const t0 = Date.now();
  const marks = {};
  const mark = (k) => (marks[k] ??= Date.now() - t0);

  // 1. B plans; A starts once B has joined.
  log("B1 (claude-b): read + plan");
  const b1p = claude(dirB, join(evidence, "b1-plan.jsonl"), PROMPT_B1, env);
  for (let i = 0; i < 240; i++) {
    if ((await events()).some((e) => e.kind === "join" && e.agent === "claude-b")) break;
    await sleep(500);
  }
  mark("b_joined");
  log("A (claude-a): change createSession's signature — concurrently with B");
  let aDone = false;
  let aRun = claude(dirA, join(evidence, "a-expiry.jsonl"), PROMPT_A, env, { cli: cliA }).then((r) => ((aDone = true), mark("a_done"), r));
  mark("a_started");

  let sigSeq;
  while (!sigSeq) {
    sigSeq = (await events()).find((e) => e.agent === "claude-a" && e.status === "accepted" && e.kind === "edit" && (e.writes ?? []).some((w) => w.key === SIG_KEY && w.kind === "signature"))?.seq;
    if (!sigSeq && aDone) break;
    if (!sigSeq) await sleep(1000);
  }
  mark("a_signature_accepted");
  const b1 = await b1p;
  const bSession = sessionIdOf(b1);
  log(`A's signature change: ${sigSeq ? `#${sigSeq}` : "NOT SEEN"}; B session ${bSession}`);

  // 3. B implements (resumed conversation); watch the negotiation from the log.
  log(`B2 (claude-b resume): implement — A ${aDone ? "already finished" : "still running"}`);
  const aRunningAtB2 = !aDone;
  mark("b2_started");
  let bDone = false;
  const b2p = claude(dirB, join(evidence, "b2-implement.jsonl"), PROMPT_B2(cliB), env, { resume: bSession, cli: cliB }).then((r) => ((bDone = true), mark("b2_done"), r));

  // 4. If A had already exited when the proposal arrived, resume it (neutral prompt).
  let aResumed = false;
  const a1 = await (async () => {
    for (;;) {
      const ev = await events();
      const prop = ev.find((e) => e.kind === "negotiate.propose" && e.agent === "claude-b" && e.status === "accepted");
      if (prop) mark("b_proposed");
      if (ev.some((e) => e.kind === "negotiate.accept")) mark("a_accepted");
      if (prop && aDone && !aResumed && !ev.some((e) => e.kind === "negotiate.accept" || e.kind === "negotiate.reject" || e.kind === "negotiate.counter")) {
        const first = await aRun;
        log(`A had exited before proposal #${prop.seq}; resuming A's conversation`);
        aResumed = true;
        mark("a_resumed");
        aDone = false;
        aRun = claude(dirA, join(evidence, "a-resume.jsonl"), PROMPT_A_RESUME, env, { resume: sessionIdOf(first), cli: cliA }).then((r) => ((aDone = true), mark("a_resume_done"), r));
        return first;
      }
      if (bDone && aDone) return aRun;
      if (bDone && !prop) return aRun;
      await sleep(1500);
    }
  })();
  const b2 = await b2p;
  const aLast = await aRun;
  const aFirst = aResumed ? a1 : aLast;

  // ------------------------------------------------------------- landing
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
  const changeOf = (dir) => JSON.parse(readFileSync(join(dir, ".weft/claude.json"), "utf8")).change;
  const lands = [];
  const landOne = async (branch, dir) => {
    try {
      execFileSync("git", ["-C", origin, "merge", "--no-ff", "--no-edit", branch], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const conflicts = tryRun("git", ["-C", origin, "diff", "--name-only", "--diff-filter=U"], origin).out.trim();
      tryRun("git", ["-C", origin, "merge", "--abort"], origin);
      return { ok: false, conflicts, error: String(err.stderr ?? err).slice(0, 500) };
    }
    const sha = git(origin, "rev-parse", "HEAD");
    const head = (await api("GET", `/v1/repos/${repo}/events?tail=1&limit=1`, tokObs)).head_seq;
    const rec = await api("POST", `/v1/repos/${repo}/system/events`, tokSys, { kind: "land", base_seq: head, change: changeOf(dir), payload: { sha, op_id: `b11-${stamp}-${branch}`, trunk_ref: "refs/heads/main" } });
    lands.push(rec);
    return { ok: rec.status === "accepted", sha, seq: rec.seq, status: rec.status };
  };
  const landA = await landOne("agent-a", dirA);
  const landB = landA.ok ? await landOne("agent-b", dirB) : { ok: false, error: "skipped" };
  const merged = checks(origin);
  const final = (rel) => (existsSync(join(origin, rel)) ? readFileSync(join(origin, rel), "utf8") : "");
  const accountTs = final("src/api/account.ts");
  const sessionTs = final("src/auth/session.ts");

  // ------------------------------------------------------------- evidence
  const full = [];
  for (const e of await events()) full.push(e.has_diff ? await api("GET", `/v1/repos/${repo}/events/${e.seq}`, tokObs) : e);
  writeFileSync(join(evidence, "coordinator-log.json"), JSON.stringify({ url: URL_, repo, events: full }, null, 2));
  for (const [who, dir] of [["a", dirA], ["b", dirB]])
    for (const f of ["adapter.log", "hooks.jsonl"]) {
      const p = join(dir, ".weft/log", f);
      if (existsSync(p)) writeFileSync(join(evidence, `${who}-${f}`), readFileSync(p, "utf8"));
    }
  writeFileSync(
    join(evidence, "landing.txt"),
    [
      `agent-a commit: ${commitA.ok ? commitA.message : commitA.error}`,
      `agent-b commit: ${commitB.ok ? commitB.message : commitB.error}`,
      `--- agent-a alone: tsc exit ${perBranch.a.tsc.code}, tests exit ${perBranch.a.test.code}`,
      `--- agent-b alone (A's change not merged yet): tsc exit ${perBranch.b.tsc.code}, tests exit ${perBranch.b.test.code}`,
      perBranch.b.tsc.out.trim(),
      `--- land agent-a: ${JSON.stringify(landA)}; land agent-b: ${JSON.stringify(landB)}`,
      git(origin, "log", "--oneline", "--graph", "-6"),
      `--- main after both landings: tsc exit ${merged.tsc.code}`,
      merged.tsc.out.trim(),
      `--- main: node --test exit ${merged.test.code}`,
      merged.test.out.split("\n").filter((l) => /^(ℹ|✔|✖)/.test(l)).join("\n"),
      `--- main:src/auth/session.ts`,
      sessionTs,
      `--- main:src/api/account.ts`,
      accountTs,
    ].join("\n") + "\n",
  );

  // ------------------------------------------------------------- verdict
  const readJsonl = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const aHooks = readJsonl(join(evidence, "a-hooks.jsonl"));
  const bHooks = readJsonl(join(evidence, "b-hooks.jsonl"));
  const rejectedB = full.find((e) => e.agent === "claude-b" && e.status === "rejected" && (e.diagnostics ?? []).some((d) => d.code === "stale_assumption" && d.caused_by_seq === sigSeq));
  const denied = bHooks.find((h) => h.event === "PreToolUse" && h.decision === "deny" && /stale_assumption/.test(h.injected ?? ""));
  const propose = full.find((e) => e.kind === "negotiate.propose" && e.agent === "claude-b" && e.status === "accepted" && e.payload?.terms?.kind === "overload");
  const accept = propose && full.find((e) => e.kind === "negotiate.accept" && e.agent === "claude-a" && e.payload?.reply_to === propose.seq);
  const injectedToA = propose && aHooks.find((h) => (h.injected ?? "").includes(`[weft negotiation] #${propose.seq}`) || (h.injected ?? "").includes(`#${propose.seq} from claude-b`));
  const fulfil = accept && full.find((e) => e.agent === "claude-a" && e.kind === "edit" && e.status === "accepted" && e.seq > accept.seq && (e.writes ?? []).some((w) => w.key === SIG_KEY));
  const signupCall = /createSession\(\s*([^()]*?)\s*\)/.exec(accountTs.slice(accountTs.indexOf("signup")))?.[1] ?? null;
  const resultOf = (r) => r.lines.find((l) => l.type === "result");
  const criteria = {
    b_denied_at_edit_time_by_a: !!rejectedB && !!denied,
    b_proposed_overload: !!propose,
    proposal_injected_into_a: !!injectedToA,
    a_accepted: !!accept,
    a_made_agreed_edit: !!fulfil,
    b_kept_old_call: signupCall !== null && !signupCall.includes(","),
    both_landed: landA.ok && landB.ok,
    tests_green: merged.tsc.code === 0 && merged.test.code === 0,
  };
  const usage = (r) => {
    const u = resultOf(r)?.usage;
    return u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0) : 0;
  };
  const runs = { a: aFirst, ...(aResumed ? { a_resume: aLast } : {}), b1, b2 };
  const summary = {
    run: n,
    repo,
    url: URL_,
    pass: Object.values(criteria).every(Boolean),
    criteria,
    seqs: { a_signature: sigSeq ?? null, b_rejected: rejectedB?.seq ?? null, propose: propose?.seq ?? null, accept: accept?.seq ?? null, a_fulfil: fulfil?.seq ?? null, lands: lands.map((l) => l.seq) },
    a_running_when_b2_started: aRunningAtB2,
    a_resumed_for_proposal: aResumed,
    proposal_reached_a_via: injectedToA ? `${injectedToA.event}${injectedToA.tool ? `:${injectedToA.tool}` : ""}` : null,
    signup_createSession_args: signupCall,
    timeline_ms: marks,
    harness_exit: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { code: r.code, result: resultOf(r)?.subtype ?? null, ms: r.ms, tokens: usage(r), cost_usd: resultOf(r)?.total_cost_usd ?? null }])),
    work,
  };
  writeFileSync(join(evidence, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(evidence, "transcript.md"), transcript(summary, full, aHooks, bHooks, runs, readFileSync(join(evidence, "landing.txt"), "utf8")));
  log(`run ${n}: ${summary.pass ? "PASS" : "FAIL"} ${JSON.stringify(criteria)}`);
  return summary;
}

/** Human-readable evidence: the log, what each model was shown, what each model said. */
function transcript(summary, full, aHooks, bHooks, runs, landing) {
  const L = [];
  L.push(`# B11 negotiation run ${summary.run} — ${summary.pass ? "PASS" : "FAIL"}`, "");
  L.push(`Coordinator: ${summary.url}, repo \`${summary.repo}\`. Agents: claude-a (T-1, priority 1), claude-b (T-2, priority 0), both \`claude -p\` with the Weft Claude Code adapter.`, "");
  L.push("## Criteria", "", ...Object.entries(summary.criteria).map(([k, v]) => `- ${v ? "✔" : "✖"} ${k}`), "");
  L.push("## Coordinator log (every record)", "", "| seq | status | kind | summary |", "|---|---|---|---|");
  for (const e of full) L.push(`| ${e.seq} | ${e.status} | ${e.kind} | ${String(e.summary).replace(/\|/g, "\\|")} |`);
  L.push("");
  const shown = (hooks, who) => {
    L.push(`## What Weft injected into ${who} (verbatim, in order)`, "");
    for (const h of hooks.filter((x) => x.injected)) {
      L.push(`### ${h.ts.slice(11, 19)} ${h.event}${h.tool ? ` ${h.tool}` : ""}${h.decision ? ` → ${h.decision}` : ""}`, "", "```text", h.injected.trim(), "```", "");
    }
  };
  shown(bHooks, "claude-b");
  shown(aHooks, "claude-a");
  const said = (r, who) => {
    if (!r) return;
    L.push(`## ${who}: tool calls and final answer`, "");
    for (const l of r.lines) {
      if (l.type === "assistant")
        for (const c of l.message?.content ?? []) {
          if (c.type === "tool_use" && c.name === "Bash") L.push(`- Bash: \`${String(c.input?.command ?? "").slice(0, 400)}\``);
          else if (c.type === "tool_use") L.push(`- ${c.name} ${c.input?.file_path ?? ""}`);
        }
      if (l.type === "user")
        for (const c of l.message?.content ?? [])
          if (c.type === "tool_result" && /\[weft\]|weft:/.test(JSON.stringify(c.content ?? "")) && /negotiat|sent #|ACCEPTED|rejected/.test(JSON.stringify(c.content ?? "")))
            L.push("", "  ```text", ...String(Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join("\n") : c.content).trim().split("\n").map((x) => `  ${x}`), "  ```", "");
    }
    const res = r.lines.find((l) => l.type === "result");
    if (res?.result) L.push("", "Final answer:", "", "> " + String(res.result).trim().split("\n").join("\n> "), "");
  };
  said(runs.b2, "claude-b (turn 2)");
  said(runs.a, "claude-a");
  said(runs.a_resume, "claude-a (resumed)");
  L.push("## Landing", "", "```text", landing.trim(), "```", "");
  return L.join("\n");
}

execFileSync(process.execPath, [join(dirname(dirname(CLAUDE_BUNDLE)), "scripts/build.mjs")], { stdio: "inherit" });
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
