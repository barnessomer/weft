import { describe, expect, it } from "vitest";
import { EDIT_TOOLS, editPath, proposedText } from "../src/edits";
import { mergeSettings } from "../src/cli";

describe("Codex apply_patch adapter", () => {
  it("recognizes native Codex apply_patch payloads", () => {
    const command = "*** Begin Patch\n*** Add File: src/new.ts\n+export const value = 1;\n*** End Patch";
    expect(EDIT_TOOLS.has("apply_patch")).toBe(true);
    expect(editPath({ command })).toBe("src/new.ts");
    expect(proposedText("apply_patch", { command }, null)).toBe("export const value = 1;\n");
  });

  it("installs the Codex lifecycle hooks and replaces old Weft hooks", () => {
    const merged = mergeSettings({ hooks: { PreToolUse: [{ matcher: "apply_patch", hooks: [{ type: "command", command: "node /old/weft-codex.mjs hook" }] }], Stop: [{ hooks: [{ type: "command", command: "echo foreign" }] }] } }, "node /new/weft-codex.mjs hook") as any;
    expect(merged.hooks.PreToolUse.map((e: any) => e.matcher)).toEqual(["apply_patch", "Bash"]);
    expect(merged.hooks.PreToolUse[0].hooks[0].command).toBe("node /new/weft-codex.mjs hook");
    expect(merged.hooks.PostToolUse.map((e: any) => e.matcher)).toEqual(["apply_patch", "Bash"]);
    // SessionStart pins base_seq; without it R2 cannot see what the conversation already read
    expect(merged.hooks.SessionStart).toHaveLength(1);
    expect(merged.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
    expect(merged.hooks.Stop.map((e: any) => e.hooks[0].command)).toEqual(["echo foreign", "node /new/weft-codex.mjs hook"]);
  });
});

describe("linked worktrees", () => {
  it("gives each worktree its own git hooks dir and finds the main worktree (where Codex reads .codex/hooks.json)", async () => {
    const { checkout } = await import("./helpers");
    const { gitHooksDir, mainWorktree } = await import("../src/cli");
    const { execFileSync } = await import("node:child_process");
    const { realpathSync } = await import("node:fs");
    const origin = checkout("wt");
    const a = `${origin}-a`;
    const b = `${origin}-b`;
    execFileSync("git", ["-C", origin, "worktree", "add", "-q", a, "-b", "a"]);
    execFileSync("git", ["-C", origin, "worktree", "add", "-q", b, "-b", "b"]);
    const ha = gitHooksDir(a);
    const hb = gitHooksDir(b);
    expect(ha).not.toBe(hb);
    expect(gitHooksDir(a)).toBe(ha); // idempotent: worktree-scoped core.hooksPath is now set
    expect(realpathSync(mainWorktree(a)!)).toBe(realpathSync(origin));
    expect(mainWorktree(origin)).toBeUndefined();
  });
});
