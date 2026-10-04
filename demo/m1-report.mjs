#!/usr/bin/env node
// Aggregate demo/evidence/m1/run-*/summary.json into the tables of demo/evidence/m1-report.md.
//   node demo/m1-report.mjs           print the generated section
//   node demo/m1-report.mjs --write   replace it between the markers in m1-report.md
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(REPO, "demo/evidence/m1");
const REPORT = join(REPO, "demo/evidence/m1-report.md");
const runs = readdirSync(DIR)
  .filter((d) => d.startsWith("run-") && existsSync(join(DIR, d, "summary.json")))
  .map((d) => ({ dir: d, ...JSON.parse(readFileSync(join(DIR, d, "summary.json"), "utf8")) }))
  .sort((a, b) => a.run - b.run);

const valid = runs.filter((r) => !r.aborted);
const passed = valid.filter((r) => r.pass);
const yn = (b) => (b ? "yes" : "**no**");
const pct = (xs, p) => {
  if (!xs.length) return "–";
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const lines = [];
lines.push(`**Pass rate: ${passed.length}/${valid.length}** valid runs (${runs.length - valid.length} aborted by the Codex model backend, not counted).`, "");
lines.push("| run | coordinator repo | Codex backend | A sig. event | B denied (check) | B accepted after | A running at B2 | diag → B | B rerouted | both finished | merge clean | tsc+tests on merge | result |");
lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of runs) {
  const c = r.criteria ?? {};
  lines.push(
    `| [${r.run}](m1/${r.dir}/) | \`${r.repo}\` | ${(r.harnesses?.b ?? "").replace(/^codex exec \(|\)$/g, "")} | #${r.a_signature_seq ?? "–"} | ${r.b_rejected_seq ? `#${r.b_rejected_seq}` : "–"} | ${(r.b_accepted_after ?? []).map((s) => `#${s}`).join(", ") || "–"} | ${r.a_running_when_b2_started ? "yes" : "no"} | ${yn(c.b_got_edit_time_diagnostic_from_a)} | ${yn(c.b_changed_approach)} | ${yn(c.both_finished)} | ${yn(c.merged_cleanly)} | ${yn(c.tests_green)} | ${r.aborted ? `aborted (${r.aborted.replace(/\|/g, "/").slice(0, 90)}…)` : r.pass ? "**PASS**" : "**FAIL**"} |`,
  );
}

// hook round-trip latency, valid runs, both adapters
const hooks = [];
for (const r of valid) {
  for (const who of ["a", "b"]) {
    const p = join(DIR, r.dir, `${who}-hooks.jsonl`);
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, "utf8").split("\n").filter(Boolean)) hooks.push({ who, ...JSON.parse(l) });
  }
}
const group = (h) => {
  const harness = h.who === "a" ? "Claude Code" : "Codex";
  // ":edit" = the hook ran a pre-edit check or a post-edit commit (submit); Codex reports an
  // apply_patch sent through the shell as Bash, so classify by what the adapter did.
  const tool = h.tool ? (h.calls?.some((c) => c.op === "submit") ? ":edit" : h.calls?.length ? `:${h.tool} (drain)` : ":other (no coordinator call)") : "";
  return `${harness} ${h.event}${tool}`;
};
const by = new Map();
for (const h of hooks) {
  const k = group(h);
  if (!by.has(k)) by.set(k, []);
  by.get(k).push(h);
}
lines.push("", "Hook round-trip (whole hook process: node start → JSON on stdout; coordinator = each HTTP call to the preview gateway):", "");
lines.push("| hook | n | total p50 ms | total p95 ms | total max ms | coordinator calls | call p50 ms | call p95 ms |");
lines.push("|---|---|---|---|---|---|---|---|");
for (const [k, hs] of [...by.entries()].sort()) {
  const total = hs.map((h) => h.total_ms);
  const calls = hs.flatMap((h) => (h.calls ?? []).map((c) => c.ms));
  lines.push(`| ${k} | ${hs.length} | ${pct(total, 50)} | ${pct(total, 95)} | ${Math.max(...total)} | ${calls.length} | ${pct(calls, 50)} | ${pct(calls, 95)} |`);
}
const coordinated = hooks.filter((h) => h.calls?.length);
const allCalls = hooks.flatMap((h) => (h.calls ?? []).map((c) => c.ms));
const edits = hooks.filter((h) => h.event === "PreToolUse" && h.calls?.some((c) => c.op === "submit"));
lines.push(
  "",
  `All coordinated hooks: n=${coordinated.length}, total p50 ${pct(coordinated.map((h) => h.total_ms), 50)} ms / p95 ${pct(coordinated.map((h) => h.total_ms), 95)} ms; ` +
    `pre-edit checks (the edit-time squiggle path): n=${edits.length}, p50 ${pct(edits.map((h) => h.total_ms), 50)} ms / max ${edits.length ? Math.max(...edits.map((h) => h.total_ms)) : "–"} ms; ` +
    `single coordinator call p50 ${pct(allCalls, 50)} ms / p95 ${pct(allCalls, 95)} ms (n=${allCalls.length}).`,
);

// token overhead
lines.push("", "Token overhead of injected Weft text (chars/4 estimate; model totals are the harness-reported tokens for the whole run, cached input included):", "");
lines.push("| run | A injected (≈tok) | B injected (≈tok) | of which B's deny (≈tok) | A model tokens | B model tokens | B overhead vs B input |");
lines.push("|---|---|---|---|---|---|---|");
for (const r of valid) {
  const i = r.injected ?? {};
  const t = r.model_tokens ?? {};
  lines.push(`| ${r.run} | ${i.a_weft_chars} (${i.est_tokens?.a}) | ${i.b_weft_chars} (${i.est_tokens?.b}) | ${i.b_deny_chars} (${i.est_tokens?.b_deny}) | ${t.a} | ${t.b} | ${t.b ? ((100 * (i.est_tokens?.b ?? 0)) / t.b).toFixed(2) : "–"} % |`);
}
const section = lines.join("\n");
if (process.argv.includes("--write")) {
  const text = readFileSync(REPORT, "utf8");
  const start = "<!-- m1-generated:start -->";
  const end = "<!-- m1-generated:end -->";
  writeFileSync(REPORT, text.replace(new RegExp(`${start}[\\s\\S]*${end}`), `${start}\n${section}\n${end}`));
  console.log(`updated ${REPORT}`);
} else console.log(section);
