import { describe, expect, it } from "vitest";
import { handle, parseConfig, rewriteAttr, type Env } from "../src/index";
import { evidenceUrl, previewUrl } from "../src/sign";

const KEY = "test-preview-key";
const SHA = "a".repeat(40);
const ORIGIN = "https://previews.test";

function env(files: Record<string, string>, blobs: Record<string, string> = {}): Env {
  return {
    WEFT_PREVIEW_KEY: KEY,
    ARTIFACTS: {
      get: async (name) => ({
        readFile: async ({ ref, path }) => (name === "demo-fork" && ref === SHA && path in files ? new Blob([files[path]!]) : null),
      }),
    },
    EVIDENCE: { get: async (k) => (k in blobs ? { body: new Blob([blobs[k]!]).stream(), httpMetadata: { contentType: "image/png" } } : null) },
  };
}

describe("weft-previews", () => {
  it("serves the tree at the signed revision with the preview root", async () => {
    const e = env({ ".weft/preview.json": JSON.stringify({ root: "site", routes: ["/", "/about.html"] }), "site/index.html": "<h1>hi</h1>", "site/app.css": "h1{}" });
    const url = await previewUrl(ORIGIN, KEY, "demo-fork", SHA);
    const r = await handle(new Request(url), e);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("<h1>hi</h1>");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    const css = await handle(new Request(url + "app.css"), e);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  it("refuses a forged signature, another sha, and path traversal", async () => {
    const e = env({ "public/index.html": "x", "secret.txt": "no" });
    const url = await previewUrl(ORIGIN, KEY, "demo-fork", SHA);
    expect((await handle(new Request(url.replace(/\/p\/demo-fork\/a+\/[^/]+/, `/p/demo-fork/${SHA}/AAAAAAAAAAAAAAAAAAAAAA`)), e)).status).toBe(404);
    expect((await handle(new Request(url.replace(SHA, "b".repeat(40))), e)).status).toBe(404);
    expect((await handle(new Request(url + "..%2Fsecret.txt"), e)).status).toBe(404);
  });

  it("serves signed evidence blobs only", async () => {
    const e = env({}, { "screens/c/1.png": "PNG" });
    const ok = await handle(new Request(await evidenceUrl(ORIGIN, KEY, "screens/c/1.png")), e);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    const forged = (await evidenceUrl(ORIGIN, KEY, "screens/c/1.png")).replace("screens/c/1.png", "screens/c/2.png");
    expect((await handle(new Request(forged), e)).status).toBe(404);
  });

  it("parses config defensively and rewrites root-relative URLs", () => {
    expect(parseConfig(null)).toEqual({ root: "public", routes: ["/"], spa: false });
    expect(parseConfig('{"root":"../x","routes":["/a","b"]}')).toEqual({ root: "public", routes: ["/a"], spa: false });
    expect(rewriteAttr("/app.css", "/p/r/s/g")).toBe("/p/r/s/g/app.css");
    expect(rewriteAttr("//cdn.example/x.js", "/p/r/s/g")).toBe("//cdn.example/x.js");
    expect(rewriteAttr("app.css", "/p/r/s/g")).toBe("app.css");
  });
});
