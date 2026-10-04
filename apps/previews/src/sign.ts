// Capability URLs for candidate previews and evidence blobs (B10).
//
// A preview URL names an Artifacts repo + an exact commit and carries an HMAC over both, so
// anyone holding the link can view that one revision and nothing else (no repo listing, no
// other refs). Evidence blobs (screenshots, visual diffs in R2) use the same scheme. The key is
// the `WEFT_PREVIEW_KEY` secret shared by weft-previews and weft-workflows.
//
//   /p/<repo>/<sha40>/<sig>/<path>     revision preview (static files of the tree at <sha>)
//   /e/<sig>/<r2 key>                  evidence blob from R2 bucket weft-evidence
//
// Runtime-neutral (WebCrypto only): imported by both Workers and the Node tests.

const enc = new TextEncoder();

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
  let s = "";
  for (const b of sig.subarray(0, 16)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string comparison. */
export function same(a: string, b: string): boolean {
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const SHA_RE = /^[0-9a-f]{40}$/;
export const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,400}$/;

export async function previewSig(key: string, repo: string, sha: string): Promise<string> {
  return hmac(key, `preview\n${repo}\n${sha}`);
}
export async function evidenceSig(key: string, objectKey: string): Promise<string> {
  return hmac(key, `evidence\n${objectKey}`);
}

/** Absolute preview URL for `path` (default `/`) of revision `sha` of Artifacts repo `repo`. */
export async function previewUrl(origin: string, key: string, repo: string, sha: string, path = "/"): Promise<string> {
  if (!REPO_RE.test(repo)) throw new Error(`bad repo name ${repo}`);
  if (!SHA_RE.test(sha)) throw new Error(`bad sha ${sha}`);
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${origin.replace(/\/+$/, "")}/p/${repo}/${sha}/${await previewSig(key, repo, sha)}${p}`;
}

/** Absolute URL of an evidence blob stored in R2 under `objectKey`. */
export async function evidenceUrl(origin: string, key: string, objectKey: string): Promise<string> {
  if (!KEY_RE.test(objectKey) || objectKey.includes("..")) throw new Error(`bad evidence key ${objectKey}`);
  return `${origin.replace(/\/+$/, "")}/e/${await evidenceSig(key, objectKey)}/${objectKey}`;
}
