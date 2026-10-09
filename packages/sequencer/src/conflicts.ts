import type { ConflictMode } from "@weft/protocol";

/** WEFT_CONFLICTS: `continue` (trimmed, any case) lets agents keep working through another agent's conflict; anything else is `hold`, today's behaviour. */
export function conflictsFrom(value: string | undefined): ConflictMode {
  const v = (value ?? "").trim().toLowerCase();
  if (v && v !== "hold" && v !== "continue") console.warn(`WEFT_CONFLICTS=${JSON.stringify(value)} is not hold or continue; using hold`);
  return v === "continue" ? "continue" : "hold";
}
