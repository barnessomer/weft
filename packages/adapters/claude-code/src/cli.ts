// `weft-adapter-claude` CLI (bundled to dist/weft-claude.mjs).
//
//   install        configure a checkout: .weft/claude.json (+ token file), .claude/settings.json
//                  hooks, git commit-msg (Change-Id/Task-Id/Agent-Id trailers) + pre-commit gate
//   hook           Claude Code hook entry: JSON on stdin -> JSON on stdout (always exit 0)
//   commit-msg F   git commit-msg hook
//   pre-commit     git pre-commit hook (last gate: refuses while the session has open errors)
//   heartbeat-loop keep a WCP session alive between hooks (spawned detached by SessionStart)
//   status         print config (never the token) and session state
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpTransport } from "./client";
import { CONFIG_REL, currentSession, loadConfig, readState, stateDir, type AdapterConfig, type Loaded } from "./config";
import { ClaudeAdapter, type HookInput } from "./hooks";

const SELF = fileURLToPath(import.meta.url);
const HOOK_MARK = "weft-claude";

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk.toString();
  return text;
}

function adapterFor(loaded: Loaded): ClaudeAdapter {
  const transport = new HttpTransport(loaded.config.url, loaded.token, loaded.config.repo, loaded.config.timeoutMs ?? 8000);
  return new ClaudeAdapter(loaded, {
    transport,
    analyze: async (changes, root, prefix) => (await import("./analysis")).analyzeChanges(changes, root, prefix),
    diff: async (rel, before, after) => (await import("./analysis")).unifiedDiff(rel, before, after),
    startHeartbeat: (claudeSession) => {
      try {
        spawn(process.execPath, [SELF, "heartbeat-loop", claudeSession, "--root", loaded.root], { detached: true, stdio: "ignore" }).unref();
      } catch {
        /* heartbeat is best-effort; sessions re-hello on expiry */
      }
    },
  });
}

async function hook(): Promise<void> {
  let out: unknown;
  try {
    const input = JSON.parse(await readStdin()) as HookInput;
    const loaded = loadConfig(input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
    if (loaded) out = await adapterFor(loaded).handle(input);
  } catch {
    out = undefined; // fail open: malformed input or a bug must not block Claude
  }
  if (out) process.stdout.write(JSON.stringify(out));
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\/.:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> };

/** Merge Weft hooks into a Claude settings object, replacing any previous Weft entries. */
export function mergeSettings(settings: Record<string, unknown>, command: string): Record<string, unknown> {
  const hooks = { ...((settings.hooks as Record<string, HookEntry[]>) ?? {}) };
  const ours = (matcher?: string): HookEntry => ({ ...(matcher !== undefined ? { matcher } : {}), hooks: [{ type: "command", command, timeout: 30 }] });
  const want: Record<string, HookEntry> = {
    SessionStart: ours(),
    UserPromptSubmit: ours(),
    PreToolUse: ours("Edit|Write|MultiEdit|Bash"),
    PostToolUse: ours("*"),
    Stop: ours(),
    SessionEnd: ours(),
  };
  for (const [event, entry] of Object.entries(want)) {
    const kept = (hooks[event] ?? [])
      .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !h.command.includes(HOOK_MARK)) }))
      .filter((e) => e.hooks.length);
    hooks[event] = [...kept, entry];
  }
  return { ...settings, hooks };
}

const COMMIT_MSG = (node: string) => `#!/bin/sh
# weft-claude: add Change-Id / Task-Id / Agent-Id trailers (installed by weft-adapter-claude)
exec ${shellQuote(node)} ${shellQuote(SELF)} commit-msg "$1"
`;
const PRE_COMMIT = (node: string) => `#!/bin/sh
# weft-claude: last gate — refuse the commit while this checkout's Weft session has open errors
exec ${shellQuote(node)} ${shellQuote(SELF)} pre-commit
`;

async function install(args: string[]): Promise<void> {
  const dir = resolve(arg(args, "dir") ?? process.cwd());
  const root = git(dir, ["rev-parse", "--show-toplevel"]);
  const cfgPath = join(root, CONFIG_REL);
  const prev: Partial<AdapterConfig> = existsSync(cfgPath) ? (JSON.parse(readFileSync(cfgPath, "utf8")) as AdapterConfig) : {};
  const taskId = arg(args, "task") ?? prev.task?.id ?? "adhoc";
  const title = arg(args, "title") ?? prev.task?.title;
  const priority = arg(args, "priority") !== undefined ? Number(arg(args, "priority")) : prev.task?.priority;
  const config: AdapterConfig = {
    url: arg(args, "url") ?? prev.url ?? process.env.WEFT_URL ?? "",
    repo: arg(args, "repo") ?? prev.repo ?? "",
    agent: arg(args, "agent") ?? prev.agent ?? "",
    task: { id: taskId, ...(title ? { title } : {}), ...(priority !== undefined && !Number.isNaN(priority) ? { priority } : {}) },
    change: arg(args, "change") ?? (prev.task?.id === taskId && prev.change ? prev.change : `I${createHash("sha1").update(randomBytes(32)).digest("hex")}`),
    ...((arg(args, "prefix") ?? prev.prefix) ? { prefix: arg(args, "prefix") ?? prev.prefix } : {}),
    mode: (arg(args, "mode") as AdapterConfig["mode"]) ?? prev.mode ?? "enforce",
    tokenFile: arg(args, "token-file") ?? prev.tokenFile ?? ".weft/token",
  };
  const missing = (["url", "repo", "agent"] as const).filter((k) => !config[k]);
  if (missing.length) throw new Error(`install: missing --${missing.join(", --")}`);
  mkdirSync(join(root, ".weft"), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(config, null, 2) + "\n");
  if (process.env.WEFT_TOKEN) {
    const tokenPath = resolve(root, config.tokenFile!);
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, process.env.WEFT_TOKEN.trim() + "\n", { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
  }

  // .weft/ never enters git (token, state, logs)
  const exclude = resolve(root, git(root, ["rev-parse", "--git-path", "info/exclude"]));
  mkdirSync(dirname(exclude), { recursive: true });
  const ex = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!ex.split("\n").includes(".weft/")) writeFileSync(exclude, `${ex}${ex && !ex.endsWith("\n") ? "\n" : ""}.weft/\n`);

  // Claude Code hooks (project settings)
  const command = `${shellQuote(process.execPath)} ${shellQuote(SELF)} hook`;
  const settingsPath = join(root, ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  const settings = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>) : {};
  writeFileSync(settingsPath, JSON.stringify(mergeSettings(settings, command), null, 2) + "\n");

  // git hooks (worktree-aware hooks dir; respect core.hooksPath)
  let hooksDir: string;
  try {
    hooksDir = resolve(root, git(root, ["config", "core.hooksPath"]));
  } catch {
    hooksDir = resolve(root, git(root, ["rev-parse", "--git-path", "hooks"]));
  }
  mkdirSync(hooksDir, { recursive: true });
  for (const [name, body] of [["commit-msg", COMMIT_MSG(process.execPath)], ["pre-commit", PRE_COMMIT(process.execPath)]] as const) {
    const p = join(hooksDir, name);
    if (existsSync(p) && !readFileSync(p, "utf8").includes(HOOK_MARK)) {
      writeFileSync(`${p}.pre-weft`, readFileSync(p));
      process.stderr.write(`weft: existing ${name} hook moved to ${name}.pre-weft (not chained)\n`);
    }
    writeFileSync(p, body, { mode: 0o755 });
    chmodSync(p, 0o755);
  }
  const hasToken = existsSync(resolve(root, config.tokenFile!)) || !!process.env.WEFT_TOKEN;
  process.stdout.write(
    `weft: installed Claude Code adapter in ${root}\n` +
      `  coordinator ${config.url} repo ${config.repo} agent ${config.agent} task ${config.task.id} change ${config.change}\n` +
      `  hooks: ${settingsPath}\n  git hooks: ${hooksDir}/commit-msg, pre-commit\n` +
      (hasToken ? "" : `  NOTE: no token yet — write it to ${config.tokenFile} (mode 600) or export WEFT_TOKEN\n`),
  );
}

function commitMsg(file: string): void {
  const loaded = loadConfig(process.cwd());
  if (!loaded) return;
  const { config } = loaded;
  execFileSync("git", [
    "interpret-trailers", "--in-place", "--if-exists", "doNothing",
    "--trailer", `Change-Id: ${config.change}`,
    "--trailer", `Task-Id: ${config.task.id}`,
    "--trailer", `Agent-Id: ${config.agent}`,
    file,
  ]);
}

async function preCommit(): Promise<number> {
  const loaded = loadConfig(process.cwd());
  if (!loaded) return 0;
  const session = currentSession(loaded.root);
  if (!session) return 0;
  const refusal = await adapterFor(loaded).commitGate(session);
  if (!refusal) return 0;
  process.stderr.write(`${refusal}\n`);
  return 1;
}

async function heartbeatLoop(claudeSession: string, rootArg?: string): Promise<void> {
  const loaded = loadConfig(rootArg ?? process.cwd());
  if (!loaded) return;
  const adapter = adapterFor(loaded);
  const intervalMs = 30_000;
  const idleLimitMs = 30 * 60_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (!(await adapter.beat(claudeSession, idleLimitMs).catch(() => false))) return;
  }
}

function status(): void {
  const loaded = loadConfig(process.cwd());
  if (!loaded) {
    process.stdout.write("weft: not configured here (no .weft/claude.json or no token)\n");
    return;
  }
  const { config, root } = loaded;
  process.stdout.write(`${JSON.stringify({ root, ...config, token: "(set)" }, null, 2)}\n`);
  try {
    for (const f of readdirSync(stateDir(root)).filter((x) => x.endsWith(".json"))) {
      const st = readState(root, f.replace(/\.json$/, ""));
      process.stdout.write(`session ${st.claudeSession}: wcp ${st.wcpSession ?? "-"} base #${st.base} acked ${st.acked}${st.rebaseFloor ? ` floor #${st.rebaseFloor.seq}` : ""}\n`);
    }
  } catch {
    /* no state yet */
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "hook":
      return hook();
    case "install":
      return install(args);
    case "commit-msg":
      return commitMsg(args[0]);
    case "pre-commit":
      process.exitCode = await preCommit();
      return;
    case "heartbeat-loop":
      return heartbeatLoop(args[0], arg(args, "root"));
    case "status":
      return status();
    default:
      process.stderr.write("usage: weft-adapter-claude install --url URL --repo REPO --agent ID --task ID [--title T] [--priority N] [--prefix P] [--mode enforce|advise]\n       weft-adapter-claude hook|commit-msg FILE|pre-commit|status\n");
      process.exitCode = cmd ? 2 : 0;
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === SELF || /weft-adapter-claude(\.mjs)?$/.test(entry)) {
  main().catch((err) => {
    process.stderr.write(`weft: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = process.argv[2] === "hook" ? 0 : 1;
  });
}
