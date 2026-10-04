#!/usr/bin/env node
// Assemble the video: per script section, cut the EDL's shots to the narration length, burn in
// captions (PNG overlays — this machine's ffmpeg has no libass/drawtext), mux the narration,
// then concatenate all sections. Also writes captions.srt for the whole timeline.
//
//   node demo/video/rig/assemble.mjs [--audio demo/video/audio] [--sections 00,01] [--out demo/video/out]
//        [--plan]       print each shot's slot vs clip length (no encoding)
//        [--no-align]   caption timing proportional to words instead of whisper word timestamps
//
// Inputs: script.md (narration + captions text), rig/edl.json, clips/*/<shot>.mp4, <audio>/<id>.mp3.
// Output: <out>/weft-demo.mp4 (H.264 1080p30, AAC), <out>/captions.srt, <out>/timeline.json.
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { args, sections, sh, durationSec, RIG, VIDEO } from "./lib.mjs";
import { scanVideo } from "./screen-safety.mjs";

const a = args();
const edl = JSON.parse(readFileSync(join(RIG, "edl.json"), "utf8"));
const script = Object.fromEntries(sections(a.script).map((s) => [s.id, s]));
const audioDir = a.audio ?? join(VIDEO, "audio");
const out = resolve(a.out ?? join(VIDEO, "out")); // absolute: ffmpeg concat lists resolve paths relative to the list file
const work = join(out, ".work");
mkdirSync(work, { recursive: true });
const want = a.sections ? String(a.sections).split(",") : null;
const W = 1920, H = 1080, FPS = 30;
const enc = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(FPS)];

function clip(id) {
  for (const d of ["diagram", "web", "term", "sim", "cards"]) {
    const f = join(VIDEO, "clips", d, `${id}.mp4`);
    if (existsSync(f)) return f;
  }
  throw new Error(`no clip for shot ${id} (render it first)`);
}

// ---- captions: chunking + timing ----
function chunks(text) {
  const out = [];
  // sentence = up to . ! ? followed by whitespace/end ("Agent Plugins 1.0" is not a sentence end)
  for (const sent of text.replace(/\n/g, " ").match(/.+?(?:[.!?]+["”]?(?=\s|$)|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? []) {
    const words = sent.trim().split(/\s+/);
    let cur = [];
    for (const w of words) {
      const next = [...cur, w].join(" ");
      if (next.length > 84 && cur.length) { out.push(cur.join(" ")); cur = [w]; }
      else cur.push(w);
      // prefer breaking after a comma/colon once the chunk is reasonably long
      if (/[,;:]$/.test(w) && cur.join(" ").length > 48) { out.push(cur.join(" ")); cur = []; }
    }
    if (cur.length) out.push(cur.join(" "));
  }
  return out;
}

function whisperWords(mp3) {
  const h = createHash("sha1").update(readFileSync(mp3)).digest("hex").slice(0, 12);
  const cache = join(work, `whisper-${h}.json`);
  if (!existsSync(cache)) {
    const dir = join(work, `wh-${h}`);
    sh("whisper", [mp3, "--model", a.whisper ?? "small.en", "--language", "en", "--word_timestamps", "True", "--output_format", "json", "--output_dir", dir, "--fp16", "False"]);
    const j = JSON.parse(readFileSync(join(dir, mp3.split("/").pop().replace(/\.mp3$/, ".json")), "utf8"));
    writeFileSync(cache, JSON.stringify(j.segments.flatMap((s) => s.words ?? []).map((w) => ({ w: w.word.trim(), s: w.start, e: w.end }))));
    rmSync(dir, { recursive: true, force: true });
  }
  return JSON.parse(readFileSync(cache, "utf8"));
}

function timeCaptions(text, mp3, audioSec) {
  const cs = chunks(text);
  const counts = cs.map((c) => c.split(/\s+/).length);
  const total = counts.reduce((x, y) => x + y, 0);
  let words = null;
  if (!a["no-align"]) { try { words = whisperWords(mp3); } catch (e) { console.warn(`whisper failed (${e.message.slice(0, 80)}); proportional timing`); } }
  const res = [];
  let k = 0;
  for (const [i, c] of cs.entries()) {
    const i0 = k, i1 = k + counts[i] - 1;
    k += counts[i];
    let s, e;
    if (words?.length) {
      const map = (idx) => Math.min(words.length - 1, Math.round((idx * (words.length - 1)) / Math.max(1, total - 1)));
      s = words[map(i0)].s; e = words[map(i1)].e;
    } else { s = (i0 / total) * audioSec; e = ((i1 + 1) / total) * audioSec; }
    res.push({ text: c, s, e });
  }
  // continuity: no overlaps, no flicker gaps < 0.25 s, minimum 1.0 s on screen
  for (let i = 0; i < res.length; i++) {
    if (i && res[i].s < res[i - 1].e) res[i].s = res[i - 1].e;
    if (i + 1 < res.length && res[i + 1].s - res[i].e < 0.25) res[i].e = res[i + 1].s;
    if (res[i].e - res[i].s < 1) res[i].e = res[i].s + 1;
  }
  return res;
}

// ---- caption PNGs (bottom band) ----
// Chromium can die while whisper/ffmpeg hog the machine for minutes: relaunch on demand.
let browser = null, page = null;
async function capPage() {
  if (!page || page.isClosed() || !browser?.isConnected()) {
    try { await browser?.close(); } catch {}
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: W, height: 220 } });
  }
  return page;
}
async function captionPng(text, file, retry = true) {
  try { return await captionPng1(text, file); }
  catch (e) { if (!retry) throw e; page = null; return captionPng(text, file, false); }
}
async function captionPng1(text, file) {
  const esc = text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const page = await capPage();
  await page.setContent(`<!doctype html><html><body style="margin:0;width:${W}px;height:220px;display:flex;align-items:flex-end;justify-content:center;background:transparent">
    <div style="max-width:1500px;margin-bottom:34px;padding:12px 26px;border-radius:14px;background:rgba(8,10,14,.78);color:#f2f4f8;
      font:500 40px/1.3 'Inter','SF Pro Text',-apple-system,system-ui,sans-serif;text-align:center;letter-spacing:.005em">${esc}</div></body></html>`);
  await page.screenshot({ path: file, omitBackground: true });
}

const srt = [];
const timeline = [];
const parts = [];
let t0 = 0;
const fmt = (t) => { const ms = Math.round(t * 1000); const h = Math.floor(ms / 3.6e6), m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`; };

for (const sec of edl.sections.filter((s) => !want || want.includes(s.id))) {
  const sc = script[sec.id];
  const mp3 = join(audioDir, `${sec.id}.mp3`);
  if (!existsSync(mp3)) throw new Error(`no narration ${mp3} (run narrate.mjs)`);
  const audioSec = durationSec(mp3);
  const lead = sec.lead ?? edl.lead, tail = sec.tail ?? edl.tail;
  const D = +(lead + audioSec + tail).toFixed(3);
  // slots. A shot with "cue": "<words from the narration>" starts when those words are spoken
  // (whisper word timestamps); between cue anchors, "sec" and flex sharing apply as before.
  const words = a["no-align"] ? null : (() => { try { return whisperWords(mp3); } catch { return null; } })();
  const scriptWords = sc.text.split(/\s+/);
  const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
  function cueTime(cue) {
    const cw = cue.split(/\s+/).map(norm);
    const i = scriptWords.findIndex((_, k) => cw.every((c, j) => norm(scriptWords[k + j] ?? "") === c));
    if (i < 0) throw new Error(`section ${sec.id}: cue "${cue}" not found in narration`);
    if (!words?.length) return lead + (i / scriptWords.length) * audioSec;
    const k = Math.min(words.length - 1, Math.round((i * (words.length - 1)) / Math.max(1, scriptWords.length - 1)));
    return lead + words[k].s - 0.15; // cut just before the words
  }
  const starts = sec.shots.map((s, i) => (i === 0 ? 0 : s.cue ? cueTime(s.cue) : null));
  const anchors = [...starts.map((t, i) => [i, t]).filter(([, t]) => t !== null), [sec.shots.length, D]];
  let slots = new Array(sec.shots.length).fill(0);
  for (let g = 0; g + 1 < anchors.length; g++) {
    const [i0, ta] = anchors[g], [i1, tb] = anchors[g + 1];
    const group = sec.shots.slice(i0, i1);
    const span = Math.max(0.5, tb - ta);
    const fixed = group.reduce((x, s) => x + (s.sec ?? 0), 0);
    const flex = group.filter((s) => s.sec === undefined).length;
    let gs = group.map((s) => s.sec ?? Math.max(1.5, (span - fixed) / Math.max(1, flex)));
    const k = span / gs.reduce((x, y) => x + y, 0); // fit the group exactly into its span
    gs.forEach((x, j) => (slots[i0 + j] = x * k));
  }
  // cut each shot to its slot
  const segs = [];
  if (a.plan) {
    for (const [i, s] of sec.shots.entries()) {
      let have = NaN; try { have = durationSec(clip(s.id)) - (s.from ?? 0); } catch {}
      const flag = clip(s.id).includes("/cards/") ? "card (slow zoom)" : have + 0.3 < slots[i] ? `SHORT by ${(slots[i] - have).toFixed(1)} s` : "ok";
      console.log(`${sec.id} ${s.id.padEnd(5)} at ${(t0 + slots.slice(0, i).reduce((x, y) => x + y, 0)).toFixed(1).padStart(6)}  slot ${slots[i].toFixed(1).padStart(5)}  clip ${have.toFixed(1).padStart(5)}  ${flag}`);
    }
    t0 += D;
    continue;
  }
  for (const [i, s] of sec.shots.entries()) {
    const src = clip(s.id), seg = join(work, `${sec.id}-${i}-${s.id}.mp4`);
    const have = durationSec(src) - (s.from ?? 0);
    const png = src.replace(/\.mp4$/, ".png");
    if (src.includes("/cards/") && existsSync(png)) {
      // still card: a slow push-in (4K source so zoompan doesn't jitter) instead of a frozen frame
      const n = Math.ceil(slots[i] * FPS);
      sh("ffmpeg", ["-y", "-loglevel", "error", "-loop", "1", "-framerate", String(FPS), "-i", png, "-vf",
        `scale=3840:2160,zoompan=z='1+0.035*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},fade=t=in:st=0:d=0.25`,
        "-t", slots[i].toFixed(3), "-an", ...enc, seg]);
      segs.push(seg);
      timeline.push({ section: sec.id, shot: s.id, at: +(t0 + slots.slice(0, i).reduce((x, y) => x + y, 0)).toFixed(2), seconds: +slots[i].toFixed(2), clip_seconds: +slots[i].toFixed(2), kind: "card" });
      continue;
    }
    const vf = [`scale=${W}:${H}:force_original_aspect_ratio=decrease`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0b0d12`, `fps=${FPS}`];
    if (s.fit === "speed" && have > slots[i]) vf.unshift(`setpts=${(slots[i] / have).toFixed(4)}*PTS`);
    else if (have < slots[i]) vf.push(`tpad=stop_mode=clone:stop_duration=${(slots[i] - have + 0.1).toFixed(2)}`);
    sh("ffmpeg", ["-y", "-loglevel", "error", ...(s.from ? ["-ss", String(s.from)] : []), "-i", src, "-vf", vf.join(","), "-t", slots[i].toFixed(3), "-an", ...enc, seg]);
    segs.push(seg);
    if (slots[i] > have + 2) console.warn(`  ${sec.id} ${s.id}: slot ${slots[i].toFixed(1)} s > clip ${have.toFixed(1)} s — last frame held ${(slots[i] - have).toFixed(1)} s (record a longer take)`);
    timeline.push({ section: sec.id, shot: s.id, at: +(t0 + slots.slice(0, i).reduce((x, y) => x + y, 0)).toFixed(2), seconds: +slots[i].toFixed(2), clip_seconds: +have.toFixed(2) });
  }
  const list = join(work, `${sec.id}.txt`);
  writeFileSync(list, segs.map((f) => `file '${f}'`).join("\n"));
  const video = join(work, `${sec.id}.video.mp4`);
  sh("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", video]);
  // captions
  const caps = timeCaptions(sc.text, mp3, audioSec).map((c) => ({ ...c, s: c.s + lead, e: c.e + lead }));
  const inputs = [], chain = [];
  let last = "[0:v]";
  for (const [i, c] of caps.entries()) {
    const png = join(work, `${sec.id}-cap${i}.png`);
    await captionPng(c.text, png);
    inputs.push("-i", png);
    const lbl = `[v${i}]`;
    chain.push(`${last}[${i + 1}:v]overlay=0:${H - 220}:enable='between(t,${c.s.toFixed(3)},${c.e.toFixed(3)})'${lbl}`);
    last = lbl;
    srt.push({ s: t0 + c.s, e: t0 + c.e, text: c.text });
  }
  const audioIdx = caps.length + 1;
  const final = join(work, `${sec.id}.mp4`);
  sh("ffmpeg", ["-y", "-loglevel", "error", "-i", video, ...inputs, "-i", mp3, "-filter_complex",
    `${chain.join(";")}${chain.length ? ";" : ""}[${audioIdx}:a]adelay=${Math.round(lead * 1000)}:all=1,apad[a]`,
    "-map", chain.length ? last : "0:v", "-map", "[a]", "-t", D.toFixed(3), ...enc, "-c:a", "aac", "-b:a", "160k", "-ar", "48000", final]);
  parts.push(final);
  console.log(`section ${sec.id} ${sc.title}: ${D.toFixed(1)} s (narration ${audioSec.toFixed(1)} s), ${sec.shots.length} shots, ${caps.length} captions`);
  t0 += D;
}
await browser?.close();
if (a.plan) { console.log(`total ${t0.toFixed(1)} s`); process.exit(0); }

const list = join(work, "all.txt");
writeFileSync(list, parts.map((f) => `file '${f}'`).join("\n"));
mkdirSync(out, { recursive: true });
const mp4 = join(out, "weft-demo.mp4");
sh("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", mp4]);
writeFileSync(join(out, "captions.srt"), srt.map((c, i) => `${i + 1}\n${fmt(c.s)} --> ${fmt(c.e)}\n${c.text}\n`).join("\n"));
writeFileSync(join(out, "timeline.json"), JSON.stringify({ total: +t0.toFixed(2), shots: timeline }, null, 2) + "\n");
console.log(`-> ${mp4} (${durationSec(mp4).toFixed(1)} s), captions.srt (${srt.length} cues)`);
if (!a["no-check"]) {
  const r = scanVideo(mp4, Number(a.every ?? 2));
  console.log(`screen-safety: ${r.frames} frames OCR'd, ${r.hits.length} hit(s)`);
  if (r.hits.length) { console.error(JSON.stringify(r.hits.slice(0, 5))); process.exit(1); }
}
