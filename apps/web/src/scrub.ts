// Public read-only demo (WEFT_PUBLIC_DEMO=1): scrub text before it leaves the Worker.
//
// The append-only WCP log of the dogfood repo carries diffs written before every Worker moved
// to its elier.ai custom domain, so it still contains the account's *.workers.dev hostnames.
// That subdomain must never be shown (AGENTS.md rule 7). Every `<worker>.<sub>.workers.dev`
// becomes `<worker>.elier.ai` (where the custom domains live); any other workers.dev host and
// any hostname cut off by log truncation ("https://weft-x.<partial>...") is redacted; extra
// literal terms (secret WEFT_REDACT, comma-separated, matched case-insensitively) are replaced.
// The subdomain itself is never spelled out in this repository.

const WORKER_HOST = /\b(https?:\/\/)?([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev\b/gi;
const BARE_HOST = /\b[a-z0-9-]+\.workers\.dev\b/gi;
const TRUNCATED_HOST = /(https?:\/\/[a-z0-9-]+)\.[a-z0-9-]+(?=\.\.\.|\u2026|\\u2026)/gi;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function redactTerms(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

export function scrubPublic(text: string, terms: string[] = []): string {
  let out = text;
  for (const t of terms) out = out.replace(new RegExp(escapeRe(t), "gi"), "redacted");
  if (out.includes(".workers.dev")) {
    out = out.replace(WORKER_HOST, (_m, scheme: string | undefined, worker: string) => `${scheme ?? ""}${worker}.elier.ai`);
    out = out.replace(BARE_HOST, "redacted.invalid");
  }
  return out.replace(TRUNCATED_HOST, (m, head: string) => (/\.elier$|\.ai$/i.test(m) ? m : `${head}.[redacted]`));
}
