#!/usr/bin/env node
// Render one-pager.md to one-pager.pdf (US Letter, one page) with headless Chrome.
//
//   node docs/standardization/make-pdf.mjs            # from the repo root
//
// Needs `npx` (fetches `marked` once) and Chrome/Chromium (CHROME=/path overrides the default).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(here, "one-pager.md"), "utf8");
const body = execFileSync("npx", ["-y", "marked@14", "--gfm"], { input: md, encoding: "utf8" });
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Agent Hooks Core — one-pager</title><style>
@page { size: Letter; margin: 0.5in 0.6in; }
body { font: 9.6pt/1.36 -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; color: #16181d; }
h1 { font-size: 15.5pt; margin: 0 0 2pt; letter-spacing: -0.2pt; }
h1 + p { color: #555; margin-top: 0; }
p { margin: 4.5pt 0; }
ol, ul { margin: 3pt 0 3pt 15pt; padding: 0; }
li { margin: 1.2pt 0; }
code { font: 8.6pt ui-monospace, Menlo, monospace; background: #f1f2f5; padding: 0 2pt; border-radius: 2pt; }
a { color: #1f4fd1; text-decoration: none; }
strong { color: #000; }
p:last-child { font-size: 8.4pt; color: #444; border-top: 0.5pt solid #ccc; padding-top: 4pt; margin-top: 7pt; }
</style></head><body>${body}</body></html>`;
const dir = mkdtempSync(join(tmpdir(), "one-pager-"));
writeFileSync(join(dir, "one-pager.html"), html);
const chrome = process.env.CHROME ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
if (!chrome) throw new Error("no Chrome found; set CHROME=/path/to/chrome");
const out = join(here, "one-pager.pdf");
execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${out}`, `file://${join(dir, "one-pager.html")}`], { stdio: "ignore" });
const pages = (readFileSync(out, "latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
console.log(`${out}: ${pages} page(s)`);
if (pages !== 1) process.exitCode = 1;
