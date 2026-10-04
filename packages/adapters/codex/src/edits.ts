// Codex exposes modifications as one `apply_patch` command. Parse its native
// patch grammar before execution so PreToolUse can coordinate directly encoded writes.
export const EDIT_TOOLS = new Set(["apply_patch"]);

type Patch = { path: string; after: string | null | undefined };

/** First target path in a Codex apply_patch command. */
export function editPath(input: Record<string, unknown>): string | undefined {
  const command = input.command;
  if (typeof command !== "string") return undefined;
  const m = command.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m);
  return m?.[1]?.trim();
}

function parseFirst(command: string): Patch | undefined {
  const m = command.match(/^\*\*\* (Add|Update|Delete) File: (.+?)\n([\s\S]*?)(?=^\*\*\* (?:Add|Update|Delete) File:|^\*\*\* End Patch|$)/m);
  if (!m) return undefined;
  const [, kind, raw, body] = m;
  if (kind === "Delete") return { path: raw.trim(), after: null };
  if (kind === "Add") {
    const lines = body.replace(/\n$/, "").split("\n");
    return { path: raw.trim(), after: lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1)).join("\n") + "\n" };
  }
  // Update hunks are deliberately committed after execution from the real filesystem.
  return { path: raw.trim(), after: undefined };
}

/** Proposed after text for direct Add/Delete patches; update hunks use PostToolUse. */
export function proposedText(tool: string, input: Record<string, unknown>, _before: string | null): string | undefined {
  if (!EDIT_TOOLS.has(tool) || typeof input.command !== "string") return undefined;
  const after = parseFirst(input.command)?.after;
  return after === null ? undefined : after;
}

/** `git commit` inside a shell command (tool-interception commit gate, spec §8.5). */
export function isGitCommit(command: string): boolean {
  return /(^|[\s;&|(])git(\s+-[cC]\s+\S+)*\s+commit\b/.test(command);
}
