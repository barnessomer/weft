// Harness-agnostic L0 adapter: watch a checkout and report every file change to the
// coordinator after the fact (WCP §8.1 L0 "observe"). Works under any agent or editor —
// no hooks needed — at the price of the guarantees hooks give: nothing reaches the model,
// and nothing can be blocked before it is written. What it can do:
//
//   - observe: each changed file is diffed against the watcher's last snapshot of it, analyzed
//     (reads/writes) and submitted as a `commit` edit event, so other agents' R1/R2 checks
//     see this checkout's work in near real time;
//   - tell the human: verdicts, diagnostics and inbox items are printed (stdout + log);
//   - gate commits: the git pre-commit hook refuses a commit while this checkout's session
//     has open errors (git's own hook; `--no-verify` bypasses it).
//
// It reuses the shared core by feeding it synthetic hook events: SessionStart at start,
// PostToolUse Write per changed file (with the snapshot as the pre-edit text), a periodic
// PostToolUse Bash tick (inbox drain + checkpoint when HEAD moves), SessionEnd on exit.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Loaded } from "../../claude-code/src/config";
import type { Host } from "../../claude-code/src/host";
import type { HookOutput } from "../../claude-code/src/hooks";

export const WATCH_SESSION = "watcher";
const SKIP = new Set([".git", ".weft", ".claude", ".cursor", ".opencode", ".gemini", "node_modules", "dist", ".wrangler", ".turbo"]);
const MAX_BYTES = 1 << 20;

export type Report = { rel: string; text: string; verdict?: string };

function textOf(out: HookOutput): string {
  const o = (out ?? {}) as { reason?: string; hookSpecificOutput?: { additionalContext?: string } };
  return [o.hookSpecificOutput?.additionalContext, o.reason].filter(Boolean).join("\n");
}

export class Watcher {
  private snapshot = new Map<string, string | null>();
  private seq = 0;

  constructor(
    private readonly host: Host,
    private readonly loaded: Loaded,
    private readonly print: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
    private readonly session: string = WATCH_SESSION,
  ) {}

  get root(): string {
    return this.loaded.root;
  }

  private git(args: string[]): string | undefined {
    try {
      return execFileSync("git", ["-C", this.root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
    } catch {
      return undefined;
    }
  }

  private read(rel: string): string | null {
    const abs = join(this.root, rel);
    try {
      if (!existsSync(abs) || statSync(abs).isDirectory() || statSync(abs).size > MAX_BYTES) return null;
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  }

  /** Paths this watcher cares about: inside the checkout, not in tool/build dirs, not git-ignored. */
  relevant(pathOrRel: string): string | undefined {
    const abs = resolve(this.root, pathOrRel);
    const rel = relative(this.root, abs);
    if (!rel || rel.startsWith("..")) return undefined;
    const parts = rel.split(sep);
    if (parts.some((p) => SKIP.has(p))) return undefined;
    if (this.git(["check-ignore", "-q", "--", rel]) !== undefined) return undefined; // exit 0 = ignored
    return parts.join("/");
  }

  /** Snapshot every tracked + untracked non-ignored file; say hello. */
  async start(): Promise<void> {
    const files = (this.git(["ls-files", "-co", "--exclude-standard", "-z"]) ?? "").split("\0").filter(Boolean);
    for (const rel of files) if (!rel.split("/").some((p) => SKIP.has(p))) this.snapshot.set(rel, this.read(rel));
    const out = await this.host.run(this.loaded, { hook_event_name: "SessionStart", session_id: this.session, cwd: this.root, source: "startup" }, { watcher: "start" });
    const text = textOf(out);
    this.print(`[weft-watch] watching ${this.root} (${this.snapshot.size} files) as ${this.loaded.config.agent}, task ${this.loaded.config.task.id} — L0: edits are reported after the fact; nothing is blocked.`);
    const rest = text.split("\n").slice(1).join("\n").trim(); // first line is the model-facing welcome
    if (rest) this.print(rest);
  }

  /** Report the files among `paths` whose text changed since the last snapshot. */
  async process(paths: Iterable<string>): Promise<Report[]> {
    const reports: Report[] = [];
    const seen = new Set<string>();
    for (const p of paths) {
      const rel = this.relevant(p);
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      const before = this.snapshot.has(rel) ? this.snapshot.get(rel)! : this.git(["show", `HEAD:${rel}`]) ?? null;
      const after = this.read(rel);
      if (before === after) continue;
      this.snapshot.set(rel, after);
      const callId = `watch-${Date.now()}-${++this.seq}`;
      await this.host.seedBefore(this.root, this.session, callId, "Write", { [rel]: before });
      const out = await this.host.run(this.loaded, { hook_event_name: "PostToolUse", session_id: this.session, cwd: this.root, tool_name: "Write", tool_input: { file_path: join(this.root, rel) }, tool_use_id: callId }, { watcher: "change" });
      const text = textOf(out);
      reports.push({ rel, text });
      this.print(`[weft-watch] ${after === null ? "deleted" : "changed"} ${rel}${text ? `\n${text}` : " — reported"}`);
    }
    return reports;
  }

  /** Inbox drain + checkpoint when HEAD moved (a commit); prints anything new. */
  async tick(): Promise<string> {
    const out = await this.host.run(this.loaded, { hook_event_name: "PostToolUse", session_id: this.session, cwd: this.root, tool_name: "Bash", tool_input: { command: "" }, tool_use_id: `tick-${Date.now()}` }, { watcher: "tick" });
    const text = textOf(out);
    if (text) this.print(text);
    return text;
  }

  async stop(): Promise<void> {
    await this.host.run(this.loaded, { hook_event_name: "SessionEnd", session_id: this.session, cwd: this.root, reason: "watcher stopped" }, { watcher: "stop" });
  }
}
