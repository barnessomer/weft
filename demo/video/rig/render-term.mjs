#!/usr/bin/env node
// Film terminal shots with VHS (charmbracelet/vhs): replayed transcripts (play.mjs) and live
// commands ("exec"). 1920x1080, H.264 MP4, then OCR screen-safety check on the result.
//
//   node demo/video/rig/render-term.mjs [--shots S03b,S03d] [--out demo/video/clips/term] [--no-check]
//
// Needs: brew install vhs (pulls ttyd + ffmpeg).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { args, sh, RIG, VIDEO, REPO, durationSec } from "./lib.mjs";
import { scanVideo } from "./screen-safety.mjs";

const a = args();
const spec = JSON.parse(readFileSync(join(RIG, "shots/term.json"), "utf8"));
const want = a.shots ? String(a.shots).split(",") : null;
const out = a.out ?? join(VIDEO, "clips/term");
const tapes = join(out, ".tapes");
mkdirSync(tapes, { recursive: true });
const NODE = "/opt/homebrew/opt/node@24/bin";

function mainCheckout() {
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
  return common.replace(/\/\.git$/, "");
}

let failed = 0;
for (const shot of spec.shots.filter((s) => !want || want.includes(s.id))) {
  const mp4 = join(out, `${shot.id}.mp4`);
  const cmd = shot.exec ?? `node demo/video/rig/play.mjs ${shot.id}`;
  // "cwd": "main-checkout" runs a live command from the repo's main checkout (not a worktree path).
  const cwd = shot.cwd === "main-checkout" ? mainCheckout() : REPO;
  const tape = [
    `Output "${mp4}"`,
    `Set Shell "bash"`,
    `Set Width 1920`,
    `Set Height 1080`,
    `Set FontSize ${shot.fontSize ?? 26}`,
    `Set FontFamily "JetBrains Mono, SF Mono, Menlo"`,
    `Set Padding 48`,
    `Set Margin 0`,
    `Set Framerate 30`,
    `Set Theme "${shot.theme ?? "Catppuccin Mocha"}"`,
    `Set TypingSpeed 35ms`,
    `Set WaitTimeout 180s`,
    `Set WaitPattern /weft \\$\\s*$/`,
    `Hide`,
    `Type "cd '${shot.exec ? cwd : REPO}' && export PATH=${NODE}:$PATH && export PS1='weft \\$ ' && clear"`,
    `Enter`,
    `Wait`,
    shot.exec ? `Show` : `Type "${cmd.replace(/"/g, '\\"')}"`,
    ...(shot.exec
      ? [`Type "${cmd.replace(/"/g, '\\"')}"`, `Sleep 400ms`, `Enter`]
      : [`Enter`, `Sleep 150ms`, `Show`]),
    `Wait`,
    `Hide`,
  ];
  // VHS's Wait returned early in testing, so every shot gets an explicit duration: the player's
  // scripted length (play.mjs --estimate), or for live commands one timed run beforehand.
  let ms;
  if (shot.exec) {
    const t0 = Date.now();
    sh("bash", ["-lc", `export PATH=${NODE}:$PATH; ${shot.exec}`], { cwd });
    ms = Date.now() - t0 + 1500 + (shot.hold ?? 3000);
  } else {
    const r = spawnSync(process.execPath, [join(RIG, "play.mjs"), shot.id, "--estimate"], { cwd: REPO, encoding: "utf8" });
    // stop filming just before the player exits, so the shell prompt never appears on screen
    ms = Number(r.stderr.trim().split("\n").pop()) - 200;
  }
  const end = tape.indexOf("Wait", tape.indexOf("Show"));
  tape.splice(end, 1, `Sleep ${ms}ms`);
  const tf = join(tapes, `${shot.id}.tape`);
  writeFileSync(tf, tape.join("\n") + "\n");
  try {
    sh("vhs", [tf], { cwd: REPO });
    // The final prompt line is hidden by Hide; trim a trailing still if the shot asks for it.
    const sec = durationSec(mp4);
    let check = { hits: [], frames: 0 };
    if (!a["no-check"]) check = scanVideo(mp4, 1);
    if (check.hits.length) {
      failed++;
      console.error(`${shot.id}: SCREEN-SAFETY FAIL ${JSON.stringify(check.hits.slice(0, 3))}`);
    } else console.log(`${shot.id}: ${sec.toFixed(1)} s -> ${mp4} (OCR ${check.frames} frames clean)`);
  } catch (e) {
    failed++;
    console.error(`${shot.id}: FAILED ${String(e.stderr ?? e.message).slice(0, 400)}`);
  }
}
process.exit(failed ? 1 : 0);
