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

  it("installs only verified Codex hook events and replaces old Weft hooks", () => {
    const merged = mergeSettings({ hooks: { PreToolUse: [{ matcher: "apply_patch", hooks: [{ type: "command", command: "node /old/weft-codex.mjs hook" }] }], Stop: [{ hooks: [{ type: "command", command: "echo foreign" }] }] } }, "node /new/weft-codex.mjs hook") as any;
    expect(merged.hooks.PreToolUse).toHaveLength(1);
    expect(merged.hooks.PreToolUse[0].hooks[0].command).toBe("node /new/weft-codex.mjs hook");
    expect(merged.hooks.PostToolUse[0].matcher).toBe("apply_patch");
    expect(merged.hooks.Stop[0].hooks[0].command).toBe("echo foreign");
  });
});
