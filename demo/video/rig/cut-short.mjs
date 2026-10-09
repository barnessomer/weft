#!/usr/bin/env node
// Cut the meeting-length version of the demo video from the full cut, per ../short.json.
//
//   node demo/video/rig/cut-short.mjs [--src demo/video/weft-demo.mp4] [--out demo/video/rig/out]
//
// The full cut already carries burned-in captions (assemble.mjs), so segments are cut from it
// directly; in/out points sit in caption gaps. Each segment gets 60 ms audio fades so cuts
// do not click; the video is re-encoded once (H.264 CRF 20, AAC 160k, faststart).
// Writes <out>/weft-demo-short.mp4 and <out>/weft-demo-short.en.srt (captions retimed from
// ../captions.srt, for players that want a sidecar too).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const video = resolve(here, "..");
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const edl = JSON.parse(readFileSync(join(video, "short.json"), "utf8"));
const outDir = resolve(opt("out", join(here, "out")));
mkdirSync(outDir, { recursive: true });

let src = resolve(opt("src", join(video, "weft-demo.mp4")));
if (!existsSync(src)) {
  src = join(outDir, "weft-demo.mp4");
  if (!existsSync(src)) execFileSync("curl", ["-fsSL", "-o", src, edl.source], { stdio: "inherit" });
}

// One re-encoded intermediate per segment (one filter graph with N trims of the same input
// silently drops material), then a stream-copy concat of identical encodes.
const segs = edl.segments;
const fade = 0.06;
const tmp = join(outDir, ".short-parts");
mkdirSync(tmp, { recursive: true });
const list = [];
segs.forEach((s, i) => {
  const d = s.out - s.in;
  const part = join(tmp, `part-${i}.mp4`);
  const vf = s.mask ? ["-vf", `drawbox=x=${s.mask.box[0]}:y=${s.mask.box[1]}:w=${s.mask.box[2]}:h=${s.mask.box[3]}:color=${s.mask.color}@1:t=fill:enable='gte(t,${(s.mask.from - s.in).toFixed(3)})'`] : [];
  execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", String(s.in), "-i", src, "-t", d.toFixed(3), ...vf,
    "-af", `afade=t=in:st=0:d=${fade},afade=t=out:st=${(d - fade).toFixed(3)}:d=${fade}`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", part], { stdio: "inherit" });
  list.push(`file '${part}'`);
});
writeFileSync(join(tmp, "list.txt"), list.join("\n") + "\n");
const out = join(outDir, edl.output);
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", join(tmp, "list.txt"), "-c", "copy", "-movflags", "+faststart", out], { stdio: "inherit" });

// Sidecar captions: keep cues inside a segment, shift them to the short's timeline.
const ts = (t) => {
  const [h, m, r] = t.split(":");
  const [s, ms] = r.split(",");
  return +h * 3600 + +m * 60 + +s + +ms / 1000;
};
const fmt = (x) => {
  const ms = Math.round(x * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
const cues = readFileSync(join(video, "captions.srt"), "utf8").trim().split(/\n\s*\n/).map((b) => {
  const l = b.split("\n");
  const [a, z] = l[1].split(" --> ");
  return { a: ts(a), z: ts(z), text: l.slice(2).join("\n") };
});
let offset = 0;
const srt = [];
for (const s of segs) {
  for (const c of cues) if (c.a >= s.in - 0.01 && c.a < s.out) srt.push(`${srt.length + 1}\n${fmt(c.a - s.in + offset)} --> ${fmt(Math.min(c.z, s.out) - s.in + offset)}\n${c.text}\n`);
  offset += s.out - s.in;
}
writeFileSync(join(outDir, "weft-demo-short.en.srt"), srt.join("\n"));
const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", out], { encoding: "utf8" }).trim();
console.log(`${out}: ${Number(dur).toFixed(2)} s (planned ${offset.toFixed(2)} s), ${srt.length} caption cues`);
