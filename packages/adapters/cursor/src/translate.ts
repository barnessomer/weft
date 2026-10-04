// Cursor hook payloads <-> the shared WCP core's Claude-shaped hook input/output.
// Wire shapes: https://cursor.com/docs/hooks (docs/research/hooks.md, "Cursor").
//
//   sessionStart        -> SessionStart       additional_context              (L1)
//   preToolUse  edit    -> PreToolUse check   permission:"deny" + agent_message (L2)
//   preToolUse  Shell   -> PreToolUse Bash    git commit -> deny while errors open (commit_gate)
//   postToolUse         -> PostToolUse        additional_context              (L1)
//   afterFileEdit       -> PostToolUse        only for edits no postToolUse accounted for
//   stop                -> Stop               followup_message (bounded by loop_limit) (L3)
//   sessionEnd          -> SessionEnd
//
// Cursor's built-in edit tool names and argument schemas are not documented (the generic
// payload is `tool_name` + `tool_input`), so edit detection is by argument shape:
// old_string/new_string -> Edit, edits[] -> MultiEdit, content|contents|file_text -> Write.
import type { HookInput, HookOutput } from "../../claude-code/src/hooks";
import { obj, str, toCoreTool } from "../../claude-code/src/tools";

export { argPath, toCoreTool } from "../../claude-code/src/tools";

export type CursorInput = {
  hook_event_name: string;
  conversation_id?: string;
  session_id?: string;
  generation_id?: string;
  workspace_roots?: string[];
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown> | string;
  tool_use_id?: string;
  tool_output?: string;
  status?: string;
  loop_count?: number;
  file_path?: string;
  edits?: Array<{ old_string?: string; new_string?: string }>;
  reason?: string;
  prompt?: string;
  model?: string;
  cursor_version?: string;
};

export type CursorOutput = Record<string, unknown>;

export function sessionOf(i: CursorInput): string | undefined {
  return i.conversation_id ?? i.session_id;
}

export function cwdOf(i: CursorInput, env: NodeJS.ProcessEnv = process.env): string {
  const ti = obj(i.tool_input);
  return i.cwd ?? str(ti.working_directory) ?? i.workspace_roots?.[0] ?? env.CURSOR_PROJECT_DIR ?? env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

/** Cursor event -> core hook input (undefined: nothing for the core to do). */
export function toCore(i: CursorInput): HookInput | undefined {
  const session_id = sessionOf(i);
  if (!session_id) return undefined;
  const cwd = cwdOf(i);
  const base = { session_id, cwd };
  switch (i.hook_event_name) {
    case "sessionStart":
      return { ...base, hook_event_name: "SessionStart", source: "startup" };
    case "preToolUse":
    case "postToolUse": {
      const mapped = toCoreTool(i.tool_name ?? "", obj(i.tool_input));
      if (!mapped) return i.hook_event_name === "postToolUse" ? { ...base, hook_event_name: "PostToolUse", tool_name: i.tool_name ?? "unknown", tool_input: {}, tool_use_id: i.tool_use_id } : undefined;
      return {
        ...base,
        hook_event_name: i.hook_event_name === "preToolUse" ? "PreToolUse" : "PostToolUse",
        ...mapped,
        tool_use_id: i.tool_use_id,
        ...(i.hook_event_name === "postToolUse" ? { tool_response: i.tool_output } : {}),
      };
    }
    case "stop":
      // Only a completed loop is gated; an aborted/errored one is the user's or the backend's call.
      if (i.status && i.status !== "completed") return undefined;
      return { ...base, hook_event_name: "Stop", stop_hook_active: (i.loop_count ?? 0) > 0 };
    case "sessionEnd":
      return { ...base, hook_event_name: "SessionEnd", ...(i.reason ? { reason: i.reason } : {}) };
    default:
      return undefined;
  }
}

/** Reverse-apply afterFileEdit's edit records to the current text: the exact pre-edit text, if derivable. */
export function beforeFromEdits(after: string, edits: Array<{ old_string?: string; new_string?: string }>): string | undefined {
  let text = after;
  for (const e of [...edits].reverse()) {
    if (typeof e.old_string !== "string" || typeof e.new_string !== "string") return undefined;
    if (e.new_string === "") return undefined; // a pure deletion cannot be located in the after-text
    const at = text.lastIndexOf(e.new_string);
    if (at < 0) return undefined;
    text = text.slice(0, at) + e.old_string + text.slice(at + e.new_string.length);
  }
  return text;
}

type CoreOut = { decision?: string; reason?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };

/**
 * Core output -> Cursor output. Permission hooks must always answer valid JSON with a
 * permission (invalid output blocks the action in Cursor), so preToolUse always gets one.
 * `carry` is context the core produced where Cursor has no field for it (an allowed
 * preToolUse); the caller delivers it at the next postToolUse.
 */
export function fromCore(event: string, out: HookOutput, carried = ""): { json: CursorOutput; carry?: string } {
  const o = (out ?? {}) as CoreOut;
  const hso = o.hookSpecificOutput ?? {};
  const join = (...xs: Array<string | undefined>) => xs.filter(Boolean).join("\n");
  switch (event) {
    case "preToolUse":
      if (hso.permissionDecision === "deny") {
        const reason = hso.permissionDecisionReason ?? "[weft] blocked";
        return { json: { permission: "deny", agent_message: reason, user_message: reason.split("\n")[0] } };
      }
      return { json: { permission: "allow" }, ...(hso.additionalContext ? { carry: hso.additionalContext } : {}) };
    case "postToolUse":
    case "sessionStart": {
      const text = join(carried, hso.additionalContext);
      return { json: text ? { additional_context: text } : {} };
    }
    case "stop":
      return { json: o.decision === "block" && o.reason ? { followup_message: join(carried, o.reason) } : {} };
    default:
      return { json: {} };
  }
}
