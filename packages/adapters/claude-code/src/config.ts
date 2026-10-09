// Adapter configuration and per-Claude-session state, both under `<checkout>/.weft/`
// (excluded from git by the installer). Hook processes are short-lived and may run
// concurrently (parallel tool calls), so state is a JSON file guarded by a lock dir.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { editPath } from "./edits";
import type { HookInput } from "./hooks";

export type Mode = "enforce" | "advise";

export type AdapterConfig = {
  url: string;
  repo: string;
  agent: string;
  task: { id: string; title?: string; priority?: number };
  /** WCP change id = the commit `Change-Id` trailer (spec §8.2). */
  change: string;
  /** Prefix prepended to checkout-relative paths to form repo paths in symbol keys. */
  prefix?: string;
  mode?: Mode;
  /** Path (relative to the checkout) of the file holding the agent token. Default `.weft/token`. */
  tokenFile?: string;
  /** Consecutive Stop refusals for the same open errors before letting Claude stop anyway. */
  maxStopRefusals?: number;
  timeoutMs?: number;
};

export type Loaded = { root: string; config: AdapterConfig; token: string };

export const CONFIG_REL = ".weft/claude.json";

/** Walk up from `start` to the first directory holding `.weft/claude.json`. */
export function findRoot(start: string, configRel: string = CONFIG_REL): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, configRel))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The directory a Bash command works in, when it says so: `cd <dir>` (first in the command, or
 * after `&&`, `;`, `|`) or `git -C <dir>`. Relative paths resolve against cwd. Undefined when the
 * command names no directory, so the caller falls back to cwd.
 */
export function bashTargetDir(command: string, cwd: string): string | undefined {
  const re = /(?:^|[;&|]\s*)cd\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))|\bgit\s+-C\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))/;
  const m = re.exec(command);
  if (!m) return undefined;
  const raw = m[2] ?? m[3] ?? m[4] ?? m[6] ?? m[7] ?? m[8];
  if (!raw) return undefined;
  // A leading ~ and $VAR / ${VAR} come from the environment; an unknown variable means unknown, not cwd.
  const dir = raw.replace(/^~(?=\/|$)/, homedir()).replace(/\$\{?(\w+)\}?/g, (_, v: string) => process.env[v] ?? "\u0000");
  if (dir.includes("\u0000")) return undefined;
  return resolve(cwd, dir);
}

/**
 * Where to look for `.weft/claude.json`. By default the session's cwd. With `byPath` (the
 * `weft-worker` subagent's hooks) the edited file's own checkout comes first: a subagent runs in
 * the parent session's cwd but edits inside its own joined worktree, which must be the agent it
 * acts as. Lives here, not in cli.ts, because host.ts (the shared Host for Cursor, OpenCode and
 * Gemini) cannot import cli.ts; Host.load does not use it yet (#11).
 */
export function configStarts(input: HookInput, byPath: boolean, fallback: string = process.cwd()): string[] {
  const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? fallback;
  if (!byPath) return [cwd];
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  const file = editPath(ti);
  const dir0 = file ? dirname(resolve(cwd, file)) : input.tool_name === "Bash" && typeof ti.command === "string" ? bashTargetDir(ti.command, cwd) : undefined;
  if (!dir0) return [cwd];
  // Only the target's own checkout counts: an unjoined worktree nested inside a joined one must
  // not resolve to its parent's agent.
  for (let dir = dir0; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return existsSync(join(dir, CONFIG_REL)) ? [dir, cwd] : [cwd];
    if (dirname(dir) === dir) return [cwd];
  }
}

export function loadConfig(start: string, env: NodeJS.ProcessEnv = process.env, configRel: string = CONFIG_REL): Loaded | undefined {
  const root = env.WEFT_ROOT ? resolve(env.WEFT_ROOT) : findRoot(start, configRel);
  if (!root) return undefined;
  let config: AdapterConfig;
  try {
    config = JSON.parse(readFileSync(join(root, configRel), "utf8")) as AdapterConfig;
  } catch {
    return undefined;
  }
  if (env.WEFT_URL) config.url = env.WEFT_URL;
  if (env.WEFT_MODE === "advise" || env.WEFT_MODE === "enforce") config.mode = env.WEFT_MODE;
  let token = env.WEFT_TOKEN ?? "";
  if (!token) {
    try {
      token = readFileSync(resolve(root, config.tokenFile ?? ".weft/token"), "utf8").trim();
    } catch {
      token = "";
    }
  }
  if (!config.url || !config.repo || !config.agent || !config.change || !config.task?.id || !token) return undefined;
  return { root, config, token };
}

export type PendingEdit = {
  tool: string;
  /** checkout-relative path -> text before the tool ran (null = file did not exist). */
  before: Record<string, string | null>;
  /** Context already shown to the model by PreToolUse for this call (avoid repeats). */
  shown: string[];
  /** HEAD before the call ran: a file the call both edited and committed is compared with it. */
  head?: string;
  at: number;
};

export type SessionState = {
  claudeSession: string;
  wcpSession?: string;
  /** base_seq: last delivered_through whose content reached the model (spec §5.2). */
  base: number;
  /** Highest inbox id injected into the model (acked on the next request, spec §5.4). */
  acked: number;
  /** Keep base below this until the checkout contains the landing (spec §5.2). */
  rebaseFloor?: { seq: number; sha?: string };
  pending: Record<string, PendingEdit>;
  head?: string;
  stopRefusals?: { fingerprint: string; count: number };
  lastContact: number;
};

export function stateDir(root: string): string {
  return join(root, ".weft", "state");
}

function statePath(root: string, claudeSession: string): string {
  return join(stateDir(root), `${claudeSession.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function readState(root: string, claudeSession: string): SessionState {
  try {
    return JSON.parse(readFileSync(statePath(root, claudeSession), "utf8")) as SessionState;
  } catch {
    return { claudeSession, base: 0, acked: 0, pending: {}, lastContact: 0 };
  }
}

export function writeState(root: string, state: SessionState): void {
  mkdirSync(stateDir(root), { recursive: true });
  const path = statePath(root, state.claudeSession);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
  writeFileSync(join(stateDir(root), "current"), state.claudeSession);
}

/** Most recently active Claude session in this checkout (used by git hooks). */
export function currentSession(root: string): string | undefined {
  const dir = stateDir(root);
  try {
    const named = readFileSync(join(dir, "current"), "utf8").trim();
    if (named) return named;
  } catch {
    /* fall through */
  }
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    return files[0]?.replace(/\.json$/, "");
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serialize state read-modify-write across concurrent hook processes. */
export async function withLock<T>(root: string, claudeSession: string, fn: () => Promise<T>, waitMs = 15_000): Promise<T> {
  mkdirSync(stateDir(root), { recursive: true });
  const lock = `${statePath(root, claudeSession)}.lock`;
  const deadline = Date.now() + waitMs;
  let owned = false;
  for (;;) {
    try {
      mkdirSync(lock);
      owned = true;
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* raced with the owner releasing it */
      }
      if (Date.now() > deadline) break; // proceed unlocked rather than hang the harness
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    if (owned) rmSync(lock, { recursive: true, force: true });
  }
}
