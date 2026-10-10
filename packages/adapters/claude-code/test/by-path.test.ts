// `hook --by-path` routing (issue #8c): a weft-worker subagent runs in the parent session's cwd
// but edits inside its own joined worktree. Only a checkout pinned to the parent's coordinator is
// trusted, and a Bash command must name its worktree in an accepted form. Real bundle throughout.
import { describe, expect, it, afterAll } from "vitest";
import { ReferenceCoordinator } from "@weft/protocol";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bashTargetDir, configStarts } from "../src/config";
import type { HookInput } from "../src/hooks";
import { checkout, serve } from "./helpers";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-claude.mjs");
const run = promisify(execFile);
const servers: Array<{ close: () => void }> = [];
afterAll(() => servers.forEach((s) => s.close()));

async function coordinator(): Promise<{ coord: ReferenceCoordinator; url: string }> {
  const coord = new ReferenceCoordinator({ repo: "demo" });
  const { url, server } = await serve(coord);
  servers.push(server);
  return { coord, url };
}

/** A checkout joined to the coordinator at `url` as `agent` (installed through the bundle). */
async function joined(url: string, name: string, agent: string): Promise<string> {
  const root = checkout(name);
  await run(process.execPath, [BUNDLE, "install", "--url", url, "--repo", "demo", "--agent", agent, "--task", `T-${name}`], {
    cwd: root,
    env: { ...process.env, WEFT_TOKEN: "local-test-token" },
  });
  return root;
}

/** `weft-claude hook <args>` on one hook input from `cwd`; the parsed stdout (undefined when empty). */
async function hook(args: string[], cwd: string, input: Record<string, unknown>): Promise<Record<string, any> | undefined> {
  const child = run(process.execPath, [BUNDLE, "hook", ...args], { cwd, encoding: "utf8" });
  child.child.stdin!.end(JSON.stringify({ cwd, session_id: "parent-s", ...input }));
  const { stdout } = await child;
  return stdout.trim() ? JSON.parse(stdout) : undefined;
}

function logOf(root: string): string {
  try {
    return readFileSync(join(root, ".weft", "log", "adapter.log"), "utf8");
  } catch {
    return "";
  }
}

const pinned = (url: string) => ["--by-path", "--url", url, "--repo", "demo"];

describe("bashTargetDir and configStarts (issue #8c)", () => {
  it("bashTargetDir accepts only a leading `cd <abs|~> &&` or `git -C <abs|~>`", () => {
    const home = homedir();
    expect(bashTargetDir("cd /wt/a && npm test", "/repo")).toBe("/wt/a");
    expect(bashTargetDir(`cd "/wt/a b" && sed -i s/x/y/ f`, "/repo")).toBe("/wt/a b");
    expect(bashTargetDir(`cd '/wt/q' && ls`, "/repo")).toBe("/wt/q");
    expect(bashTargetDir("cd ~/wt && ls", "/repo")).toBe(join(home, "wt"));
    expect(bashTargetDir("cd ~ && ls", "/repo")).toBe(home);
    expect(bashTargetDir("git -C /wt/c commit -m x", "/repo")).toBe("/wt/c");
    expect(bashTargetDir("git -C ~/wt status", "/repo")).toBe(join(home, "wt"));
  });

  it("bashTargetDir refuses every other form (relative, $VAR, not leading, no &&): fail closed", () => {
    for (const cmd of [
      "ls -la",
      "echo cd /not/this",
      "echo hi; cd /wt && ls", // cd not leading
      "cd /wt", // no &&
      "cd ../wt && ls", // relative
      "cd src && ls",
      `cd "$WEFT_TEST_WT" && ls`, // variable
      "cd $HOME/wt && ls",
      "cd ${HOME}/wt && ls",
      "git -C ../wt status",
      "git -C $HOME status",
      "git status", // no -C
    ]) expect(bashTargetDir(cmd, "/repo"), cmd).toBeUndefined();
  });

  it("configStarts: --by-path looks in the edited file's own joined checkout (Bash: the cd target's), else cwd", () => {
    const joinedDir = checkout("cs-joined");
    mkdirSync(join(joinedDir, ".weft"));
    writeFileSync(join(joinedDir, ".weft/claude.json"), "{}");
    const parent = checkout("cs-parent");
    const edit = (file: string) => ({ hook_event_name: "PreToolUse", session_id: "s", cwd: parent, tool_name: "Edit", tool_input: { file_path: file } }) as HookInput;
    const bash = (command: string) => ({ hook_event_name: "PreToolUse", session_id: "s", cwd: parent, tool_name: "Bash", tool_input: { command } }) as HookInput;
    expect(configStarts(edit(join(joinedDir, "src/cart.ts")), false)).toEqual([parent]);
    expect(configStarts(edit(join(joinedDir, "src/cart.ts")), true)).toEqual([joinedDir, parent]);
    expect(configStarts(edit("/tmp/outside-any-checkout.ts"), true)).toEqual([parent]);
    expect(configStarts(bash(`cd ${joinedDir} && echo x > src/n.ts`), true)).toEqual([joinedDir, parent]);
    expect(configStarts(bash("echo x > src/n.ts"), true)).toEqual([parent]);
  });
});

describe("install-agent and the coordinator pin (issue #8c, real bundle)", () => {
  it("install-agent pins the parent session's coordinator; with no config to pin it needs --url and --repo", async () => {
    const parent = checkout("ia-parent");
    expect(() => execFileSync(process.execPath, [BUNDLE, "install-agent"], { cwd: parent, stdio: "pipe" })).toThrow();
    execFileSync(process.execPath, [BUNDLE, "install-agent", "--url", "https://weft.example.test", "--repo", "demo"], { cwd: parent });
    expect(readFileSync(join(parent, ".claude/agents/weft-worker.md"), "utf8")).toContain("hook --by-path --url https://weft.example.test --repo demo");
    // a joined parent: its own config wins over flags
    const joinedRoot = await joined("https://weft.example.test", "ia-joined", "parent-a");
    execFileSync(process.execPath, [BUNDLE, "install-agent", "--url", "https://other.example.test", "--repo", "demo"], { cwd: joinedRoot });
    const md = readFileSync(join(joinedRoot, ".claude/agents/weft-worker.md"), "utf8");
    expect(md).toContain("--url https://weft.example.test --repo demo");
    expect(md).not.toContain("other.example.test");
  });

  it("the worker definition runs the pinned hook on Edit/Write/MultiEdit/Bash and on Bash failures", () => {
    const parent = checkout("ia-md");
    execFileSync(process.execPath, [BUNDLE, "install-agent", "--url", "https://weft.example.test", "--repo", "demo"], { cwd: parent });
    const md = readFileSync(join(parent, ".claude/agents/weft-worker.md"), "utf8");
    expect(md).toMatch(/^---\nname: weft-worker\n/);
    expect(md).toContain('matcher: "Edit|Write|MultiEdit|Bash"');
    expect(md).toContain("PostToolUseFailure:");
  });
});

describe("--by-path coordinates only the pinned checkout (issue #8c, real bundle)", () => {
  it("a checkout whose config has another url is refused and logged; the pinned one is coordinated; an unpinned hook trusts nothing", async () => {
    const { url } = await coordinator();
    const good = await joined(url, "pin-good", "worker-pin");
    const evil = await joined("https://attacker.example.test", "pin-evil", "worker-evil");
    const parent = checkout("pin-parent");
    const write = (wt: string, name: string) => ({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_use_id: `w-${name}`,
      tool_input: { file_path: join(wt, `src/${name}.ts`), content: `export function ${name}(n: number) { return n; }\n` },
    });

    expect(await hook(pinned(url), parent, write(evil, "fe"))).toBeUndefined();
    expect(logOf(evil)).toContain("hook --by-path refused");
    expect(logOf(evil)).not.toContain("hello worker-evil");

    await hook(pinned(url), parent, write(good, "fg"));
    expect(logOf(good)).toContain("hello worker-pin");
    expect(logOf(good)).toContain("check src/fg.ts");

    await hook(["--by-path"], parent, write(good, "fh"));
    expect(logOf(good)).toContain("hook --by-path refused");
    expect(logOf(good)).not.toContain("src/fh.ts");
  }, 30_000);

  it("--by-path Bash: an accepted target is attributed; any other form is denied before it runs; plain hook never denies (real bundle)", async () => {
    const { url } = await coordinator();
    const wt = await joined(url, "bf-wt", "worker-bf");
    const parent = checkout("bf-parent");
    const pre = (command: string) => hook(pinned(url), parent, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "bf", tool_input: { command } });

    for (const command of [`cd ${wt} && ls`, `cd "${wt}" && npm test`, `cd '${wt}' && ls`, `git -C ${wt} status`]) {
      expect((await pre(command))?.hookSpecificOutput?.permissionDecision, command).toBeUndefined();
    }
    for (const command of ["ls -la", "cd src && ls", "cd $HOME/x && ls", `echo hi; cd ${wt} && ls`, `cd ${wt}`, "git -C src status"]) {
      const out = await pre(command);
      expect(out?.hookSpecificOutput?.permissionDecision, command).toBe("deny");
      expect(out?.hookSpecificOutput?.permissionDecisionReason, command).toContain("cd <worktree> &&");
    }
    expect(await hook([], parent, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls -la" } })).toBeUndefined();
  }, 60_000);

  it("a subagent's first call is a shell edit (no SessionStart of its own): the file is coordinated as the worktree's agent (real bundle)", async () => {
    const { coord, url } = await coordinator();
    const wt = await joined(url, "bf-first", "worker-first");
    const parent = checkout("first-parent");
    const command = `cd ${wt} && printf 'export function newFn(n: number) { return n; }\\n' > src/new.ts`;
    const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "f1", tool_input: { command } };
    await hook(pinned(url), parent, input);
    await run("sh", ["-c", command]); // what Claude's Bash tool does
    await hook(pinned(url), parent, { ...input, hook_event_name: "PostToolUse", tool_response: {} });
    const edits = (coord.events(0, 1000).events as Array<{ kind: string; agent?: string; files: string[] }>).filter((e) => e.kind === "edit" && e.agent === "worker-first");
    expect(edits.map((e) => e.files)).toEqual([["src/new.ts"]]);
  }, 30_000);
});

describe("default (non-by-path) path is unchanged (issue #8c)", () => {
  it("a Bash shell edit with no session is not coordinated: no output, no hello/check/commit", async () => {
    const { url } = await coordinator();
    const root = await joined(url, "main-path-bash", "solo");
    await hook([], root, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "sed -i s/a/b/ f.ts" } });
    writeFileSync(join(root, "f.ts"), "export const q = 1;\n");
    const out = await hook([], root, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "sed -i s/a/b/ f.ts" } });
    expect(out).toBeUndefined();
    expect(logOf(root)).not.toMatch(/ hello | commit | check /);
  });
});
