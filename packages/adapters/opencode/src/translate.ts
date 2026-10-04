// OpenCode plugin events <-> the shared WCP core's Claude-shaped hook input/output.
//
// OpenCode has no command hooks; it loads JS plugins (`.opencode/plugin/*.js`) into its own
// process. `install` writes a small generated plugin (see plugin.ts) that forwards each
// relevant plugin hook to `node dist/weft-opencode.mjs hook` as a JSON message, and applies
// the answer:
//
//   chat system transform -> "system" -> SessionStart   welcome pushed into the system prompt (L1)
//   tool.execute.before   -> "before" -> PreToolUse     throw Error(reason) denies the tool;  (L2)
//                                                       the model sees the error text
//   tool.execute.after    -> "after"  -> PostToolUse    text appended to the tool output       (L1)
//   event session.idle    -> "idle"   -> Stop           client.session.prompt(reason) starts   (L3)
//                                                       another turn (core caps refusals at 5)
//   event session.deleted -> "end"    -> SessionEnd
//
// Tools: edit {filePath, oldString, newString, replaceAll}, write {filePath, content},
// multiedit {filePath, edits[]}, bash {command} map 1:1. apply_patch/patch {patchText}
// (multi-file, GPT-family models) is accounted after the fact only: no pre-edit check.
import type { HookInput, HookOutput } from "../../claude-code/src/hooks";
import { obj, str, toCoreTool } from "../../claude-code/src/tools";

export type OpenCodeMsg = {
  kind: "system" | "before" | "after" | "idle" | "end";
  sessionID: string;
  directory?: string;
  callID?: string;
  tool?: string;
  args?: unknown;
  output?: string;
};

export type OpenCodeAnswer = { deny?: string; append?: string; system?: string; prompt?: string };

const PATCH_TOOLS = /^(apply_patch|patch)$/i;

/** Files named in an apply_patch body (`*** Add|Update|Delete File: p`, `*** Move to: p`). */
export function patchFiles(patchText: string): string[] {
  const out: string[] = [];
  for (const m of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    const p = (m[1] ?? m[2] ?? "").trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** OpenCode message -> core hook inputs (several for a multi-file patch; empty: nothing to do). */
export function toCore(m: OpenCodeMsg): HookInput[] {
  const base = { session_id: m.sessionID, cwd: m.directory };
  switch (m.kind) {
    case "system":
      return [{ ...base, hook_event_name: "SessionStart", source: "startup" }];
    case "before":
    case "after": {
      const event = m.kind === "before" ? "PreToolUse" : "PostToolUse";
      const args = obj(m.args);
      if (PATCH_TOOLS.test(m.tool ?? "")) {
        if (m.kind === "before") return [];
        const text = str(args.patchText) ?? str(args.patch) ?? str(args.input) ?? "";
        return patchFiles(text).map((file_path, i) => ({ ...base, hook_event_name: event, tool_name: "Write", tool_input: { file_path }, tool_use_id: `${m.callID ?? "patch"}#${i}` }));
      }
      const mapped = toCoreTool(m.tool ?? "", args);
      if (!mapped) return m.kind === "after" ? [{ ...base, hook_event_name: event, tool_name: m.tool ?? "unknown", tool_input: {}, tool_use_id: m.callID }] : [];
      return [{ ...base, hook_event_name: event, ...mapped, tool_use_id: m.callID, ...(m.kind === "after" ? { tool_response: m.output } : {}) }];
    }
    case "idle":
      return [{ ...base, hook_event_name: "Stop" }];
    case "end":
      return [{ ...base, hook_event_name: "SessionEnd", reason: "session deleted" }];
  }
}

type CoreOut = { decision?: string; reason?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };

/** Core outputs -> plugin answer. `carry` = context produced where OpenCode has no field (allowed pre-edit). */
export function fromCore(kind: OpenCodeMsg["kind"], outs: HookOutput[], carried = ""): { answer: OpenCodeAnswer; carry?: string } {
  const os = outs.map((o) => (o ?? {}) as CoreOut);
  const ctx = os.map((o) => o.hookSpecificOutput?.additionalContext).filter((x): x is string => !!x);
  const join = (...xs: Array<string | undefined>) => xs.filter(Boolean).join("\n");
  switch (kind) {
    case "system": {
      const text = join(...ctx);
      return { answer: text ? { system: text } : {}, ...(carried ? { carry: carried } : {}) };
    }
    case "before": {
      const deny = os.find((o) => o.hookSpecificOutput?.permissionDecision === "deny");
      if (deny) return { answer: { deny: deny.hookSpecificOutput?.permissionDecisionReason ?? "[weft] blocked" } };
      return { answer: {}, ...(ctx.length ? { carry: join(...ctx) } : {}) };
    }
    case "after": {
      const text = join(carried, ...ctx);
      return { answer: text ? { append: text } : {} };
    }
    case "idle": {
      const block = os.find((o) => o.decision === "block" && o.reason);
      return { answer: block ? { prompt: join(carried, block.reason) } : {}, ...(!block && carried ? { carry: carried } : {}) };
    }
    case "end":
      return { answer: {} };
  }
}
