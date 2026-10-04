// Legacy previews origin (shared by the web Worker and the browser client).
//
// Evidence and preview URLs written before weft-previews moved to its elier.ai custom
// domain point at the account's *.workers.dev host. workers.dev is disabled, so those
// links are dead, and that subdomain must never be shown (AGENTS.md rule 7). D1 rows were
// rewritten in place, but the WCP log is append-only, so `x_evidence` payloads of old
// checkpoint/land records still carry the legacy origin: rewrite it at read/render time.
// The capability signatures (/p/<repo>/<sha>/<sig>/, /e/<sig>/) cover repo+sha / object key
// only, not the host, so swapping the origin keeps the links valid.
//
// The subdomain itself is matched generically and never spelled out here.

const LEGACY_PREVIEWS = /https:\/\/weft-previews(-preview)?\.[a-z0-9-]+\.workers\.dev\//g;

/** Rewrite every legacy previews origin inside `text` (a URL, or a whole JSON body). */
export function fixLegacyUrls(/** @type {string} */ text) {
  if (!text.includes(".workers.dev/")) return text;
  return text.replace(LEGACY_PREVIEWS, (_m, env) => `https://weft-previews${env ?? ""}.elier.ai/`);
}

