// Claude Code edit tools -> the file text they would produce (PreToolUse) so the analyzer
// can derive read/write sets for a proposed edit before it happens.

export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

type Replace = { old_string?: unknown; new_string?: unknown; replace_all?: unknown };

function applyReplace(text: string, r: Replace): string | undefined {
  if (typeof r.old_string !== "string" || typeof r.new_string !== "string") return undefined;
  if (r.old_string === "") return text === "" ? r.new_string : undefined; // create-via-Edit
  if (!text.includes(r.old_string)) return undefined;
  return r.replace_all === true ? text.split(r.old_string).join(r.new_string) : text.replace(r.old_string, () => r.new_string as string);
}

/** Target file path of an edit tool call, as given by the model. */
export function editPath(input: Record<string, unknown>): string | undefined {
  const p = input.file_path ?? input.path;
  return typeof p === "string" && p.trim() ? p : undefined;
}

/**
 * Proposed after-text for an edit tool call, or undefined when it cannot be derived
 * exactly (Claude Code then reports its own error; the PostToolUse commit still runs).
 */
export function proposedText(tool: string, input: Record<string, unknown>, before: string | null): string | undefined {
  if (tool === "Write") return typeof input.content === "string" ? input.content : undefined;
  if (tool === "Edit") return applyReplace(before ?? "", input as Replace);
  if (tool === "MultiEdit") {
    if (!Array.isArray(input.edits)) return undefined;
    let text: string | undefined = before ?? "";
    for (const e of input.edits as Replace[]) {
      text = text === undefined ? undefined : applyReplace(text, e);
      if (text === undefined) return undefined;
    }
    return text;
  }
  return undefined;
}

/** `git commit` inside a shell command (tool-interception commit gate, spec §8.5). */
export function isGitCommit(command: string): boolean {
  return /(^|[\s;&|(])git(\s+-[cC]\s+\S+)*\s+commit\b/.test(command);
}
