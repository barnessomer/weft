// Cloudflare capabilities for the B10 evidence pipeline (src/core/evidence.ts):
//
//   preview   Artifacts-backed preview URLs (weft-previews Worker): the candidate's rebased
//             revision and trunk at the same base, signed with WEFT_PREVIEW_KEY. Exists only
//             when the revision carries `.weft/preview.json` (read through the Artifacts binding).
//   capture   Browser Rendering (puppeteer on the BROWSER binding): each key route of candidate
//             and trunk at 1280×800, pixel diff computed in the headless browser (canvas), PNGs
//             stored in R2 `weft-evidence` and served by weft-previews as signed URLs.
//   classify  Workers AI risk classification of the diff, through AI Gateway (metadata-tagged).
//   review    Review agent: Workers AI via AI Gateway scores the candidate against the task's
//             acceptance criteria (diff + tests + visual diff).

import puppeteer from "@cloudflare/puppeteer";
import { evidenceUrl, previewUrl } from "@weft/previews/sign";
import { parseReview, parseRisk, reviewPrompt, riskPrompt, type Capture, type EvidenceCapabilities, type Shot } from "./core/evidence";

export interface EvidenceEnv {
  ARTIFACTS: unknown;
  AI?: Ai;
  BROWSER?: Fetcher;
  EVIDENCE?: R2Bucket;
  /** Origin of weft-previews (e.g. https://weft-previews-preview.<sub>.workers.dev). */
  WEFT_PREVIEWS_URL?: string;
  WEFT_PREVIEW_KEY?: string;
  /** AI Gateway id for model calls (the `weft` gateway once created; `default` until then). */
  AI_GATEWAY_ID?: string;
  WEFT_REVIEW_MODEL?: string;
  WEFT_RISK_MODEL?: string;
}

const REVIEW_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const RISK_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const VIEWPORT = { width: 1280, height: 800 };
const MAX_ROUTES = 4;

type FileRepo = { readFile(a: { ref: string; path: string }): Promise<Blob | null> } & Partial<Disposable>;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const slug = (route: string) => (route.replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9._-]+/g, "_") || "index").slice(0, 60);

/** Text of a Workers AI text-generation result (string `response`, an already-parsed object, or OpenAI-style choices). */
export function aiText(out: unknown): string {
  const o = out as { response?: unknown; choices?: Array<{ message?: { content?: string } }> } | null;
  if (typeof o?.response === "string") return o.response;
  if (o?.response && typeof o.response === "object") return JSON.stringify(o.response);
  const c = o?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : JSON.stringify(out ?? "");
}

// In-browser pixel diff (runs in Chromium via page.evaluate): grey ghost of the candidate with
// changed pixels in magenta; returns the count and the diff PNG (base64).
const DIFF_FN = `async (a, b) => {
  const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("image decode failed")); i.src = "data:image/png;base64," + src; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
  const px = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
  const da = px(ia), db = px(ib);
  const oc = document.createElement("canvas"); oc.width = w; oc.height = h; const ox = oc.getContext("2d"); const out = ox.createImageData(w, h); const o = out.data;
  let diff = 0;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
    if (d > 48) { diff++; o[i] = 255; o[i + 1] = 0; o[i + 2] = 128; o[i + 3] = 255; }
    else { const g = 255 - ((255 - (da[i] + da[i + 1] + da[i + 2]) / 3) * 0.25); o[i] = g; o[i + 1] = g; o[i + 2] = g; o[i + 3] = 255; }
  }
  ox.putImageData(out, 0, 0);
  return { pixels: diff, total: w * h, png: oc.toDataURL("image/png").split(",")[1] };
}`;

export function evidenceCaps(env: EvidenceEnv): EvidenceCapabilities | undefined {
  const caps: EvidenceCapabilities = {};
  const origin = env.WEFT_PREVIEWS_URL;
  const key = env.WEFT_PREVIEW_KEY;
  const gateway = env.AI_GATEWAY_ID || "default";

  if (origin && key && env.ARTIFACTS) {
    caps.preview = async ({ candidate, trunk }) => {
      const arts = env.ARTIFACTS as { get(name: string): Promise<FileRepo> };
      const repo = await arts.get(candidate.repo);
      let cfg: string | null;
      try {
        cfg = (await (await repo.readFile({ ref: candidate.sha, path: ".weft/preview.json" }))?.text()) ?? null;
      } finally {
        repo[Symbol.dispose]?.();
      }
      if (cfg === null) return null;
      let routes = ["/"];
      try {
        const j = JSON.parse(cfg) as { routes?: unknown };
        if (Array.isArray(j.routes)) routes = j.routes.filter((r): r is string => typeof r === "string" && r.startsWith("/")).slice(0, MAX_ROUTES);
      } catch {
        /* defaults */
      }
      return {
        url: await previewUrl(origin, key, candidate.repo, candidate.sha),
        trunk_url: trunk ? await previewUrl(origin, key, trunk.repo, trunk.sha) : null,
        routes: routes.length ? routes : ["/"],
        provider: "weft-previews (Artifacts)",
      };
    };
  }

  if (env.BROWSER && env.EVIDENCE && origin && key) {
    const bucket = env.EVIDENCE;
    const put = async (k: string, bytes: Uint8Array, meta: Record<string, string>): Promise<Shot> => {
      await bucket.put(k, bytes, { httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" }, customMetadata: meta });
      return { key: k, uri: await evidenceUrl(origin, key, k), width: VIEWPORT.width, height: VIEWPORT.height };
    };
    caps.capture = async ({ repo, change, sha, onto, preview }) => {
      const browser = await puppeteer.launch(env.BROWSER!);
      const out: Capture[] = [];
      try {
        const page = await browser.newPage();
        await page.setViewport(VIEWPORT);
        const shoot = async (url: string): Promise<Uint8Array> => {
          const res = await page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 });
          if (res && res.status() >= 400) throw new Error(`${res.status()} from ${url.replace(/\/p\/[^/]+\/[0-9a-f]{40}\/[^/]+/, "/p/…")}`);
          return (await page.screenshot({ type: "png" })) as Uint8Array;
        };
        for (const route of preview.routes.slice(0, MAX_ROUTES)) {
          const s = slug(route);
          const rel = route.replace(/^\/+/, "");
          let cand: Shot;
          let candBytes: Uint8Array;
          try {
            candBytes = await shoot(preview.url + rel);
            cand = await put(`screens/${repo}/${change}/${sha.slice(0, 12)}/${s}.png`, candBytes, { repo, change, sha, route });
          } catch (e) {
            out.push({ route, candidate: { uri: "", key: "", width: 0, height: 0 }, error: String((e as Error).message ?? e).slice(0, 300) });
            continue;
          }
          const c: Capture = { route, candidate: cand, trunk: null, diff: null };
          if (preview.trunk_url && onto) {
            try {
              const tb = await shoot(preview.trunk_url + rel);
              c.trunk = await put(`screens/${repo}/trunk/${onto.slice(0, 12)}/${s}.png`, tb, { repo, sha: onto, route });
              await page.goto("about:blank");
              const d = (await page.evaluate(`(${DIFF_FN})(${JSON.stringify(b64(candBytes))}, ${JSON.stringify(b64(tb))})`)) as { pixels: number; total: number; png: string };
              const diffShot = d.pixels > 0 ? await put(`screens/${repo}/${change}/${sha.slice(0, 12)}/${s}.diff.png`, unb64(d.png), { repo, change, sha, route, against: onto }) : null;
              c.diff = { ratio: Math.round((d.pixels / Math.max(1, d.total)) * 1e6) / 1e6, pixels: d.pixels, total: d.total, uri: diffShot?.uri ?? null };
            } catch (e) {
              // Trunk may legitimately lack the route (new page): candidate shot still counts.
              c.error = `trunk baseline: ${String((e as Error).message ?? e).slice(0, 200)}`;
            }
          }
          out.push(c);
        }
      } finally {
        await browser.close().catch(() => undefined);
      }
      return out;
    };
    caps.screenshot = async (k) => {
      const o = await bucket.get(k);
      return o ? b64(new Uint8Array(await o.arrayBuffer())) : null;
    };
  }

  if (env.AI) {
    const ai = env.AI;
    const run = async (model: string, messages: Array<{ role: string; content: string }>, metadata: Record<string, string>, max_tokens: number) =>
      aiText(await ai.run(model as Parameters<Ai["run"]>[0], { messages, max_tokens, temperature: 0 } as never, { gateway: { id: gateway, metadata, collectLog: true } } as never));
    caps.classify = async (input) => {
      const model = env.WEFT_RISK_MODEL || RISK_MODEL;
      const text = await run(model, riskPrompt(input), { purpose: "weft-risk", repo: input.repo ?? "", change: input.change ?? "" }, 400);
      const parsed = parseRisk(text);
      if (!parsed) throw new Error(`risk classifier gave no verdict: ${text.slice(0, 200)}`);
      return { ...parsed, model };
    };
    caps.review = async (input) => {
      const model = env.WEFT_REVIEW_MODEL || REVIEW_MODEL;
      const text = await run(model, reviewPrompt(input), { purpose: "weft-review", repo: input.repo ?? "", change: input.change ?? "" }, 1200);
      const parsed = parseReview(text, input.criteria, model);
      if (!parsed) throw new Error(`review agent gave no verdict: ${text.slice(0, 200)}`);
      return parsed;
    };
  }
  return Object.keys(caps).length ? caps : undefined;
}
