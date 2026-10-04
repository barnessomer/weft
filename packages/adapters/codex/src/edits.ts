// Codex exposes modifications as one `apply_patch` command (tool_input.command). Parse its
// native patch grammar before execution so PreToolUse can coordinate the edit:
//
//   *** Begin Patch
//   *** Add File: <path>          +lines…
//   *** Delete File: <path>
//   *** Update File: <path>
//   [*** Move to: <path>]
//   @@ [context header]
//    context / -removed / +added lines…
//   [*** End of File]
//   *** End Patch
//
// Update hunks are applied to the current file text the same way Codex does (sequence
// search: exact, then ignoring trailing whitespace, then ignoring surrounding whitespace),
// so the pre-edit `check` sees the real proposed text. A hunk that does not apply yields
// `after: undefined` for that file — Codex rejects the same patch, and PostToolUse accounts
// for whatever actually landed.
export const EDIT_TOOLS = new Set(["apply_patch"]);

export type Chunk = { header?: string; old: string[]; new: string[]; eof: boolean };

export type PatchOp =
  | { kind: "add"; path: string; text: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: Chunk[] };

const FILE_RE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;

/** Parse a Codex apply_patch command into file operations (lenient on the envelope). */
export function parsePatch(command: string): PatchOp[] {
  const lines = command.replace(/\r\n/g, "\n").split("\n");
  const ops: PatchOp[] = [];
  let cur: PatchOp | undefined;
  let chunk: Chunk | undefined;
  const flushChunk = () => {
    if (cur?.kind === "update" && chunk && (chunk.old.length || chunk.new.length)) cur.chunks.push(chunk);
    chunk = undefined;
  };
  const flush = () => {
    flushChunk();
    if (cur) ops.push(cur);
    cur = undefined;
  };
  for (const line of lines) {
    const m = line.match(FILE_RE);
    if (m) {
      flush();
      const path = m[2].trim();
      cur = m[1] === "Add" ? { kind: "add", path, text: "" } : m[1] === "Delete" ? { kind: "delete", path } : { kind: "update", path, chunks: [] };
      continue;
    }
    if (line.startsWith("*** Begin Patch")) continue;
    if (line.startsWith("*** End Patch")) {
      flush();
      continue;
    }
    if (!cur) continue;
    if (cur.kind === "add") {
      if (line.startsWith("+")) cur.text += line.slice(1) + "\n";
      continue;
    }
    if (cur.kind !== "update") continue;
    if (line.startsWith("*** Move to: ")) {
      cur.moveTo = line.slice("*** Move to: ".length).trim();
      continue;
    }
    if (line.startsWith("*** End of File")) {
      if (chunk) chunk.eof = true;
      continue;
    }
    if (line.startsWith("@@")) {
      flushChunk();
      const header = line.slice(2).trim();
      chunk = { ...(header ? { header } : {}), old: [], new: [], eof: false };
      continue;
    }
    chunk ??= { old: [], new: [], eof: false };
    if (line.startsWith("+")) chunk.new.push(line.slice(1));
    else if (line.startsWith("-")) chunk.old.push(line.slice(1));
    else if (line.startsWith(" ")) {
      chunk.old.push(line.slice(1));
      chunk.new.push(line.slice(1));
    } else if (line === "") {
      // A blank context line whose leading space was dropped by the model.
      chunk.old.push("");
      chunk.new.push("");
    }
  }
  flush();
  return ops;
}

function seek(lines: string[], pattern: string[], start: number, eof: boolean): number {
  if (!pattern.length) return start;
  const norms: Array<(s: string) => string> = [(s) => s, (s) => s.trimEnd(), (s) => s.trim()];
  for (const norm of norms) {
    const want = pattern.map(norm);
    const from = eof ? Math.max(start, lines.length - pattern.length) : start;
    for (let i = from; i + pattern.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < want.length && ok; j++) ok = norm(lines[i + j]) === want[j];
      if (ok) return i;
    }
  }
  return -1;
}

/** Apply update chunks to `before`; undefined when a chunk does not match. */
export function applyChunks(before: string, chunks: Chunk[]): string | undefined {
  const body = before.endsWith("\n") ? before.slice(0, -1) : before;
  const lines = before === "" ? [] : body.split("\n");
  let cursor = 0;
  const replacements: Array<[number, number, string[]]> = [];
  for (const c of chunks) {
    if (c.header) {
      const h = seek(lines, [c.header], cursor, false);
      if (h >= 0) cursor = h + 1;
    }
    let old = c.old;
    let neu = c.new;
    let at = seek(lines, old, cursor, c.eof);
    if (at < 0 && old.length && old[old.length - 1] === "") {
      // Trailing blank context line the file does not have at that point.
      old = old.slice(0, -1);
      neu = neu.length && neu[neu.length - 1] === "" ? neu.slice(0, -1) : neu;
      at = seek(lines, old, cursor, c.eof);
    }
    if (at < 0) return undefined;
    if (!old.length) at = lines.length; // pure addition without context: append
    replacements.push([at, old.length, neu]);
    cursor = at + old.length;
  }
  for (const [at, len, neu] of replacements.sort((a, b) => b[0] - a[0])) lines.splice(at, len, ...neu);
  return lines.length ? lines.join("\n") + "\n" : "";
}

export type ProposedFile = { path: string; before: string | null; after: string | null | undefined };

/**
 * Proposed after-text for every file the patch touches. `read(path)` returns the current
 * text (null when the file does not exist). A Move yields a delete of the old path and an
 * add of the new one. `after: undefined` = could not compute (hunk did not apply).
 */
export function proposedFiles(command: string, read: (path: string) => string | null): ProposedFile[] {
  const out: ProposedFile[] = [];
  for (const op of parsePatch(command)) {
    const before = read(op.path);
    if (op.kind === "add") out.push({ path: op.path, before, after: op.text });
    else if (op.kind === "delete") out.push({ path: op.path, before, after: null });
    else {
      const after = before === null ? undefined : applyChunks(before, op.chunks);
      if (op.moveTo && op.moveTo !== op.path) {
        out.push({ path: op.path, before, after: after === undefined ? undefined : null });
        out.push({ path: op.moveTo, before: read(op.moveTo), after });
      } else out.push({ path: op.path, before, after });
    }
  }
  return out;
}

/** Every path a patch touches (incl. Move targets), in order, deduplicated. */
export function patchPaths(input: Record<string, unknown>): string[] {
  const command = input.command;
  if (typeof command !== "string") return [];
  const paths: string[] = [];
  for (const op of parsePatch(command)) {
    paths.push(op.path);
    if (op.kind === "update" && op.moveTo) paths.push(op.moveTo);
  }
  return [...new Set(paths)];
}

/** First target path in a Codex apply_patch command. */
export function editPath(input: Record<string, unknown>): string | undefined {
  return patchPaths(input)[0];
}

/** Proposed after text of the first file (single-file convenience API). */
export function proposedText(tool: string, input: Record<string, unknown>, before: string | null): string | undefined {
  if (!EDIT_TOOLS.has(tool) || typeof input.command !== "string") return undefined;
  const first = proposedFiles(input.command, () => before)[0];
  return first?.after ?? undefined;
}

/** `git commit` inside a shell command (tool-interception commit gate, spec §8.5). */
export function isGitCommit(command: string): boolean {
  return /(^|[\s;&|(])git(\s+-[cC]\s+\S+)*\s+commit\b/.test(command);
}
