import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDecision, type CoreEvent } from "../src/core";
import { applyPatch, claudeCode, cursor, gemini, opencode, type RawResult } from "../src/dialects";
import { loadFixtures, renderMarkdown, run } from "../src/runner";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const CLAUDE = join(repo, "packages/adapters/claude-code/dist/weft-claude.mjs");

const raw = (stdout: unknown, code = 0, stderr = ""): RawResult => ({ stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr, code, timedOut: false, ms: 1 });
const ev = (event: CoreEvent["event"], extra: Partial<CoreEvent> = {}): CoreEvent => ({ hooks: "0.1", event, id: "e1", session: "s1", cwd: "/w", ...extra });

describe("core envelopes", () => {
  it("requires an explanation for deny and advise", () => {
    expect(checkDecision({ hooks: "0.1", decision: "allow" })).toEqual([]);
    expect(checkDecision({ hooks: "0.1", decision: "deny" })).toEqual(["deny without an explanation"]);
    expect(checkDecision({ decision: "maybe" })[0]).toMatch(/allow\|advise\|deny/);
  });

  it("ships the documented fixture set (L0–L3, optional commit gate, failure policy)", () => {
    const { fixtures, workspace } = loadFixtures();
    expect(Object.keys(workspace.files)).toEqual(["src/pricing.ts", "src/cart.ts"]);
    const req = fixtures.filter((f) => f.required).map((f) => f.level);
    expect(new Set(req)).toEqual(new Set([0, 1, 2, 3]));
    expect(fixtures.map((f) => f.id)).toContain("F.coordinator-unreachable");
  });
});

describe("dialect codecs", () => {
  const pre = ev("tool.pre", { tool: { kind: "edit", call_id: "c1", path: "src/a.ts", old_text: "a", new_text: "b" } });

  it("Claude Code: PreToolUse deny needs its reason; exit 2 blocks with stderr; additionalContext advises", () => {
    expect(claudeCode.encode(pre)).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/w/src/a.ts", old_string: "a", new_string: "b" }, tool_use_id: "c1" });
    expect(claudeCode.decode(pre, raw({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "stale" } })).decision).toMatchObject({ decision: "deny", explanation: "stale" });
    expect(claudeCode.decode(pre, raw({ hookSpecificOutput: { permissionDecision: "deny" } })).problems).toEqual(["permissionDecision deny without permissionDecisionReason"]);
    expect(claudeCode.decode(pre, raw("", 2, "nope")).decision).toMatchObject({ decision: "deny", explanation: "nope" });
    expect(claudeCode.decode(ev("tool.post", { tool: pre.tool }), raw({ decision: "block", reason: "fyi" })).decision.decision).toBe("advise");
    expect(claudeCode.decode(ev("agent.stop"), raw({ decision: "block", reason: "open errors" })).decision).toMatchObject({ decision: "deny" });
    expect(claudeCode.decode(pre, raw("")).decision.decision).toBe("allow");
  });

  it("Codex: edits travel as apply_patch", () => {
    expect(applyPatch({ kind: "edit", call_id: "c", path: "src/a.ts", old_text: "x\n", new_text: "y\n" })).toBe("*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch");
    expect(applyPatch({ kind: "write", call_id: "c", path: "n.ts", content: "a\nb\n" })).toBe("*** Begin Patch\n*** Add File: n.ts\n+a\n+b\n*** End Patch");
  });

  it("Cursor: invalid preToolUse output blocks; stop followup refuses", () => {
    expect(cursor.encode(pre)).toMatchObject({ hook_event_name: "preToolUse", conversation_id: "s1", workspace_roots: ["/w"] });
    expect(cursor.decode(pre, raw("garbage")).decision.decision).toBe("deny");
    expect(cursor.decode(pre, raw({ permission: "deny", agent_message: "why" })).decision).toMatchObject({ decision: "deny", explanation: "why" });
    expect(cursor.decode(ev("agent.stop"), raw({ followup_message: "keep going" })).decision.decision).toBe("deny");
  });

  it("Gemini and OpenCode map deny / context / stop", () => {
    expect(gemini.encode(pre)).toMatchObject({ hook_event_name: "BeforeTool", tool_name: "replace" });
    expect(gemini.decode(pre, raw({ decision: "deny", reason: "r" })).decision.decision).toBe("deny");
    expect(gemini.decode(ev("tool.post", { tool: pre.tool }), raw({ hookSpecificOutput: { additionalContext: "c" } })).decision).toMatchObject({ decision: "advise", explanation: "c" });
    expect(opencode.encode(ev("prompt.submit"))).toBeUndefined();
    expect(opencode.decode(ev("agent.stop"), raw({ prompt: "fix it" })).decision.decision).toBe("deny");
    expect(opencode.decode(pre, raw({ deny: "no" })).decision).toMatchObject({ decision: "deny", explanation: "no" });
  });
});

describe("end to end", () => {
  it("verifies the Claude Code adapter at L3 and reports its declaration as honest", async () => {
    if (!existsSync(CLAUDE)) execFileSync(process.execPath, [join(repo, "packages/adapters/claude-code/scripts/build.mjs")]);
    const r = await run({
      dialect: "claude-code",
      command: [process.execPath, CLAUDE, "hook"],
      setup: `"${process.execPath}" "${CLAUDE}" install --url {url} --repo {repo} --agent {agent} --task {task} --title conformance`,
      env: { WEFT_TOKEN: "conformance-token" },
    });
    expect(r.fixtures.filter((f) => !f.pass).map((f) => [f.id, f.checks.filter((c) => !c.pass)])).toEqual([]);
    expect(r.verified_level).toBe(3);
    expect(r.declared.capabilities?.level).toBe(3);
    expect(r.honest).toBe(true);
    expect(r.failure_policy).toBe("fail-open");
    expect(renderMarkdown(r)).toContain("**Verified** | **L3**");
  }, 180_000);

  it("a hook that only says allow verifies nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conf-allow-"));
    const hook = join(dir, "allow.sh");
    writeFileSync(hook, `#!/bin/sh\ncat >/dev/null\necho '{"hooks":"0.1","decision":"allow"}'\n`);
    chmodSync(hook, 0o755);
    const r = await run({ dialect: "core", command: [hook], only: ["L0.session-start", "L0.observe-edit", "L2.deny-stale-edit"] });
    expect(r.verified_level).toBe(-1);
    expect(r.honest).toBeNull();
    expect(r.fixtures.find((f) => f.id === "L2.deny-stale-edit")?.pass).toBe(false);
  }, 60_000);
});
