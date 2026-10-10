// Under `conflicts: continue` the owner of a change that caused a conflict is told, as an
// informational diagnostic, and is never blocked by it. The agent that hit the conflict is gated
// exactly as in `hold`: its stop and its commits are refused while the error is open. Only the
// wording and the owner's notice differ.
import type { Diagnostic } from "./types";

/**
 * `hold` (default, today's behaviour): the owner is not told. `continue` (per-repo opt-in:
 * `conflicts: "continue"` in the repo's config): the owner is told and the suggestions say to keep
 * working on other tasks instead of adapting to the other agent's change. Gates are the same in both.
 */
export type ConflictMode = "hold" | "continue";

/** True when this open error was caused by a change of another agent (not the agent's own). */
export function ownedElsewhere(d: Diagnostic, agent: string): boolean {
  return d.severity === "error" && d.code !== "agent_paused" && d.caused_by_agent !== undefined && d.caused_by_agent !== agent;
}

/** What the owner of the causing change sees: a warning, so it never blocks the owner. */
export function ownerNotice(d: Diagnostic, editor: string): Diagnostic {
  // Built field by field: the editor's diagnostic (and its suggestion, which is written for the editor)
  // is not copied to the owner.
  return {
    severity: "warning",
    code: d.code,
    file: d.file,
    symbol: d.symbol,
    message: `${editor}'s edit to ${d.symbol} conflicts with your change #${d.caused_by_seq}.`,
    suggestion: `${editor} keeps working on its other tasks and does not adopt your change. Negotiate with ${editor} if the contract needs to change; otherwise no action is needed.`,
    caused_by_seq: d.caused_by_seq,
    caused_by_agent: editor,
  };
}
