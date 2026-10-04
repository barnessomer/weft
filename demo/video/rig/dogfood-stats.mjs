#!/usr/bin/env node
// "Weft was built under Weft": numbers for script section 09, read live from the `weft` repo's
// own WCP log (observer API). Prints JSON; --sentence prints the narration sentence.
//
//   node demo/video/rig/dogfood-stats.mjs [--repo weft] [--sentence] [--write demo/video/dogfood-stats.json]
//
// Token: ~/.config/weft/observer-all-token (observe, repos *). Never printed.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { args } from "./lib.mjs";

const a = args();
const repo = a.repo ?? "weft";
const base = a.gateway ?? "https://weft-gateway-preview.elier.ai";
const tok = readFileSync(join(homedir(), ".config/weft/observer-all-token"), "utf8").trim();
const recs = [];
let after = 0;
for (;;) {
  const r = await fetch(`${base}/v1/repos/${repo}/events?after=${after}&limit=500`, { headers: { authorization: `Bearer ${tok}`, "WCP-Version": "0.1" } });
  if (!r.ok) throw new Error(`events: HTTP ${r.status}`);
  const d = await r.json();
  const ev = d.events ?? [];
  recs.push(...ev);
  if (!ev.length || !d.has_more) break;
  after = d.next_after ?? ev[ev.length - 1].seq;
}
const count = (f) => recs.filter(f).length;
const uniq = (f) => new Set(recs.map(f).filter(Boolean)).size;
const diags = recs.flatMap((r) => r.diagnostics ?? []);
const first = recs[0]?.ts, last = recs[recs.length - 1]?.ts;
const hours = first ? (Date.parse(last) - Date.parse(first)) / 3.6e6 : 0;
const stats = {
  repo, as_of: last, first_event: first, hours: +hours.toFixed(1),
  records: recs.length,
  edits: count((r) => r.kind === "edit"),
  checkpoints: count((r) => r.kind === "checkpoint"),
  lands: count((r) => r.kind === "land"),
  reverts: count((r) => r.kind === "revert"),
  rejected: count((r) => r.status === "rejected"),
  agents: uniq((r) => (r.actor?.type === "agent" ? r.agent : null)),
  tasks: uniq((r) => r.task),
  files: new Set(recs.flatMap((r) => r.files ?? [])).size,
  records_with_diagnostics: count((r) => (r.diagnostics ?? []).length > 0),
  diagnostics: diags.length,
  by_code: diags.reduce((m, g) => ((m[`${g.severity}:${g.code}`] = (m[`${g.severity}:${g.code}`] ?? 0) + 1), m), {}),
};
const waits = stats.by_code["warning:claim_wait"] ?? 0;
const words = (n) => (n <= 20 ? ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen","twenty"][n] : String(n));
stats.sentence = `In ${words(Math.round(hours))} hours, its own log recorded ${stats.records} events: ${stats.edits} edits from ${words(stats.agents)} agent profiles across ${words(stats.tasks)} tasks, ${stats.checkpoints} checkpoints and ${stats.lands} landings, with ${waits} warnings that told one agent to wait for another.`;
if (a.write) writeFileSync(a.write, JSON.stringify(stats, null, 2) + "\n");
console.log(a.sentence ? stats.sentence : JSON.stringify(stats, null, 2));
