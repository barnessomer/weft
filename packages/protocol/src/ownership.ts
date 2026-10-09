// A conflict another agent's change caused does not hold the agent that hit it: that agent may
// stop and finish its other work with the conflict open. The owner of the change is told, as an
// informational diagnostic, and the owner is never blocked by it. Commits stay gated on every open
// error (the commit gate is unchanged), so a conflicting symbol cannot land while it is open.
import type { Diagnostic } from "./types";

/** True when this open error was caused by a change of another agent (not the agent's own). */
export function ownedElsewhere(d: Diagnostic, agent: string): boolean {
  return d.severity === "error" && d.code !== "agent_paused" && d.caused_by_agent !== agent;
}

/** What the owner of the causing change sees: a warning, so it never blocks the owner. */
export function ownerNotice(d: Diagnostic, editor: string): Diagnostic {
  return {
    ...d,
    severity: "warning",
    message:
      `${editor}'s edit to ${d.symbol} conflicts with your change #${d.caused_by_seq}. ` +
      `${editor} keeps working on its other tasks and does not adopt your change; ` +
      `negotiate with ${editor} if the contract needs to change.`,
  };
}
