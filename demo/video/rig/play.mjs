#!/usr/bin/env node
// Terminal shot player: prints a transcript excerpt (from evidence files) with pacing and
// colour, for VHS to film. Every line passes through screen-safety redact() first.
//
//   node demo/video/rig/play.mjs <shot-id> [--file rig/shots/term.json] [--fast] [--estimate]
//
// Source kinds per block (shots/term.json):
//   {"banner": "text"}                               dim header line (what this is, which run)
//   {"prompt": "text"}                               typed as if at a shell prompt (no execution)
//   {"text": "literal"}                              printed as-is
//   {"file": "path", "from": "regex", "to": "regex", "max": n}   line range of a text file
//   {"jsonl": "path", "match": {"k": "v"}, "contains": "s", "field": "f", "nth": 0, "max": n}
//   {"codexMessages": "path", "skip": 0, "take": 2, "as": "codex"}   agent messages from codex --json
//   {"json": "path", "expr": "return d.steps.map(…)"}   lines computed from a JSON evidence file
//   {"pause": ms}
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { args, RIG, REPO } from "./lib.mjs";
import { redact } from "./screen-safety.mjs";

const a = args();
const id = a._[0];
const spec = JSON.parse(readFileSync(a.file ?? join(RIG, "shots/term.json"), "utf8"));
const shot = spec.shots.find((s) => s.id === id);
if (!shot) throw new Error(`no term shot ${id}`);
const fast = !!a.fast || !!a.estimate;
let planned = 0; // --estimate: print the shot's scripted duration (ms) instead of playing it
const sleep = (ms) => { planned += ms; return new Promise((r) => setTimeout(r, fast ? 0 : ms)); };
if (a.estimate) process.stdout.write = () => true;
const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m" };

function colour(line) {
  if (/^\s*\[weft error\]/.test(line) || /\bBLOCKED\b|blocked:/.test(line)) return C.red + line + C.reset;
  if (/^\s*\[weft warning\]/.test(line)) return C.yellow + line + C.reset;
  if (/^\s*\[weft negotiation\]/.test(line)) return C.magenta + line + C.reset;
  if (/^\s*\[weft\]/.test(line)) return C.cyan + line + C.reset;
  if (/^\s*\+(?!\+\+)/.test(line) || /^✔|exit 0\b/.test(line)) return C.green + line + C.reset;
  if (/^\s*-(?!--)/.test(line) || /exit [1-9]\b|error TS/.test(line)) return C.red + line + C.reset;
  if (/^\s*@@/.test(line) || /^\s*↳/.test(line)) return C.blue + line + C.reset;
  return line;
}

function wrap(line, width) {
  if (line.length <= width) return [line];
  const out = [];
  const indent = line.match(/^\s*/)[0] + "  ";
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut < width * 0.5) cut = width;
    out.push(rest.slice(0, cut));
    rest = indent + rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

function lines(b) {
  const p = (f) => join(REPO, f);
  if (b.text !== undefined) return b.text.split("\n");
  if (b.file) {
    const all = readFileSync(p(b.file), "utf8").split("\n");
    let i = b.from ? all.findIndex((l) => new RegExp(b.from).test(l)) : 0;
    if (i < 0) throw new Error(`${b.file}: no line matches ${b.from}`);
    let j = b.to ? all.findIndex((l, k) => k > i && new RegExp(b.to).test(l)) : all.length - 1;
    if (j < 0) j = all.length - 1;
    return all.slice(i, j + 1).slice(0, b.max ?? 1e9);
  }
  if (b.jsonl) {
    const recs = readFileSync(p(b.jsonl), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const hits = recs.filter((r) => Object.entries(b.match ?? {}).every(([k, v]) => r[k] === v) && (!b.contains || String(r[b.field] ?? "").includes(b.contains)));
    const r = hits[b.nth ?? 0];
    if (!r) throw new Error(`${b.jsonl}: no record for ${JSON.stringify(b.match)} ${b.contains ?? ""}`);
    return String(r[b.field]).split("\n").slice(0, b.max ?? 1e9);
  }
  if (b.json) {
    // expr: body of a function (d) => string[] over the parsed JSON file (our own evidence files).
    return new Function("d", b.expr)(JSON.parse(readFileSync(p(b.json), "utf8")));
  }
  if (b.codexMessages) {
    const msgs = readFileSync(p(b.codexMessages), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((d) => d.type === "item.completed" && d.item?.type === "agent_message").map((d) => d.item.text);
    return msgs.slice(b.skip ?? 0, (b.skip ?? 0) + (b.take ?? 1)).flatMap((m) => `${b.as ?? "codex"} › ${m}`.split("\n"));
  }
  throw new Error(`unknown block ${JSON.stringify(b)}`);
}

const width = shot.cols ?? spec.cols ?? 110;
process.stdout.write("\x1b[2J\x1b[H");
for (const b of shot.blocks) {
  if (b.pause) { await sleep(b.pause); continue; }
  if (b.banner) { console.log(C.dim + "── " + redact(b.banner) + " " + "─".repeat(Math.max(0, width - b.banner.length - 4)) + C.reset); continue; }
  if (b.prompt) {
    process.stdout.write(C.green + "$ " + C.reset);
    for (const ch of redact(b.prompt)) { process.stdout.write(ch); await sleep(35); }
    process.stdout.write("\n");
    await sleep(400);
    continue;
  }
  for (const raw of lines(b)) {
    for (const l of wrap(redact(raw), width)) {
      console.log(colour(l));
      await sleep(b.lineMs ?? shot.lineMs ?? 90);
    }
  }
  await sleep(b.after ?? 300);
}
await sleep(shot.hold ?? 2500);
if (a.estimate) console.error(String(planned));
