// Agent Hooks Core v0 — the normalized event and decision envelopes of
// docs/protocol/hooks-core-v0.md (§4 events, §5 decisions, §6 diagnostics), plus the
// capability declaration (§3), which is the same object as WCP's `hello.capabilities`.
import type { Capabilities, CapabilityLevel, Severity } from "@weft/protocol";

export const HOOKS_CORE_VERSION = "0.1" as const;

/** Normalized lifecycle events (spec §4.1). */
export const CORE_EVENTS = ["session.start", "prompt.submit", "tool.pre", "tool.post", "agent.stop", "session.end"] as const;
export type CoreEventName = (typeof CORE_EVENTS)[number];

/** Normalized tool kinds (spec §4.3). A host maps each native tool to one of these. */
export type ToolKind = "edit" | "write" | "delete" | "shell" | "read" | "other";

export type CoreTool = {
  kind: ToolKind;
  /** The host's native tool name (informative; plugins MUST NOT depend on it for core semantics). */
  name?: string;
  /** Host-assigned id pairing a tool.pre with its tool.post. */
  call_id: string;
  /** Workspace-relative or absolute path (edit/write/delete/read). */
  path?: string;
  /** edit: exact text replaced and its replacement. */
  old_text?: string;
  new_text?: string;
  /** write: the complete proposed file content. */
  content?: string;
  /** shell: the command line. */
  command?: string;
  /** tool.post only: the tool's result as the model will see it (untrusted, spec §9). */
  output?: string;
};

export type CoreEvent = {
  hooks: typeof HOOKS_CORE_VERSION;
  event: CoreEventName;
  /** Correlation id of this invocation; echoed as `reply_to` in the decision. */
  id: string;
  /** Stable for the life of one agent session in the host. */
  session: string;
  /** Absolute path of the agent's workspace. */
  cwd: string;
  harness?: { name: string; version?: string };
  tool?: CoreTool;
  /** prompt.submit only. */
  prompt?: string;
  /** agent.stop only: how many consecutive times this stop was already refused. */
  stop?: { repeat: number };
  /** session.end only. */
  reason?: string;
};

export type Decision = "allow" | "advise" | "deny";

/** Core diagnostic (spec §6). WCP's Diagnostic is a profile of this shape (field map in spec §6.2). */
export type CoreDiagnostic = {
  severity: Severity;
  code: string;
  message: string;
  source?: string;
  resource?: { path?: string; symbol?: string; range?: { start: { line: number; character: number }; end: { line: number; character: number } } };
  caused_by?: { ref: string; actor?: string };
  suggestion?: string;
};

export type CoreDecision = {
  hooks: typeof HOOKS_CORE_VERSION;
  decision: Decision;
  /** Model-visible text: the reason for deny, the context for advise. REQUIRED unless allow. */
  explanation?: string;
  diagnostics?: CoreDiagnostic[];
  reply_to?: string;
};

export type { Capabilities, CapabilityLevel };

export const LEVEL_NAMES: Record<CapabilityLevel, string> = { 0: "observe", 1: "inject", 2: "block", 3: "gate" };

/** Validate a core decision object (stdio binding, spec §8). Returns a list of problems. */
export function checkDecision(v: unknown): string[] {
  const out: string[] = [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["decision is not a JSON object"];
  const d = v as Record<string, unknown>;
  if (d.decision !== "allow" && d.decision !== "advise" && d.decision !== "deny") out.push(`decision must be allow|advise|deny, got ${JSON.stringify(d.decision)}`);
  if ((d.decision === "deny" || d.decision === "advise") && (typeof d.explanation !== "string" || !d.explanation.trim())) out.push(`${String(d.decision)} without an explanation`);
  if (d.diagnostics !== undefined && !Array.isArray(d.diagnostics)) out.push("diagnostics must be an array");
  return out;
}

export const allow = (): CoreDecision => ({ hooks: HOOKS_CORE_VERSION, decision: "allow" });
export const advise = (explanation: string): CoreDecision => ({ hooks: HOOKS_CORE_VERSION, decision: "advise", explanation });
export const deny = (explanation: string): CoreDecision => ({ hooks: HOOKS_CORE_VERSION, decision: "deny", explanation });
