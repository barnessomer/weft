// weft-previews: per-revision previews of candidate changes, straight out of Artifacts (B10).
//
// No deploy step and no deploy credential: a preview of revision <sha> of Artifacts repo
// <repo> is the repo's static site at that exact commit, read through the Artifacts binding
// (`readFile({ref: sha, path})`). The URL is a capability (HMAC over repo + sha, see sign.ts),
// immutable (content-addressed by the commit), and isolated per revision by a sandboxing CSP
// (opaque origin: one candidate's script cannot read another's storage on this host).
//
// What gets served comes from `.weft/preview.json` in the tree at <sha>:
//   { "root": "public", "routes": ["/", "/pricing.html"], "spa": false }
// root    directory served as the site root (default "public")
// routes  key routes the screenshot step captures (default ["/"])
// spa     serve root/index.html for unknown paths (default false)
//
// Also serves evidence blobs (screenshots, visual diffs) from R2 `weft-evidence` at
// /e/<sig>/<key>. Everything is GET/HEAD only.

import { evidenceSig, KEY_RE, previewSig, REPO_RE, same, SHA_RE } from "./sign";

export interface FileRepo {
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
}
export interface ArtifactsReader {
  get(name: string): Promise<FileRepo & Partial<Disposable>>;
}
export interface BlobBucket {
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string }; size?: number } | null>;
}
export interface Env {
  ARTIFACTS: ArtifactsReader;
  EVIDENCE: BlobBucket;
  WEFT_PREVIEW_KEY?: string;
}

export type PreviewConfig = { root: string; routes: string[]; spa: boolean };

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  woff2: "font/woff2",
  woff: "font/woff",
  wasm: "application/wasm",
};
export const typeOf = (path: string) => TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

const PREVIEW_HEADERS = {
  // Opaque origin per document: candidate code cannot share cookies/storage across previews.
  "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals",
  "access-control-allow-origin": "*",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function parseConfig(text: string | null): PreviewConfig {
  let raw: Record<string, unknown> = {};
  if (text) {
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      raw = {};
    }
  }
  const root = typeof raw.root === "string" ? raw.root.replace(/^\/+|\/+$/g, "") : "public";
  const routes = Array.isArray(raw.routes) ? raw.routes.filter((r): r is string => typeof r === "string" && r.startsWith("/")).slice(0, 8) : ["/"];
  return { root: root.includes("..") ? "public" : root, routes: routes.length ? routes : ["/"], spa: raw.spa === true };
}

/** Rewrite a root-relative URL attribute (`/app.css`) into this preview's prefix. */
export function rewriteAttr(value: string, prefix: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith(prefix + "/") || value === prefix) return value;
  return prefix + value;
}

async function read(repo: FileRepo, sha: string, path: string): Promise<Blob | null> {
  if (!path || path.split("/").some((s) => s === ".." || s === ".")) return null;
  try {
    return await repo.readFile({ ref: sha, path });
  } catch {
    return null;
  }
}

function notFound(msg: string): Response {
  return new Response(`${msg}\n`, { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" } });
}

async function servePreview(env: Env, repoName: string, sha: string, rest: string, prefix: string): Promise<Response> {
  const repo = await env.ARTIFACTS.get(repoName);
  try {
    const cfg = parseConfig(await (await read(repo, sha, ".weft/preview.json"))?.text() ?? null);
    const rel = decodeURIComponent(rest.replace(/^\/+/, ""));
    const base = cfg.root ? `${cfg.root}/` : "";
    const candidates = rel === "" || rel.endsWith("/") ? [`${base}${rel}index.html`] : [`${base}${rel}`, `${base}${rel}/index.html`, `${base}${rel}.html`];
    let file: Blob | null = null;
    let path = candidates[0]!;
    for (const c of candidates) {
      file = await read(repo, sha, c);
      if (file) {
        path = c;
        break;
      }
    }
    if (!file && cfg.spa) {
      path = `${base}index.html`;
      file = await read(repo, sha, path);
    }
    if (!file) return notFound(`not in this revision: /${rel} (root "${cfg.root}", .weft/preview.json)`);
    const type = typeOf(path);
    const headers = { ...PREVIEW_HEADERS, "content-type": type, "cache-control": "public, max-age=31536000, immutable", "x-weft-preview": `${repoName}@${sha.slice(0, 12)}` };
    const res = new Response(await file.arrayBuffer(), { headers });
    const HR = (globalThis as { HTMLRewriter?: typeof HTMLRewriter }).HTMLRewriter;
    if (!type.startsWith("text/html") || !HR) return res;
    const attr = (name: string) => ({
      element(el: Element) {
        const v = el.getAttribute(name);
        if (v) el.setAttribute(name, rewriteAttr(v, prefix));
      },
    });
    return new HR().on("[href]", attr("href")).on("[src]", attr("src")).on("form[action]", attr("action")).transform(res);
  } finally {
    repo[Symbol.dispose]?.();
  }
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/v1/health") return Response.json({ ok: true, service: "weft-previews" });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed\n", { status: 405 });
  if (!env.WEFT_PREVIEW_KEY) return new Response("previews are not configured\n", { status: 503 });

  const p = /^\/p\/([^/]+)\/([0-9a-f]{40})\/([A-Za-z0-9_-]{16,40})(\/.*)?$/.exec(url.pathname);
  if (p) {
    const [, repo, sha, sig, rest] = p as unknown as [string, string, string, string, string | undefined];
    if (!REPO_RE.test(repo) || !SHA_RE.test(sha) || !same(sig, await previewSig(env.WEFT_PREVIEW_KEY, repo, sha))) return notFound("unknown preview");
    const prefix = `/p/${repo}/${sha}/${sig}`;
    if (rest === undefined) return Response.redirect(`${url.origin}${prefix}/`, 302);
    return servePreview(env, repo, sha, rest, prefix);
  }

  const e = /^\/e\/([A-Za-z0-9_-]{16,40})\/(.+)$/.exec(url.pathname);
  if (e) {
    const [, sig, key] = e as unknown as [string, string, string];
    if (!KEY_RE.test(key) || key.includes("..") || !same(sig, await evidenceSig(env.WEFT_PREVIEW_KEY, key))) return notFound("unknown evidence");
    const obj = await env.EVIDENCE.get(key);
    if (!obj) return notFound("evidence blob not found");
    return new Response(obj.body, {
      headers: { "content-type": obj.httpMetadata?.contentType ?? typeOf(key), "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*", "x-robots-tag": "noindex", "x-content-type-options": "nosniff" },
    });
  }
  return notFound("weft-previews: /p/<repo>/<sha>/<sig>/ or /e/<sig>/<key>");
}

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
};
