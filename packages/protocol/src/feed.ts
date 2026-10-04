// Combined change log across repos (spec §9.5). The cursor is a per-repo high-water-mark
// vector so that resume is exact even when repos advance at different rates.

import type { EventRecord, FeedPage, Seq } from "./types";

export type FeedCursor = Record<string, Seq>;

const b64url = {
  encode(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(s: string): string {
    const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const bin = atob(pad);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  },
};

/** Cursor wire form: `v0.` + base64url(JSON of {repo: seq}) with keys sorted. */
export function encodeCursor(c: FeedCursor): string {
  const sorted = Object.fromEntries(Object.keys(c).sort().map((k) => [k, c[k]!]));
  return `v0.${b64url.encode(JSON.stringify(sorted))}`;
}

export function decodeCursor(s: string | undefined | null): FeedCursor {
  if (!s) return {};
  if (!s.startsWith("v0.")) throw new Error("unsupported feed cursor version");
  const v = JSON.parse(b64url.decode(s.slice(3))) as unknown;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("malformed feed cursor");
  for (const [k, n] of Object.entries(v)) if (!Number.isInteger(n) || (n as number) < 0) throw new Error(`bad seq for ${k}`);
  return v as FeedCursor;
}

/** Total order of the combined feed: (ts, repo, seq). */
export function compareFeed(a: EventRecord, b: EventRecord): number {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.seq - b.seq;
}

/**
 * Merge per-repo pages (each the events with seq > cursor[repo], ascending) into one feed
 * page. Repos absent from the cursor start at 0. Returns the advanced cursor. With
 * `tail`, pass each repo's newest events plus `head_seq`; the page is the newest `limit`
 * records overall and the cursor points at every repo's head (spec §9.5).
 */
export function mergeFeed(
  perRepo: Record<string, { events: EventRecord[]; has_more: boolean; head_seq?: number }>,
  cursor: FeedCursor,
  limit: number,
  opts: { tail?: boolean } = {},
): FeedPage {
  const all = Object.values(perRepo)
    .flatMap((p) => p.events)
    .filter((e) => opts.tail || e.seq > (cursor[e.repo] ?? 0))
    .sort(compareFeed);
  const page = opts.tail ? all.slice(Math.max(0, all.length - limit)) : all.slice(0, limit);
  const next: FeedCursor = opts.tail ? {} : { ...cursor };
  for (const [r, p] of Object.entries(perRepo)) next[r] ??= opts.tail ? (p.head_seq ?? 0) : 0;
  if (!opts.tail) for (const e of page) next[e.repo] = Math.max(next[e.repo] ?? 0, e.seq);
  // A tail page is by definition caught up: the cursor points at every repo's head.
  const has_more = !opts.tail && (all.length > page.length || Object.values(perRepo).some((p) => p.has_more));
  return { type: "feed", events: page, cursor: encodeCursor(next), has_more };
}
