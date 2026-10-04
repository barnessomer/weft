// Shared helpers for the video rig. Node >= 22, no dependencies.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RIG = dirname(fileURLToPath(import.meta.url));
export const VIDEO = resolve(RIG, "..");
export const REPO = resolve(VIDEO, "../..");

/** Sections of script.md: [{id, title, text}] in order. */
export function sections(scriptPath = join(VIDEO, "script.md")) {
  const s = readFileSync(scriptPath, "utf8");
  const out = [];
  for (const m of s.matchAll(/^## (\d\d) · ([^\n(]+?)\s*(?:\([^\n]*)?\n[\s\S]*?```narration\n([\s\S]*?)```/gm)) {
    out.push({ id: m[1], title: m[2].trim(), text: m[3].trim().replace(/\s*\n\s*/g, "\n") });
  }
  if (!out.length) throw new Error(`no narration sections in ${scriptPath}`);
  return out;
}

export function args(argv = process.argv.slice(2)) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const [k, v] = t.slice(2).split("=", 2);
      if (v !== undefined) a[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) a[k] = argv[++i];
      else a[k] = true;
    } else a._.push(t);
  }
  return a;
}

/** Read KEY from the environment or ~/.hermes/.env without ever printing it. */
export function secretEnv(name) {
  if (process.env[name]) return process.env[name];
  const f = join(homedir(), ".hermes/.env");
  if (existsSync(f)) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`));
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

/** Short-lived Cloudflare OAuth token from wrangler (never printed). */
export function cloudflareToken() {
  const env = { ...process.env, PATH: `/opt/homebrew/opt/node@24/bin:${process.env.PATH}` };
  delete env.CLOUDFLARE_API_TOKEN;
  const out = execFileSync("npx", ["wrangler", "auth", "token"], { cwd: REPO, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const tok = out.trim().split("\n").pop().trim();
  if (!tok || tok.includes(" ")) throw new Error("wrangler auth token: no token (run `wrangler login`)");
  return tok;
}
export const CF_ACCOUNT = "2d659dee148763a8d64c80135da7165d";

export function sh(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, ...opts });
}

export function durationSec(file) {
  return Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim());
}
