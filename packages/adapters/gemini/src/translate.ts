// Gemini CLI hook payloads <-> the shared WCP core's Claude-shaped hook input/output.
// Wire shapes: https://geminicli.com/docs/hooks/reference (docs/research/hooks.md, "Gemini CLI").
//
// FIXTURE-TESTED ONLY. Gemini CLI's free OAuth tier is gone (UNSUPPORTED_CLIENT; replaced by
// Antigravity CLI for unpaid users) and no Gemini API key is available, so no live run has
// exercised this translator. The mapping follows the documented reference:
//
//   SessionStart  -> SessionStart   hookSpecificOutput.additionalContext            (L1)
//   BeforeAgent   -> UserPromptSubmit hookSpecificOutput.additionalContext          (L1)
//   BeforeTool    -> PreToolUse     decision:"deny" + reason (sent to the agent)    (L2)
//                   write_file {file_path, content} -> Write
//                   replace {file_path, old_string, new_string, expected_replacements} -> Edit
//                   run_shell_command {command} -> Bash (git commit gate)
//   AfterTool     -> PostToolUse    hookSpecificOutput.additionalContext (appended to the result) (L1)
//   AfterAgent    -> Stop           decision:"deny" + reason -> retry turn          (L3)
//   SessionEnd    -> SessionEnd     (best effort: the CLI does not wait)
import type { HookInput, HookOutput } from "../../claude-code/src/hooks";
import { obj, toCoreTool } from "../../claude-code/src/tools";

export type GeminiInput = {
  hook_event_name: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  timestamp?: string;
  source?: string;
  prompt?: string;
  prompt_response?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  reason?: string;
};

/** Gemini tool calls carry no call id; derive a stable one so Before/After pair up. */
export function callIdOf(i: GeminiInput): string {
  const a = obj(i.tool_input);
  return `${i.tool_name ?? "tool"}:${JSON.stringify(a).length}:${String(a.file_path ?? a.command ?? "")}`;
}

export function toCore(i: GeminiInput): HookInput | undefined {
  if (!i.session_id) return undefined;
  const base = { session_id: i.session_id, cwd: i.cwd ?? process.env.GEMINI_PROJECT_DIR ?? process.cwd() };
  switch (i.hook_event_name) {
    case "SessionStart":
      return { ...base, hook_event_name: "SessionStart", source: i.source ?? "startup" };
    case "BeforeAgent":
      return { ...base, hook_event_name: "UserPromptSubmit", prompt: i.prompt };
    case "BeforeTool":
    case "AfterTool": {
      const mapped = toCoreTool(i.tool_name ?? "", obj(i.tool_input));
      const event = i.hook_event_name === "BeforeTool" ? "PreToolUse" : "PostToolUse";
      if (!mapped) return event === "PostToolUse" ? { ...base, hook_event_name: event, tool_name: i.tool_name ?? "unknown", tool_input: {}, tool_use_id: callIdOf(i) } : undefined;
      return { ...base, hook_event_name: event, ...mapped, tool_use_id: callIdOf(i), ...(event === "PostToolUse" ? { tool_response: i.tool_response } : {}) };
    }
    case "AfterAgent":
      return { ...base, hook_event_name: "Stop", stop_hook_active: i.stop_hook_active === true };
    case "SessionEnd":
      return { ...base, hook_event_name: "SessionEnd", ...(i.reason ? { reason: i.reason } : {}) };
    default:
      return undefined;
  }
}

type CoreOut = { decision?: string; reason?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };

/** Core output -> Gemini output. BeforeTool has no documented context field: warnings carry to AfterTool. */
export function fromCore(event: string, out: HookOutput, carried = ""): { json: Record<string, unknown>; carry?: string } {
  const o = (out ?? {}) as CoreOut;
  const hso = o.hookSpecificOutput ?? {};
  const join = (...xs: Array<string | undefined>) => xs.filter(Boolean).join("\n");
  switch (event) {
    case "BeforeTool":
      if (hso.permissionDecision === "deny") return { json: { decision: "deny", reason: hso.permissionDecisionReason ?? "[weft] blocked" } };
      return { json: {}, ...(hso.additionalContext ? { carry: hso.additionalContext } : {}) };
    case "SessionStart":
    case "BeforeAgent":
    case "AfterTool": {
      const text = join(carried, hso.additionalContext);
      return { json: text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {} };
    }
    case "AfterAgent":
      return { json: o.decision === "block" && o.reason ? { decision: "deny", reason: join(carried, o.reason) } : {} };
    default:
      return { json: {} };
  }
}
