#!/usr/bin/env node
// Record web UI shots with Playwright video at 1920x1080 against the Weft web UI.
//
//   node demo/video/rig/record-web.mjs [--shots S03a,S05b] [--base https://weft-web-preview.elier.ai]
//        [--file demo/video/rig/shots/web.json] [--out demo/video/clips/web] [--headed]
//
// Auth (docs: ../rig/README.md#web-auth):
//   - Cloudflare Access with a service token: set WEFT_ACCESS_CLIENT_ID / WEFT_ACCESS_CLIENT_SECRET;
//     they are sent as CF-Access-Client-Id/-Secret on every request (Access then mints the JWT the
//     Worker verifies). Never put them on screen or in a URL.
//   - Operator key (current preview: Access not configured): the key is read from
//     ~/.config/weft/web-preview-key and POSTed to /login through the context's request API before
//     any page exists, so the login form never appears in a recording.
//
// Every frame-producing step is followed by a screen-safety probe of the page text
// (rig/screen-safety.mjs patterns); a hit aborts the shot and deletes its video.
//
// Output per shot: <out>/<id>.mp4 (H.264, 1920x1080, 30 fps, trimmed to the scripted part) and
// <id>.json (timings). The raw Playwright .webm is deleted after transcoding.
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { args, sh, RIG, VIDEO } from "./lib.mjs";
import { FORBIDDEN } from "./screen-safety.mjs";

const a = args();
const base = (a.base ?? "https://weft-web-preview.elier.ai").replace(/\/$/, "");
if (/workers\.dev/i.test(base)) throw new Error("refusing a *.workers.dev base URL (use the elier.ai hostname)");
const file = a.file ?? join(RIG, "shots/web.json");
const spec = JSON.parse(readFileSync(file, "utf8"));
const want = a.shots ? String(a.shots).split(",") : null;
const shots = spec.shots.filter((s) => !want || want.includes(s.id));
const out = a.out ?? join(VIDEO, "clips/web");
mkdirSync(out, { recursive: true });

const W = 1920, H = 1080;
const headers = {};
if (process.env.WEFT_ACCESS_CLIENT_ID && process.env.WEFT_ACCESS_CLIENT_SECRET) {
  headers["CF-Access-Client-Id"] = process.env.WEFT_ACCESS_CLIENT_ID;
  headers["CF-Access-Client-Secret"] = process.env.WEFT_ACCESS_CLIENT_SECRET;
}

async function login(ctx) {
  if (headers["CF-Access-Client-Id"]) return "access-service-token";
  const keyFile = join(homedir(), ".config/weft/web-preview-key");
  if (!existsSync(keyFile)) throw new Error(`no Access service token env and no ${keyFile}`);
  const key = readFileSync(keyFile, "utf8").trim();
  const r = await ctx.request.post(`${base}/login`, { form: { key }, maxRedirects: 0 });
  if (r.status() !== 303) throw new Error(`operator-key login failed: HTTP ${r.status()}`);
  return "operator-key";
}

const warned = new Set();
async function probe(page, shot) {
  const { text, attrs } = await page.evaluate(() => ({
    text: document.body.innerText + "\n" + location.href + "\n" + document.title,
    attrs: [...document.querySelectorAll("a[href], img[src]")].map((e) => e.getAttribute("href") ?? e.getAttribute("src")).join("\n"),
  }));
  for (const re of FORBIDDEN) {
    const m = text.match(re);
    if (m) throw new Error(`screen-safety: ${shot.id} shows forbidden text /${re.source}/`);
    // Not visible (attribute only) but a smell: broken images / links that would show on hover.
    if (re.test(attrs) && !warned.has(shot.id + re.source)) {
      warned.add(shot.id + re.source);
      console.warn(`${shot.id}: WARNING link/img attribute matches /${re.source}/ (not on screen; fix the data)`);
    }
  }
}

async function run(page, shot, t0, marks) {
  for (const st of shot.steps) {
    const [op, arg] = Object.entries(st)[0];
    switch (op) {
      case "goto": await page.goto(arg.startsWith("http") ? arg : `${base}/${arg.replace(/^\//, "")}`, { waitUntil: "domcontentloaded" }); break;
      case "waitFor": await page.waitForSelector(arg, { timeout: st.timeout ?? 20000 }); break;
      case "waitText": await page.getByText(arg, { exact: false }).first().waitFor({ timeout: st.timeout ?? 20000 }); break;
      case "click": await page.locator(arg).first().click(); break;
      case "clickText": await page.getByText(arg, { exact: st.exact ?? false }).first().click(); break;
      case "hover": await page.locator(arg).first().hover(); break;
      case "select": await page.locator(arg[0]).first().selectOption(String(arg[1])); break;
      case "fill": await page.locator(arg[0]).first().fill(arg[1]); break;
      case "type": await page.locator(arg[0]).first().pressSequentially(arg[1], { delay: st.delay ?? 60 }); break;
      case "press": await page.keyboard.press(arg); break;
      case "scroll": await page.mouse.wheel(0, arg); break;
      case "scrollTo": await page.locator(arg).first().scrollIntoViewIfNeeded(); break;
      case "eval": await page.evaluate(arg); break;
      case "mark": marks[arg] = (Date.now() - t0) / 1000; break; // "start"/"end" define the trim
      case "hold": await page.waitForTimeout(arg); break;
      default: throw new Error(`unknown step ${op}`);
    }
    if (op !== "hold" && op !== "mark") await probe(page, shot);
  }
}

const browser = await chromium.launch({ headless: !a.headed });
let failed = 0;
for (const shot of shots) {
  const dir = join(out, `.raw-${shot.id}`);
  rmSync(dir, { recursive: true, force: true });
  // scale > 1 = larger UI at full sharpness. Playwright's video records CSS pixels (a smaller
  // viewport with deviceScaleFactor just leaves a grey border), so the page is CSS-zoomed instead.
  const scale = shot.scale ?? spec.scale ?? 1.25;
  const ctx = await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: shot.colorScheme ?? "dark",
    extraHTTPHeaders: headers, recordVideo: { dir, size: { width: W, height: H } },
  });
  const auth = await login(ctx);
  if (scale !== 1) {
    await ctx.addInitScript((z) => {
      const apply = () => { document.documentElement.style.zoom = String(z); };
      if (document.documentElement) apply(); else document.addEventListener("DOMContentLoaded", apply);
    }, scale);
  }
  const page = await ctx.newPage();
  const t0 = Date.now();
  const marks = {};
  try {
    await run(page, shot, t0, marks);
    marks.end ??= (Date.now() - t0) / 1000;
    marks.start ??= 0;
    await page.close();
    const raw = await page.video().path();
    await ctx.close();
    const mp4 = join(out, `${shot.id}.mp4`);
    // Playwright starts the clock at page creation; trim to the scripted [start, end] window.
    sh("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(marks.start), "-to", String(marks.end), "-i", raw,
      "-vf", `scale=${W}:${H}:flags=lanczos,fps=30,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-an", mp4]);
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(join(out, `${shot.id}.json`), JSON.stringify({ id: shot.id, base, auth, marks, recorded_at: new Date().toISOString() }, null, 2) + "\n");
    console.log(`${shot.id}: ${(marks.end - marks.start).toFixed(1)} s -> ${mp4} (auth ${auth})`);
  } catch (e) {
    failed++;
    console.error(`${shot.id}: FAILED ${e.message}`);
    // Debug screenshot only when the failure is not a screen-safety hit (never keep unsafe pixels).
    if (!String(e.message).startsWith("screen-safety")) {
      try { await page.screenshot({ path: join(out, `${shot.id}.failed.png`) }); } catch {}
    }
    await ctx.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
