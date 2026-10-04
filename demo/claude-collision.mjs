#!/usr/bin/env node
// Two real Claude Code sessions, one Weft coordinator: the demo collision (design §8.2).
//
//   claude-b (task T-2) reads the shop code and plans a cart total that calls calcTotal().
//   claude-a (task T-1) then changes calcTotal's signature (adds tax options) in ITS checkout.
//   claude-b resumes and writes the call the old way -> the Weft PreToolUse hook denies the
//   edit with a positioned stale_assumption squiggle quoting A's diff -> B changes course.
//
// Usage (from the repo root; needs `claude` logged in and the preview admin token file):
//   node demo/claude-collision.mjs              # scenario "reroute" -> demo/evidence/claude-collision/
//   node demo/claude-collision.mjs stop-gate    # B is told to give up when blocked; the Stop
//                                               # gate refuses to let it finish -> demo/evidence/claude-stop-gate/
//
// Env: WEFT_URL (default: preview gateway), WEFT_ADMIN_TOKEN_FILE (default
// ~/.config/weft/preview-admin-token). Tokens are minted per run and never printed.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const BUNDLE = join(REPO, "packages/adapters/claude-code/dist/weft-claude.mjs");
const TSC = join(REPO, "packages/adapters/claude-code/node_modules/.bin/tsc");
const URL_ = (process.env.WEFT_URL ?? "https://weft-gateway-preview.redacted-subdomain.workers.dev").replace(/\/+$/, "");
const ADMIN = readFileSync((process.env.WEFT_ADMIN_TOKEN_FILE ?? "~/.config/weft/preview-admin-token").replace(/^~/, homedir()), "utf8").trim();
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const repo = `demo-claude-${stamp.toLowerCase()}`;
const work = join(process.env.WEFT_DEMO_DIR ?? tmpdir(), `weft-claude-demo-${stamp}`);
const SCENARIO = process.argv[2] ?? "reroute";
if (!["reroute", "stop-gate"].includes(SCENARIO)) throw new Error(`unknown scenario ${SCENARIO}`);
const evidence = join(REPO, SCENARIO === "reroute" ? "demo/evidence/claude-collision" : "demo/evidence/claude-stop-gate");

const log = (m) => console.log(`[demo] ${m}`);
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function admin(method, path, body) {
  const r = await fetch(URL_ + path, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, "wcp-version": "0.1", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${JSON.stringify(json?.error ?? json)}`);
  return json;
}

function claude(cwd, out, prompt, extra = []) {
  const args = [
    "-p", "--verbose", "--output-format", "stream-json", "--include-hook-events",
    "--setting-sources", "project,local",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read,Edit,Write,MultiEdit,Glob,Grep,Bash(git status:*),Bash(git diff:*),Bash(git log:*)",
    ...extra, "--", prompt,
  ];
  writeFileSync(out.replace(/\.jsonl$/, ".prompt.txt"), `cwd: ${cwd}\nclaude ${extra.join(" ")} -p …\n\n${prompt}\n`);
  return new Promise((res, rej) => {
    const env = { ...process.env };
    delete env.WEFT_TOKEN;
    const child = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      writeFileSync(out, stdout);
      if (stderr.trim()) writeFileSync(out.replace(/\.jsonl$/, ".stderr.txt"), stderr);
      const lines = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const result = lines.find((l) => l.type === "result");
      const sessionId = lines.find((l) => l.session_id)?.session_id;
      if (code !== 0 && !result) return rej(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      res({ sessionId, result: result?.result ?? "", lines });
    });
  });
}

// ------------------------------------------------------------------ setup
if (!existsSync(BUNDLE)) execFileSync(process.execPath, [join(REPO, "packages/adapters/claude-code/scripts/build.mjs")], { stdio: "inherit" });
rmSync(evidence, { recursive: true, force: true });
mkdirSync(evidence, { recursive: true });
mkdirSync(work, { recursive: true });
const origin = join(work, "origin");
cpSync(join(REPO, "demo/ts-shop"), origin, { recursive: true });
git(origin, "init", "-q", "-b", "main");
git(origin, "config", "user.email", "demo@weft.invalid");
git(origin, "config", "user.name", "weft demo");
git(origin, "add", "-A");
git(origin, "commit", "-qm", "ts-shop: initial");
const dirA = join(work, "agent-a");
const dirB = join(work, "agent-b");
git(origin, "worktree", "add", "-q", dirA, "-b", "agent-a");
git(origin, "worktree", "add", "-q", dirB, "-b", "agent-b");
log(`checkouts: ${dirA}, ${dirB}`);

await admin("POST", "/v1/admin/repos", { repo });
const token = async (spec) => (await admin("POST", "/v1/admin/tokens", spec)).token;
const tokA = await token({ principal: "claude-a", scopes: ["agent", "observe"], repos: [repo], agent: "claude-a", label: `demo ${stamp}` });
const tokB = await token({ principal: "claude-b", scopes: ["agent", "observe"], repos: [repo], agent: "claude-b", label: `demo ${stamp}` });
const tokObs = await token({ principal: `demo-evidence-${stamp}`, scopes: ["observe"], repos: [repo], label: `demo ${stamp}` });
log(`coordinator ${URL_} repo ${repo} (tokens minted, not printed)`);

const install = (dir, tok, agent, task, title, priority) =>
  execFileSync(process.execPath, [BUNDLE, "install", "--url", URL_, "--repo", repo, "--agent", agent, "--task", task, "--title", title, "--priority", String(priority)], {
    cwd: dir,
    env: { ...process.env, WEFT_TOKEN: tok },
    encoding: "utf8",
  });
writeFileSync(join(evidence, "install.txt"), install(dirA, tokA, "claude-a", "T-1", "Apply tax in calcTotal", 1) + install(dirB, tokB, "claude-b", "T-2", "Show the cart total", 0));

// ------------------------------------------------------------------ the scenario
log("B turn 1: read + plan (no edits)");
const b1 = await claude(
  dirB,
  join(evidence, "b1-plan.jsonl"),
  "Task T-2: the Cart class in src/cart.ts needs a `total(): number` method that returns the cart total, computed with the existing `calcTotal` helper from src/pricing.ts. " +
    "For now only read src/pricing.ts and src/cart.ts and reply with a 3-line plan including the exact code line you will write for the method body. Do not edit any file yet.",
);
log(`B session ${b1.sessionId}: ${b1.result.split("\n")[0]}`);

log("A: change calcTotal's signature");
const a = await claude(
  dirA,
  join(evidence, "a-signature.jsonl"),
  "Task T-1: prices must include tax. In src/pricing.ts add `export type PriceOptions = { taxRate: number }` and change calcTotal to `calcTotal(items: Item[], opts: PriceOptions): number` returning the net sum multiplied by (1 + opts.taxRate). " +
    "Update the existing caller in src/orders.ts (use taxRate 0.22). Keep it minimal, then reply with a one-line summary.",
);
log(`A: ${a.result.split("\n")[0]}`);

log("B turn 2: implement (resumed session — still believes the old signature)");
const b2 = await claude(
  dirB,
  join(evidence, "b2-implement.jsonl"),
  SCENARIO === "reroute"
    ? "Go ahead and implement the plan now. If the Weft coordinator reports a conflict, adapt your code to it. When you are done, reply with the final method and one sentence on anything that changed from your plan."
    : "Implement the plan now, exactly as planned. If a hook blocks one of your edits, do not retry or adapt anything: reply with what the hook said and end your turn.",
  ["--resume", b1.sessionId],
);
log(`B: ${b2.result.split("\n")[0]}`);

// ------------------------------------------------------------------ evidence
const obs = async (path) => (await fetch(URL_ + path, { headers: { authorization: `Bearer ${tokObs}`, "wcp-version": "0.1" } })).json();
const page = await obs(`/v1/repos/${repo}/events?after=0&limit=200`);
const events = [];
for (const e of page.events ?? []) events.push(e.has_diff ? await obs(`/v1/repos/${repo}/events/${e.seq}`) : e);
writeFileSync(join(evidence, "coordinator-log.json"), JSON.stringify({ url: URL_, repo, events }, null, 2));
for (const [who, dir] of [["a", dirA], ["b", dirB]]) {
  const p = join(dir, ".weft/log/adapter.log");
  if (existsSync(p)) writeFileSync(join(evidence, `adapter-${who}.log`), readFileSync(p, "utf8"));
}

// land both branches (commit through the installed git hooks), then typecheck the result
const commit = (dir, msg) => {
  git(dir, "add", "-A");
  try {
    return git(dir, "commit", "-qm", msg) || "committed";
  } catch (err) {
    return `commit refused: ${String(err.stderr ?? err)}`;
  }
};
const landing = [];
landing.push(`agent-a: ${commit(dirA, "pricing: apply tax in calcTotal")}`);
landing.push(`agent-b: ${commit(dirB, "cart: add total()")}`);
landing.push(`agent-a HEAD:\n${git(dirA, "log", "-1", "--format=%B")}`);
landing.push(`agent-b HEAD:\n${git(dirB, "log", "-1", "--format=%B")}`);
landing.push(`--- B checkout alone (A's change not merged yet): tsc`);
const tsc = (cwd) => {
  try {
    execFileSync(TSC, ["-p", "."], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return "tsc: exit 0 (clean)";
  } catch (err) {
    return `tsc: exit ${err.status}\n${err.stdout}`;
  }
};
landing.push(tsc(dirB));
git(origin, "merge", "-q", "--no-edit", "agent-a");
git(origin, "merge", "-q", "--no-edit", "agent-b");
landing.push(`--- main after merging agent-a then agent-b:\n${git(origin, "log", "--oneline", "-4")}`);
landing.push(tsc(origin));
landing.push(`--- main:src/cart.ts\n${readFileSync(join(origin, "src/cart.ts"), "utf8")}`);
landing.push(`--- main:src/pricing.ts\n${readFileSync(join(origin, "src/pricing.ts"), "utf8")}`);
writeFileSync(join(evidence, "landing.txt"), landing.join("\n") + "\n");
writeFileSync(join(evidence, "run.json"), JSON.stringify({ scenario: SCENARIO, stamp, url: URL_, repo, work, b_session: b1.sessionId, a_session: a.sessionId }, null, 2));
log(`evidence in ${evidence}`);
console.log(landing.join("\n"));
