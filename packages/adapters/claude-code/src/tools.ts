// Tool-call normalization shared by the harness translators (Cursor, OpenCode, Gemini):
// map a harness's tool name + argument object onto the core's vocabulary
// (Edit / Write / MultiEdit / Bash with file_path, old_string/new_string, content, command).
// Harnesses name the same arguments differently (file_path | filePath | path | target_file,
// old_string | oldString, content | contents | file_text), and some (Cursor) do not document
// their edit tools' schemas at all, so detection is by argument shape.

const SHELL = /^(shell|bash|run_terminal_cmd|terminal|run_terminal_command|run_shell_command)$/i;
const DELETE = /^(delete|delete_file|remove_file)$/i;

export function obj(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** The file a tool call targets, under any of the argument names harnesses use. */
export function argPath(a: Record<string, unknown>): string | undefined {
  return str(a.file_path) ?? str(a.path) ?? str(a.target_file) ?? str(a.filePath) ?? str(a.absolute_path);
}

/**
 * Map a harness tool call onto the core's tool vocabulary. Returns undefined for tools
 * the core has no opinion about (Read, Grep, MCP, Task, …).
 */
export function toCoreTool(name: string, input: Record<string, unknown>): { tool_name: string; tool_input: Record<string, unknown> } | undefined {
  if (SHELL.test(name)) {
    const command = str(input.command) ?? str(input.cmd);
    return command !== undefined ? { tool_name: "Bash", tool_input: { command } } : undefined;
  }
  const file_path = argPath(input);
  if (!file_path) return undefined;
  if (DELETE.test(name)) return { tool_name: "Write", tool_input: { file_path, weft_delete: true } };
  const oldS = str(input.old_string) ?? str(input.oldString) ?? str(input.old_str);
  const newS = str(input.new_string) ?? str(input.newString) ?? str(input.new_str);
  if (oldS !== undefined && newS !== undefined) {
    return { tool_name: "Edit", tool_input: { file_path, old_string: oldS, new_string: newS, replace_all: input.replace_all === true || input.replaceAll === true || (typeof input.expected_replacements === "number" && input.expected_replacements > 1) } };
  }
  if (Array.isArray(input.edits)) {
    const edits = (input.edits as Array<Record<string, unknown>>).map((e) => ({
      old_string: str(e.old_string) ?? str(e.oldString),
      new_string: str(e.new_string) ?? str(e.newString),
      replace_all: e.replace_all === true || e.replaceAll === true,
    }));
    return { tool_name: "MultiEdit", tool_input: { file_path, edits } };
  }
  const content = str(input.content) ?? str(input.contents) ?? str(input.file_text) ?? str(input.text) ?? str(input.code);
  if (content !== undefined) return { tool_name: "Write", tool_input: { file_path, content } };
  // An edit-capable tool whose proposed text we cannot derive (e.g. a model-applied
  // sketch): no pre-edit check, but the post-edit commit still accounts for it.
  if (/write|edit|replace|patch|create/i.test(name)) return { tool_name: "Write", tool_input: { file_path } };
  return undefined;
}

