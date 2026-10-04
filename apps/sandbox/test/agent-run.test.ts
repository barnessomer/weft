// agent-run.mjs (the in-container orchestrator) against real git: a trunk + candidate fork on
// the git-backed Artifacts fake, fake harness binaries, and the real Claude Code adapter bundle.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentRun, buildPrompt, harnessCommand, parseOutcome, redact, validateSpec } from "../image/agent-run.mjs";
import { commitMessage, fakeHarnessBin, forkHead, trunkAndFork } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(here, "..", "..", "..", "packages", "adapters", "claude-code", "dist", "weft-claude.mjs");
const CHANGE = "I" + "ab".repeat(20);
const FAKE_TOKEN = "art_v1_" + "f".repeat(40);

async function runDir(spec: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "weft-run-"));
  const work = await mkdtemp(join(tmpdir(), "weft-work-"));
  await writeFile(join(dir, "spec.json"), JSON.stringify({ work_root: work, ...spec }));
  return { dir, work };
}

describe("agent-run.mjs units", () => {
  it("validates specs", () => {
    expect(validateSpec({ run: "r", harness: "nope" })).toContain("unknown harness nope");
    expect(validateSpec({ run: "r", harness: "claude-code", prompt: "x" })).toContain("fork required for agent harnesses");
    expect(validateSpec({ run: "r", harness: "script", command: ["true"] })).toEqual([]);
  });

  it("builds the prompt with task, injected AGENTS.md and finishing rules", () => {
    const p = buildPrompt({ task: "T-1", title: "Add punctuation", prompt: "Make greet end with !", agents_md: "Use tabs.", fork: { remote: "x", branch: "main" } });
    expect(p).toContain("# Task T-1: Add punctuation");
    expect(p).toContain("Make greet end with !");
    expect(p).toContain("AGENTS.md injected by Weft");
    expect(p).toContain("Use tabs.");
    expect(p).toContain("git push origin HEAD:main");
  });

  it("routes harness model calls through AI Gateway with a placeholder key", () => {
    const c = harnessCommand({ harness: "claude-code", model: "claude-sonnet-5", ai_gateway: { base_url: "https://gateway.ai.cloudflare.com/v1/acct/weft" } }, "PROMPT");
    expect(c.argv.slice(0, 3)).toEqual(["claude", "--print", "--output-format"]);
    expect(c.argv).toContain("--dangerously-skip-permissions");
    expect(c.argv.at(-1)).toBe("PROMPT");
    expect(c.env.ANTHROPIC_BASE_URL).toBe("https://gateway.ai.cloudflare.com/v1/acct/weft/anthropic");
    expect(c.env.ANTHROPIC_API_KEY).toBe("weft-outbound-injected");
    const x = harnessCommand({ harness: "codex", model: "gpt-5-codex", ai_gateway: { base_url: "https://g/v1/a/weft" } }, "P");
    expect(x.argv.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(x.argv.join(" ")).toContain('base_url="https://g/v1/a/weft/openai"');
    expect(x.env.OPENAI_API_KEY).toBe("weft-outbound-injected");
  });

  it("parses Claude and Codex outcomes", () => {
    expect(parseOutcome("claude-code", '{"type":"system"}\n{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.5}\n')).toMatchObject({ is_error: false, result: "ok", total_cost_usd: 0.5 });
    expect(parseOutcome("codex", '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\n{"type":"turn.completed","usage":{"input_tokens":1}}\n')).toMatchObject({ is_error: false, usage: { input_tokens: 1 } });
    expect(parseOutcome("codex", '{"type":"turn.failed","error":{"message":"boom"}}\n')).toMatchObject({ is_error: true, error: "boom" });
  });

  it("redacts credentials", () => {
    expect(redact(`x ${FAKE_TOKEN}?expires=123 y`)).toBe("x art_v1_*** y");
    expect(redact("Authorization: Bearer abc.def")).toBe("Authorization: Bearer ***");
    expect(redact("key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA")).toBe("key sk-***");
    expect(redact("my-secret-value here", ["my-secret-value"])).toBe("*** here");
  });
});

describe("agent-run.mjs end to end (real git)", () => {
  it("script harness: clone fork, commit with trailers, push, result.json", async () => {
    const { base, fork, forkPath } = await trunkAndFork();
    const { dir, work } = await runDir({
      run: "run-a",
      repo: "weft-demo",
      task: "T-1",
      change: CHANGE,
      agent: "script-a",
      harness: "script",
      command: ["sh", "-c", 'printf "\\nexport const x = 1;\\n" >> greet.ts && git commit -qam "feat: x" && echo did-it'],
      fork: { remote: fork.remote, branch: "main" },
      trailers: { "Change-Id": CHANGE, "Task-Id": "T-1", "Agent-Id": "script-a" },
    });
    const r = await agentRun(dir, { env: { ...process.env, WEFT_GIT_TOKEN: FAKE_TOKEN } });
    expect(r).toMatchObject({ state: "succeeded", harness_exit: 0, base, dirty: false });
    expect(r.head).not.toBe(base);
    expect(r.pushed).toBe(r.head);
    expect(await forkHead(forkPath)).toBe(r.head);
    const msg = await commitMessage(forkPath, r.head);
    expect(msg).toContain(`Change-Id: ${CHANGE}`);
    expect(msg).toContain("Task-Id: T-1");
    expect(msg).toContain("Agent-Id: script-a");
    expect(await readFile(join(dir, "agent.stdout.log"), "utf8")).toContain("did-it");
    const timeline = (await readFile(join(dir, "runner.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).step);
    expect(timeline).toEqual(["start", "cloned", "context_injected", "harness_start", "harness_exit", "pushed", "finished"]);
    const result = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
    expect(result.timings).toMatchObject({ clone_ms: expect.any(Number), agent_ms: expect.any(Number), push_ms: expect.any(Number), total_ms: expect.any(Number) });
    // the token was only in the environment: never in logs, result or the checkout's git config
    for (const f of ["runner.log", "agent.stdout.log", "agent.stderr.log", "result.json"]) expect(await readFile(join(dir, f), "utf8")).not.toContain(FAKE_TOKEN);
    expect(await readFile(join(work, "repo", ".git", "config"), "utf8")).not.toContain(FAKE_TOKEN);
  });

  it("claude-code harness: installs the WCP adapter (Change-Id from the candidate), injects AGENTS.md, pushes", async () => {
    expect(existsSync(ADAPTER), "build the claude-code adapter first").toBe(true);
    const { base, fork, forkPath } = await trunkAndFork({ "greet.ts": "export function greet(n: string) {\n  return n;\n}\n", "AGENTS.md": "# repo rules\nNo semicolons.\n" });
    const bin = await fakeHarnessBin();
    const { dir, work } = await runDir({
      run: "run-c",
      repo: "weft-demo",
      task: "T-2",
      change: CHANGE,
      agent: "claude-a",
      title: "Punctuation",
      harness: "claude-code",
      model: "claude-sonnet-5",
      prompt: "Add punctuation.",
      agents_md: "Always run the tests.",
      fork: { remote: fork.remote },
      weft: { url: "http://127.0.0.1:9", repo: "weft-demo", mode: "advise" },
      ai_gateway: { base_url: "https://gateway.ai.cloudflare.com/v1/acct/weft" },
      adapter_bundle: ADAPTER,
    });
    const r = await agentRun(dir, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WEFT_TOKEN: "wcp_fake_agent_token_123" } });
    expect(r).toMatchObject({ state: "succeeded", harness: "claude-code", harness_exit: 0, base, outcome: { is_error: false, result: "done", num_turns: 3 } });
    expect(await forkHead(forkPath)).toBe(r.head);
    const repo = join(work, "repo");
    const cfg = JSON.parse(await readFile(join(repo, ".weft", "claude.json"), "utf8"));
    expect(cfg).toMatchObject({ repo: "weft-demo", agent: "claude-a", change: CHANGE, mode: "advise", task: { id: "T-2" } });
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(true);
    expect(await readFile(join(repo, "CLAUDE.local.md"), "utf8")).toBe("@AGENTS.md\n@.weft/AGENTS.md\n");
    expect(await commitMessage(forkPath, r.head)).toContain(`Change-Id: ${CHANGE}`); // adapter's commit-msg hook
    const stdout = await readFile(join(dir, "agent.stdout.log"), "utf8");
    expect(stdout).toContain('"base":"https://gateway.ai.cloudflare.com/v1/acct/weft/anthropic"');
    expect(stdout).toContain('"key":"weft-outbound-injected"');
    expect(stdout).toContain('"sandbox":"1"');
    expect(stdout).toContain("task_seen");
    // injected files never get committed
    const files = (await import("@weft/artifacts/git")).git;
    const tree = (await files(["ls-tree", "-r", "--name-only", r.head], { cwd: forkPath })).stdout;
    expect(tree).not.toMatch(/\.weft|CLAUDE\.local\.md|settings\.local\.json/);
  });

  it("fails cleanly when the fork cannot be cloned", async () => {
    const { dir } = await runDir({ run: "run-x", repo: "r", task: "t", change: CHANGE, agent: "a", harness: "script", command: ["true"], fork: { remote: "file:///nonexistent/repo.git" } });
    const r = await agentRun(dir, { env: process.env });
    expect(r).toMatchObject({ state: "failed", reason: "clone_failed" });
  });

  it("reports a failed harness and a timeout", async () => {
    const { fork } = await trunkAndFork();
    const a = await runDir({ run: "run-f", repo: "r", task: "t", change: CHANGE, agent: "a", harness: "script", command: ["sh", "-c", "exit 4"], fork: { remote: fork.remote } });
    expect(await agentRun(a.dir, { env: process.env })).toMatchObject({ state: "failed", reason: "harness_exit", harness_exit: 4, pushed: null });
    const b = await runDir({ run: "run-t", repo: "r", task: "t", change: CHANGE, agent: "a", harness: "script", command: ["sleep", "30"], timeout_s: 1 });
    const t0 = Date.now();
    expect(await agentRun(b.dir, { env: process.env })).toMatchObject({ state: "failed", reason: "timeout" });
    expect(Date.now() - t0).toBeLessThan(15_000);
  });
});
