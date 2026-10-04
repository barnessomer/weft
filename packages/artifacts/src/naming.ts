// Names and identities for candidate changes (design §2.2, §6.2).

/** Artifacts repo names: alphanumerics, dots, hyphens, underscores. We cap at 63 chars. */
export const ARTIFACTS_REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const MAX = 63;

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0").slice(-7);
}

/**
 * Fork name for candidate `n` of `task` on `repo`: `weft-<repo>-<task>-<n>`.
 * Deterministic; long names are shortened with a stable hash so they stay unique and ≤63.
 */
export function forkName(repo: string, task: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`candidate number must be a positive integer, got ${n}`);
  const r = slug(repo) || "repo";
  const t = slug(task) || "task";
  const full = `weft-${r}-${t}-${n}`;
  if (full.length <= MAX) return full;
  const tail = `-${fnv1a(`${repo}\u0000${task}`)}-${n}`;
  const room = MAX - "weft-".length - tail.length;
  const rr = r.slice(0, Math.max(4, Math.floor(room / 2))).replace(/[-._]+$/, "");
  const tt = t.slice(0, Math.max(1, room - rr.length - 1)).replace(/[-._]+$/, "");
  return `weft-${rr}-${tt}${tail}`.slice(0, MAX);
}

/** Gerrit-compatible Change-Id: `I` + 40 lowercase hex. Stable for the life of a change. */
export function newChangeId(): string {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return "I" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export const CHANGE_ID = /^I[0-9a-f]{40}$/;

/** Commit trailers Weft installs via the commit-msg hook (design §2.2). */
export interface WeftTrailers {
  "Change-Id"?: string;
  "Task-Id"?: string;
  "Agent-Id"?: string;
}

/** Parse the trailer block (last paragraph of `Key: value` lines) of a commit message. */
export function parseTrailers(message: string): WeftTrailers & Record<string, string> {
  const paras = message.replace(/\r\n/g, "\n").trimEnd().split(/\n\s*\n/);
  const last = paras.length > 1 ? paras[paras.length - 1]! : "";
  const out: Record<string, string> = {};
  const lines = last.split("\n");
  if (!lines.every((l) => /^[A-Za-z0-9-]+:\s?.*$/.test(l) || /^\s+\S/.test(l))) return out;
  for (const l of lines) {
    const m = /^([A-Za-z0-9-]+):\s?(.*)$/.exec(l);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/** Render trailers for appending to a commit message. */
export function formatTrailers(t: WeftTrailers): string {
  return (["Change-Id", "Task-Id", "Agent-Id"] as const)
    .filter((k) => t[k])
    .map((k) => `${k}: ${t[k]}`)
    .join("\n");
}
