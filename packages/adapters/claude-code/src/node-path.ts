// The node binary that installed hooks and wrappers should call. process.execPath is the
// resolved binary, which under Homebrew is a versioned Cellar path
// (/opt/homebrew/Cellar/node@24/24.21.0/bin/node) that disappears on the next `brew upgrade`,
// silently breaking every installed hook. Prefer Homebrew's stable `opt/<formula>` link.
import { existsSync } from "node:fs";

export function stableNodePath(execPath: string = process.execPath, exists: (p: string) => boolean = existsSync): string {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/(node[^/]*)$/.exec(execPath);
  if (m) {
    const opt = `${m[1]}/opt/${m[2]}/bin/${m[3]}`;
    if (exists(opt)) return opt;
  }
  return execPath;
}
