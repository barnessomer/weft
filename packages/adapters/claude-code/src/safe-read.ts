// Reading checkout files safely. The adapter reads a file's text to analyze an edit and
// may put it into a diff on the shared log, so a read must never escape the checkout:
//   - no symlink anywhere on the path (the final file is opened with O_NOFOLLOW, and the
//     real path of the file must be exactly <real checkout root>/<rel>, which fails if any
//     directory on the way is a symlink);
//   - only regular files, at most `maxBytes`.
// Anything else reads as "no text" (null): the edit is then not coordinated, which is the
// adapter's normal fail-open behaviour for files it cannot see.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute, resolve, sep } from "node:path";

const realRoots = new Map<string, string>();

/** True when a path relative to the checkout root leaves it (`..` or `../x`), not when a name starts with `..`. */
export function outsideRoot(rel: string): boolean {
  return !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function realRoot(root: string): string | undefined {
  const hit = realRoots.get(root);
  if (hit) return hit;
  try {
    const r = realpathSync(root);
    realRoots.set(root, r);
    return r;
  } catch {
    return undefined;
  }
}

/**
 * Like readInsideCheckout, but tells "missing" from "cannot be read": null only when nothing is
 * at the path (ENOENT, or ENOTDIR under a replaced directory); undefined when something is there
 * that may not be read (a symlink, an unreadable or oversized file, not a regular file). The
 * edit hooks must not treat the second as absent: that would submit a deletion.
 */
export function readCheckoutFile(root: string, abs: string, maxBytes: number): string | null | undefined {
  try {
    lstatSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
    // Missing is absent only if no directory on the way is a symlink (one could point outside).
    const rel = relative(resolve(root), resolve(abs));
    if (outsideRoot(rel)) return undefined;
    let cur = resolve(root);
    for (const part of rel.split(sep).slice(0, -1)) {
      cur = join(cur, part);
      try {
        if (lstatSync(cur).isSymbolicLink()) return undefined;
      } catch (dirErr) {
        const dirCode = (dirErr as NodeJS.ErrnoException)?.code;
        if (dirCode === "ENOENT" || dirCode === "ENOTDIR") return null; // the directory itself is missing
        return undefined; // cannot tell what is there
      }
    }
    return null;
  }
  return readInsideCheckout(root, abs, maxBytes) ?? undefined;
}

/** Text of `abs` if it is a regular, non-symlinked file inside `root`; otherwise null. */
export function readInsideCheckout(root: string, abs: string, maxBytes: number): string | null {
  const full = resolve(abs);
  const rel = relative(resolve(root), full);
  if (outsideRoot(rel)) return null;
  const rr = realRoot(resolve(root));
  if (!rr) return null;
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    return null; // missing, or a dangling link
  }
  if (real !== join(rr, rel.split("/").join(sep))) return null; // some component is a symlink
  let fd: number | undefined;
  try {
    fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
