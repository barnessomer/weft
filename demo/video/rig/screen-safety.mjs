#!/usr/bin/env node
// Screen safety for the video: nothing on screen may show a *.workers.dev URL, a customer's
// name, a personal chat, a token or a key.
//
//   node demo/video/rig/screen-safety.mjs sources <file>...   grep text sources (transcripts, logs)
//   node demo/video/rig/screen-safety.mjs video <clip.mp4>... [--every 1]  OCR 1 frame/s (Apple Vision)
//
// Exit 1 on any hit. record-web.mjs also imports FORBIDDEN and probes the live DOM per step.
// Add customer names / private strings to ~/.config/weft/video-forbidden.txt (one regex per
// line, kept outside the repo so the names themselves are never committed).
import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { args, sh, RIG } from "./lib.mjs";

export const FORBIDDEN = [
  /[a-z0-9-]+\.workers\.dev/i,                // any workers.dev hostname (the account subdomain is a customer's name)
  /workers\s*\.\s*dev/i,                      // OCR may split it
  /\bwfp?_[A-Za-z0-9_-]{20,}/,                // WCP tokens (wt_/wfp_ style prefixes)
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{20,}/,          // provider API keys
  /\bsk-or-v1-[a-f0-9]{20,}/i,                // OpenRouter
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,           // auth headers
  /CF-Access-Client-Secret/i,
  /\b[0-9]{12,}@(lid|s\.whatsapp\.net)\b/,    // WhatsApp ids (personal chats)
  /\bweb-preview-key\b|preview-admin-token|observer-all-token/, // secret file names next to values
];
const extra = join(homedir(), ".config/weft/video-forbidden.txt");
if (existsSync(extra)) {
  for (const l of readFileSync(extra, "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"))) {
    FORBIDDEN.push(new RegExp(l, "i"));
  }
}

export function scanText(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const re of FORBIDDEN) if (re.test(line)) hits.push({ line: i + 1, pattern: re.source, text: line.slice(0, 160) });
  });
  return hits;
}

/** Redact forbidden matches (used by the terminal renderer before anything is typed on screen). */
export function redact(text) {
  let t = text;
  // Cosmetic: long local paths (they also leak the OS user name).
  t = t.replace(/[^\s`'"]*\/\.weft\/bin\/weft\b/g, "weft");
  t = t.replace(/\/Users\/[^/\s]+\/\.hermes\/cache\/scratch\/[^/\s]+\//g, "");
  t = t.replace(/\/Users\/[^/\s]+\//g, "~/");
  t = t.replace(/https?:\/\/([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev/gi, (_, w) => `https://${w}.elier.ai`);
  for (const re of FORBIDDEN) t = t.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), "[redacted]");
  return t;
}

let ocrBin;
function ocr(pngs) {
  if (!ocrBin) {
    ocrBin = join(process.env.TMPDIR ?? tmpdir(), "weft-video-ocr");
    if (!existsSync(ocrBin)) sh("swiftc", ["-O", "-o", ocrBin, join(RIG, "ocr.swift")]);
  }
  return sh(ocrBin, pngs);
}

export function scanVideo(file, every = 1) {
  const dir = join(process.env.TMPDIR ?? tmpdir(), `weft-ss-${process.pid}-${basename(file)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  sh("ffmpeg", ["-loglevel", "error", "-i", file, "-vf", `fps=1/${every}`, join(dir, "f%05d.png")]);
  const frames = readdirSync(dir).filter((f) => f.endsWith(".png")).map((f) => join(dir, f));
  const hits = [];
  let lines = 0;
  for (let i = 0; i < frames.length; i += 40) {
    for (const row of ocr(frames.slice(i, i + 40)).split("\n").filter(Boolean)) {
      lines++;
      const [f, text] = row.split("\t");
      for (const re of FORBIDDEN) if (re.test(text)) hits.push({ t: (Number(basename(f).slice(1, 6)) - 1) * every, pattern: re.source, text });
    }
  }
  rmSync(dir, { recursive: true, force: true });
  return { frames: frames.length, ocr_lines: lines, hits };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = args();
  const [mode, ...files] = a._;
  let bad = 0;
  for (const f of files) {
    if (mode === "sources") {
      const hits = scanText(readFileSync(f, "utf8"));
      bad += hits.length;
      console.log(`${hits.length ? "FAIL" : "ok  "} ${f}${hits.length ? `: ${hits.length} hit(s)` : ""}`);
      for (const h of hits.slice(0, 5)) console.log(`     ${h.line}: /${h.pattern}/`);
    } else if (mode === "video") {
      const r = scanVideo(f, Number(a.every ?? 1));
      bad += r.hits.length;
      console.log(`${r.hits.length ? "FAIL" : "ok  "} ${f}: ${r.frames} frames, ${r.ocr_lines} OCR lines, ${r.hits.length} hit(s)`);
      for (const h of r.hits.slice(0, 5)) console.log(`     t=${h.t}s /${h.pattern}/`);
    } else {
      console.error("usage: screen-safety.mjs sources|video <file>...");
      process.exit(2);
    }
  }
  process.exit(bad ? 1 : 0);
}
