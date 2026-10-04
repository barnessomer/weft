#!/usr/bin/env node
// Animated architecture diagrams (S02a, S11a) → clips/diagram/<id>.mp4.
// HTML/SVG generated here, animated in the page, filmed with Playwright's video recorder
// (1920x1080), trimmed and re-encoded to H.264 30 fps.
//
// Steps are keyed to narration cue words: each step fires when its words are spoken in the
// section's audio (same whisper word timestamps + lead as assemble.mjs), so a box lights up
// as the narrator names it. The clip runs the whole section; assemble.mjs cuts it to its slot.
//
//   node demo/video/rig/render-diagram.mjs [--shots S02a,S11a] [--audio demo/video/audio] [--work demo/video/out/.work]
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { args, sections, sh, durationSec, RIG, VIDEO } from "./lib.mjs";
import { scanText, scanVideo } from "./screen-safety.mjs";

const a = args();
const want = a.shots ? String(a.shots).split(",") : null;
const audioDir = a.audio ?? join(VIDEO, "audio");
const work = a.work ?? join(VIDEO, "out/.work");
const outDir = join(VIDEO, "clips/diagram");
mkdirSync(outDir, { recursive: true });
const edl = JSON.parse(readFileSync(join(RIG, "edl.json"), "utf8"));
const script = Object.fromEntries(sections().map((s) => [s.id, s]));
const W = 1920, H = 1080;

// ---- cue timing (mirrors assemble.mjs) ----
function cueTimer(secId) {
  const mp3 = join(audioDir, `${secId}.mp3`);
  const audioSec = durationSec(mp3);
  const sec = edl.sections.find((s) => s.id === secId);
  const lead = sec.lead ?? edl.lead, tail = sec.tail ?? edl.tail;
  const h = createHash("sha1").update(readFileSync(mp3)).digest("hex").slice(0, 12);
  const cache = join(work, `whisper-${h}.json`);
  const words = existsSync(cache) ? JSON.parse(readFileSync(cache, "utf8")) : null;
  if (!words) console.warn(`${secId}: no whisper cache ${cache}; proportional cue timing`);
  const sw = script[secId].text.split(/\s+/);
  const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
  const at = (cue) => {
    const cw = cue.split(/\s+/).map(norm);
    const i = sw.findIndex((_, k) => cw.every((c, j) => norm(sw[k + j] ?? "") === c));
    if (i < 0) throw new Error(`${secId}: cue "${cue}" not in narration`);
    if (!words?.length) return lead + (i / sw.length) * audioSec;
    const k = Math.min(words.length - 1, Math.round((i * (words.length - 1)) / Math.max(1, sw.length - 1)));
    return lead + words[k].s;
  };
  return { at, total: lead + audioSec + tail };
}

const CSS = `
:root{--bg:#0b0d12;--panel:#141822;--panel2:#181d29;--line:#2a3142;--fg:#e7eaf2;--fg2:#b4bccd;--muted:#6f788d;--accent:#7c9cff;--accent2:#ff6b8b;--err:#ff5d6c;--warn:#ffb547;--ok:#3ddc97;--cf:#f6821f}
*{box-sizing:border-box;margin:0}
body{width:${W}px;height:${H}px;overflow:hidden;background:radial-gradient(1300px 760px at 65% 25%,#151a2a 0,var(--bg) 62%);color:var(--fg);
 font:400 28px/1.3 "Inter","SF Pro Display",-apple-system,system-ui,sans-serif;position:relative}
.kicker{position:absolute;left:110px;top:70px;font:600 24px/1 "SF Mono",Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
h2{position:absolute;left:110px;top:108px;font-weight:680;font-size:54px;letter-spacing:-.01em}
.box{position:absolute;background:var(--panel);border:2px solid var(--line);border-radius:18px;padding:18px 24px;opacity:.0;transform:translateY(14px);
 transition:opacity .6s ease,transform .6s ease,border-color .45s ease,box-shadow .45s ease,background .45s ease}
.box.in{opacity:.92;transform:none}
.box.dim{opacity:.55}
.box.on{opacity:1;border-color:var(--accent);box-shadow:0 0 0 6px rgba(124,156,255,.16),0 0 60px rgba(124,156,255,.28);background:var(--panel2)}
.box.cf.on{border-color:var(--cf);box-shadow:0 0 0 6px rgba(246,130,31,.16),0 0 60px rgba(246,130,31,.30)}
.box .t{font-weight:650;font-size:30px}
.box .s{color:var(--fg2);font-size:22px;margin-top:6px}
.box .p{font:600 18px/1 "SF Mono",Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--cf);margin-bottom:8px}
.chip{display:inline-block;font:600 19px/1 "SF Mono",Menlo,monospace;padding:7px 11px;border-radius:9px;margin:8px 8px 0 0;background:#1f2533;color:var(--fg2);border:1px solid var(--line)}
.chip.err{color:var(--err);border-color:rgba(255,93,108,.5)} .chip.ok{color:var(--ok);border-color:rgba(61,220,151,.45)} .chip.warn{color:var(--warn);border-color:rgba(255,181,71,.45)}
svg{position:absolute;inset:0;pointer-events:none}
path.e{fill:none;stroke:var(--line);stroke-width:3;opacity:0;transition:opacity .5s ease,stroke .4s ease}
path.e.in{opacity:1} path.e.on{stroke:var(--accent);stroke-dasharray:10 10;animation:flow 0.8s linear infinite}
path.e.back.on{stroke:var(--err)}
@keyframes flow{to{stroke-dashoffset:-20}}
.log{position:absolute;display:flex;gap:10px;opacity:0;transition:opacity .6s}
.log.in{opacity:1}
.ev{font:600 20px/1 "SF Mono",Menlo,monospace;padding:10px 12px;border-radius:10px;background:#1b2130;border:1px solid var(--line);color:var(--fg2);opacity:0;transform:translateX(-30px);transition:opacity .35s,transform .35s}
.ev.in{opacity:1;transform:none} .ev.rej{color:var(--err);border-color:rgba(255,93,108,.6)}
.squig{position:absolute;opacity:0;transition:opacity .5s;font:500 24px/1.35 "SF Mono",Menlo,monospace;background:#120f14;border:2px solid rgba(255,93,108,.55);border-radius:14px;padding:16px 22px;color:var(--fg2)}
.squig.in{opacity:1}
.squig u{text-decoration:underline wavy var(--err);text-underline-offset:6px;color:var(--fg)}
.badge{position:absolute;opacity:0;transition:opacity .5s, transform .5s;transform:scale(.9);font:650 26px/1 "Inter",system-ui;padding:14px 22px;border-radius:999px;border:2px solid rgba(61,220,151,.5);color:var(--ok);background:rgba(61,220,151,.07)}
.badge.in{opacity:1;transform:none}
.foot{position:absolute;left:110px;bottom:56px;color:var(--muted);font:500 20px "SF Mono",Menlo,monospace;opacity:0;transition:opacity .6s}.foot.in{opacity:1}
`;

const box = (id, x, y, w, h, inner, cls = "") => `<div id="${id}" class="box ${cls}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">${inner}</div>`;
const edge = (id, d, cls = "") => `<path id="${id}" class="e ${cls}" d="${d}"/>`;

// ---------------- S02a: what Weft is ----------------
function s02a(T) {
  const agents = [["Claude Code", "hooks"], ["Codex", "hooks"], ["OpenCode", "plugin"], ["file watcher", "no hooks"], ["Hermes", "plugin"]];
  const ah = 96, ag = 22, ay0 = 250;
  const html = [
    `<div class="kicker">How it works</div><h2>One ordered log per repo. The verdict goes back to the agent.</h2>`,
    ...agents.map(([n, k], i) => box(`ag${i}`, 110, ay0 + i * (ah + ag), 330, ah, `<div class="t">${n}</div><div class="s">adapter · ${k}</div>`)),
    box("gw", 590, 470, 320, 150, `<div class="p">Workers</div><div class="t">Gateway</div><div class="s">WCP over HTTP / WebSocket</div>`, "cf"),
    box("do", 1060, 400, 720, 250, `<div class="p">Durable Object · one per repo</div><div class="t">Sequencer</div><div class="s">checks each edit against everything landed since the agent's base, down to the symbol</div>
      <div id="chips" style="opacity:0;transition:opacity .5s"><span class="chip">reads createSession · sig</span><span class="chip">writes signup.ts · body</span><span class="chip warn">base #2 → head #8</span></div>`, "cf"),
    `<div id="log" class="log" style="left:1060px;top:690px">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<span class="ev${n === 9 ? " rej" : ""}" id="ev${n}">#${n}${n === 9 ? " ✕" : ""}</span>`).join("")}</div>`,
    `<div class="foot" id="logcap" style="left:1060px;bottom:306px">strictly ordered log · repo weft-demo</div>`,
    `<div class="badge" id="nolock" style="left:1060px;top:300px">no locks · agents keep working · Weft validates</div>`,
    `<div class="squig" id="squig" style="left:110px;top:858px;width:1000px">codex-b · Edit src/signup.ts → <span style="color:var(--err)">REJECTED</span><br>you use <u>createSession</u>, whose signature changed in event #3</div>`,
    `<div class="foot" id="wcp" style="left:1220px;bottom:70px">wire format: Weft Coordination Protocol (WCP) v0.1</div>`,
  ];
  const ys = agents.map((_, i) => ay0 + i * (ah + ag) + ah / 2);
  const svg = [
    ...ys.map((y, i) => edge(`e${i}`, `M440 ${y} C 520 ${y}, 510 545, 590 545`)),
    edge("egd", "M910 545 L1060 545"),
    edge("eback", `M1100 650 C 1000 880, 520 800, 440 ${ys[1] + 10}`, "back"),
  ];
  const steps = [
    { t: 0.2, add: ["ag0", "ag1", "ag2", "ag3", "ag4"] },
    { t: T("built on Cloudflare"), add: ["gw", "do"], dim: [] },
    { t: T("Every tool call"), add: ["e0", "e1", "e2", "e3", "e4", "egd", "log", "logcap"], on: ["e0", "e1", "e2", "egd"], seq: { ids: [1, 2, 3, 4, 5, 6, 7, 8], prefix: "ev", every: 0.35 } },
    { t: T("A sequencer, one Durable"), on: ["do"], off: ["e0", "e1", "e2"] },
    { t: T("checks each edit"), show: ["chips"] },
    { t: T("Nothing is locked"), add: ["nolock"], off: ["do"], on: ["e3", "e4"], seq: { ids: [9, 10], prefix: "ev", every: 0.6 } },
    { t: T("The verdict goes straight"), add: ["eback", "squig"], on: ["eback", "ag1"], off: ["e3", "e4", "egd"] },
    { t: T("The wire format"), add: ["wcp"], off: ["eback"] },
  ];
  return { html: html.join(""), svg: svg.join(""), steps };
}

// ---------------- S11a: how it runs on Cloudflare ----------------
function s11a(T) {
  const html = [
    `<div class="kicker">Every product carries weight</div><h2>Weft on Cloudflare</h2>`,
    box("ctr", 110, 250, 400, 190, `<div class="p">Containers</div><div class="t">Agents + git</div><div class="s">Claude Code · Codex · OpenCode<br>no secrets inside</div>`, "cf"),
    box("gw", 640, 270, 300, 150, `<div class="p">Workers</div><div class="t">Gateway</div><div class="s">WCP API · WebSocket</div>`, "cf"),
    box("do", 1070, 250, 360, 190, `<div class="p">Durable Objects</div><div class="t">Sequencers</div><div class="s">one ordered log per repo</div>`, "cf"),
    box("art", 1530, 250, 300, 190, `<div class="p">Artifacts</div><div class="t">Git repos</div><div class="s">trunk · forks · previews</div>`, "cf"),
    box("q", 1530, 520, 300, 170, `<div class="p">Queues</div><div class="t">Events</div><div class="s">pushes · production errors</div>`, "cf"),
    box("wf", 1070, 520, 360, 170, `<div class="p">Workflows</div><div class="t">Ops</div><div class="s">rebase · land · revert · best-of-N</div>`, "cf"),
    box("br", 640, 520, 300, 170, `<div class="p">Browser Rendering</div><div class="t">Screenshots</div><div class="s">preview vs trunk pixel diff</div>`, "cf"),
    box("ai", 110, 520, 400, 170, `<div class="p">Workers AI · AI Gateway</div><div class="t">Review agent</div><div class="s">scores against acceptance criteria</div>`, "cf"),
    box("tail", 1530, 770, 300, 170, `<div class="p">Tail Workers</div><div class="t">Production</div><div class="s">every exception → detector</div>`, "cf"),
    box("st", 1070, 770, 360, 170, `<div class="p">D1 · R2</div><div class="t">Index + evidence</div><div class="s">tasks · candidates · screenshots</div>`, "cf"),
    box("hum", 110, 770, 830, 170, `<div class="p">Access</div><div class="t">Humans: web feed + Hermes on a phone</div><div class="s">approve · undo · pause · message</div>`, "cf"),
  ];
  const svg = [
    edge("c-g", "M510 345 L640 345"), edge("g-d", "M940 345 L1070 345"), edge("c-a", "M310 250 C 310 190, 1680 190, 1680 250"),
    edge("a-q", "M1680 440 L1680 520"), edge("q-w", "M1530 605 L1430 605"), edge("w-b", "M1070 605 L940 605"), edge("b-ai", "M640 605 L510 605"),
    edge("t-q", "M1680 770 L1680 690"), edge("w-s", "M1250 690 L1250 770"), edge("h-s", "M940 855 L1070 855"),
  ];
  const all = ["ctr", "gw", "do", "art", "q", "wf", "br", "ai", "tail", "st", "hum"];
  const steps = [
    { t: 0.2, add: all, dim: all },
    { t: T("Artifacts holds"), on: ["art"], add: ["c-a", "a-q"] },
    { t: T("Durable Objects are"), on: ["do", "gw"], add: ["c-g", "g-d"], flow: ["c-g", "g-d"] },
    { t: T("Workflows run rebase"), on: ["wf"], add: ["q-w"], flow: ["q-w"] },
    { t: T("Containers run agents"), on: ["ctr"], flow: ["c-a"] },
    { t: T("Queues carry pushes"), on: ["q"], flow: ["a-q"] },
    { t: T("Tail Workers watch"), on: ["tail"], add: ["t-q"], flow: ["t-q"] },
    { t: T("Browser Rendering takes"), on: ["br"], add: ["w-b"], flow: ["w-b"] },
    { t: T("Workers AI and"), on: ["ai"], add: ["b-ai"], flow: ["b-ai"] },
    { t: T("D1 and R2"), on: ["st"], add: ["w-s", "h-s"], flow: ["w-s"] },
    { t: T("Weft. Coordination at"), on: ["hum"], flow: ["h-s"], allOn: true },
  ];
  return { html: html.join(""), svg: svg.join(""), steps };
}

const SHOTS = { S02a: { sec: "02", fn: s02a }, S11a: { sec: "11", fn: s11a } };

// Runs in the page: "add" fades elements in, "on" highlights (previous highlights fall back to
// lit-but-calm unless "keep"), "off" removes a highlight, "flow" animates edges, "seq" reveals
// log events one by one.
const RUNTIME = `
window.play = (steps) => {
  const $ = (id) => document.getElementById(id);
  let lit = [];
  for (const s of steps) setTimeout(() => {
    (s.add ?? []).forEach((id) => $(id)?.classList.add("in"));
    (s.dim ?? []).forEach((id) => $(id)?.classList.add("dim"));
    (s.show ?? []).forEach((id) => { const e = $(id); if (e) e.style.opacity = 1; });
    (s.off ?? []).forEach((id) => $(id)?.classList.remove("on"));
    if (s.flow) { document.querySelectorAll("path.e.on").forEach((p) => p.classList.remove("on")); s.flow.forEach((id) => $(id)?.classList.add("in", "on")); }
    if (s.on) {
      const boxes = s.on.filter((id) => $(id)?.classList.contains("box"));
      if (boxes.length) { lit.forEach((id) => { $(id)?.classList.remove("on"); }); lit = boxes; }
      s.on.forEach((id) => { const e = $(id); if (!e) return; e.classList.add("in", "on"); e.classList.remove("dim"); });
    }
    if (s.allOn) document.querySelectorAll(".box").forEach((b) => b.classList.remove("dim"));
    if (s.seq) s.seq.ids.forEach((n, i) => setTimeout(() => $(s.seq.prefix + n)?.classList.add("in"), i * s.seq.every * 1000));
  }, s.t * 1000);
};`;

const browser = await chromium.launch();
for (const [id, spec] of Object.entries(SHOTS)) {
  if (want && !want.includes(id)) continue;
  const { at, total } = cueTimer(spec.sec);
  const T = (cue) => +at(cue).toFixed(2);
  const d = spec.fn(T);
  const hits = scanText(d.html);
  if (hits.length) throw new Error(`${id}: forbidden text in diagram: ${JSON.stringify(hits)}`);
  const page0 = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${d.html}<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${d.svg}</svg><script>${RUNTIME}</script></body></html>`;
  const dir = join(outDir, `.raw-${id}`);
  rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir, size: { width: W, height: H } } });
  const t0 = Date.now();
  const page = await ctx.newPage();
  await page.setContent(page0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const start = (Date.now() - t0) / 1000;
  await page.evaluate((s) => window.play(s), d.steps);
  await page.waitForTimeout((total + 1) * 1000);
  await ctx.close();
  const raw = join(dir, readdirSync(dir).find((f) => f.endsWith(".webm")));
  const mp4 = join(outDir, `${id}.mp4`);
  sh("ffmpeg", ["-y", "-loglevel", "error", "-ss", start.toFixed(3), "-i", raw, "-t", total.toFixed(3), "-vf", "fps=30", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-an", mp4]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`${id}: ${durationSec(mp4).toFixed(1)} s -> ${mp4}; steps at ${d.steps.map((s) => s.t).join(", ")}`);
  if (!a["no-check"]) {
    const r = scanVideo(mp4, 2);
    console.log(`  screen-safety: ${r.frames} frames, ${r.hits.length} hit(s)`);
    if (r.hits.length) process.exit(1);
  }
}
await browser.close();
