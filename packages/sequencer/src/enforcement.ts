import type { EnforcementMode } from "@weft/protocol";

/** WEFT_ENFORCEMENT: `block` (trimmed, any case) enables blocking; anything else is advise. */
export function enforcementFrom(value: string | undefined): EnforcementMode {
  const v = (value ?? "").trim().toLowerCase();
  if (v && v !== "advise" && v !== "block") console.warn(`WEFT_ENFORCEMENT=${JSON.stringify(value)} is not advise or block; using advise`);
  return v === "block" ? "block" : "advise";
}
