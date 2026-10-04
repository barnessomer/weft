#!/usr/bin/env node
// Live status of an M2 run's tasks on the preview gateway: revisions + evidence per candidate.
//   node demo/m2-status.mjs <task-prefix, e.g. m2-mutrwkwi>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GW = (process.env.WEFT_URL ?? "https://weft-gateway-preview.elier.ai").replace(/\/+$/, "");
const SYS = readFileSync(join(homedir(), ".config/weft/preview-workflows-system-token"), "utf8").trim();
const prefix = process.argv[2] ?? "m2-";
const get = async (p) => (await fetch(GW + p, { headers: { authorization: `Bearer ${SYS}`, "wcp-version": "0.1" } })).json();
const { tasks } = await get("/v1/repos/weft-demo/tasks");
for (const t of tasks.filter((x) => x.task.startsWith(prefix))) {
  console.log(`${t.task} ${t.status ?? ""} ${t.title ?? ""}`);
  for (const c of t.candidates) {
    const ch = await get(`/v1/repos/weft-demo/changes/${c.change}`);
    const revs = (ch.revisions ?? []).map((r) => `${r.sha?.slice(0, 7)}:${r.status}${r.layer ? "/" + r.layer : ""}`).join(",");
    const ev = (ch.evidence ?? []).map((e) => `${e.kind}:${e.status}`).join(" ");
    console.log(`  ${c.agent.padEnd(12)} ${(ch.change?.status ?? c.status ?? "").padEnd(9)} ${revs} | ${ev}`);
  }
}
