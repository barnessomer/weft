#!/usr/bin/env node
// Record the Hérmes iOS "Changes" feed (Weft observer + human API) in the iOS Simulator.
//
//   node demo/video/rig/record-sim.mjs [--shots S08a,S08b] [--app path/Hermes.app] [--build]
//        [--device "Weft Video iPhone 17 Pro"] [--out demo/video/clips/sim]
//
// - Uses a DEDICATED simulator (created on first use) so other sessions' simulators and app
//   builds are never touched. --build builds the committed `wt/weft-feed` branch of
//   ~/code/hermes-ios from a clean `git archive` export (never the working tree, which may hold
//   another session's uncommitted edits) into $TMPDIR/weft-video-ios.
// - Gateway URL + token are passed as launch arguments (-weft.url / -weft.token, debug builds
//   only): never typed on screen, never in a URL. Token file: ~/.config/weft/web-preview-token.json
//   (observe+human, repos *) for shots with human actions, else ~/.config/weft/observer-all-token.
// - `-hermes.url http://127.0.0.1:1` skips the chat connection, so no personal chats can appear.
// - Status bar is overridden to 9:41 / full battery.
// - Each shot: launch with its args, `simctl io recordVideo --codec h264`, stop after `seconds`,
//   then compose the portrait recording onto a 1920x1080 stage (phone centred, scaled to 1000 px
//   tall) → <out>/<id>.mp4, and OCR-check it (screen-safety).
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { args, sh, RIG, VIDEO, durationSec } from "./lib.mjs";
import { scanVideo } from "./screen-safety.mjs";

const a = args();
const spec = JSON.parse(readFileSync(join(RIG, "shots/sim.json"), "utf8"));
const want = a.shots ? String(a.shots).split(",") : null;
const out = a.out ?? join(VIDEO, "clips/sim");
mkdirSync(out, { recursive: true });
const DEVICE = a.device ?? "Weft Video iPhone 17 Pro";
const BUNDLE = "ai.elier.hermes";
const work = join(process.env.TMPDIR ?? tmpdir(), "weft-video-ios");
const GATEWAY = spec.gateway ?? "https://weft-gateway-preview.elier.ai";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function device() {
  const list = JSON.parse(sh("xcrun", ["simctl", "list", "devices", "-j"])).devices;
  for (const devs of Object.values(list)) for (const d of devs) if (d.name === DEVICE && d.isAvailable) return d;
  const rt = JSON.parse(sh("xcrun", ["simctl", "list", "runtimes", "-j"])).runtimes.filter((r) => r.platform === "iOS" && r.isAvailable).pop();
  const udid = sh("xcrun", ["simctl", "create", DEVICE, "iPhone 17 Pro", rt.identifier]).trim();
  return { udid, state: "Shutdown" };
}

function build() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, "src"), { recursive: true });
  sh("bash", ["-c", `git -C ~/code/hermes-ios archive wt/weft-feed | tar -x -C '${join(work, "src")}'`]);
  sh("xcodegen", ["generate", "-q"], { cwd: join(work, "src") });
  sh("xcodebuild", ["-project", "Hermes.xcodeproj", "-scheme", "Hermes", "-destination", `platform=iOS Simulator,id=${dev.udid}`,
    "-derivedDataPath", join(work, "dd"), "build", "CODE_SIGNING_ALLOWED=NO"], { cwd: join(work, "src") });
}

const dev = device();
if (dev.state !== "Booted") sh("xcrun", ["simctl", "boot", dev.udid]);
sh("xcrun", ["simctl", "bootstatus", dev.udid, "-b"]);
const appPath = a.app ?? join(work, "dd/Build/Products/Debug-iphonesimulator/Hermes.app");
if (a.build || !existsSync(appPath)) build();
sh("xcrun", ["simctl", "install", dev.udid, appPath]);
sh("xcrun", ["simctl", "status_bar", dev.udid, "override", "--time", "9:41", "--batteryState", "charged", "--batteryLevel", "100",
  "--cellularBars", "4", "--wifiBars", "3", "--dataNetwork", "wifi", "--operatorName", ""]);
sh("xcrun", ["simctl", "ui", dev.udid, "appearance", spec.appearance ?? "dark"]);

function token(kind) {
  if (kind === "human") return JSON.parse(readFileSync(join(homedir(), ".config/weft/web-preview-token.json"), "utf8")).token;
  return readFileSync(join(homedir(), ".config/weft/observer-all-token"), "utf8").trim();
}

let failed = 0;
for (const shot of spec.shots.filter((s) => !want || want.includes(s.id))) {
  try { sh("xcrun", ["simctl", "terminate", dev.udid, BUNDLE]); } catch {} // not running is fine
  // Filter (repos/onlyConflicts) is persisted app state: write it before launch.
  const filter = { repos: shot.repos ?? [], tasks: [], agents: [], kinds: [], onlyConflicts: !!shot.onlyConflicts };
  sh("xcrun", ["simctl", "spawn", dev.udid, "defaults", "write", BUNDLE, "weft.filter", "-data", Buffer.from(JSON.stringify(filter)).toString("hex")]);
  const launchArgs = ["-hermes.tab", "changes", "-hermes.url", "http://127.0.0.1:1", "-hermes.key", "x",
    "-weft.url", GATEWAY, "-weft.token", token(shot.token ?? "observer"), ...(shot.args ?? [])];
  sh("xcrun", ["simctl", "launch", "--terminate-running-process", dev.udid, BUNDLE, ...launchArgs]);
  await sleep(shot.settle ?? 4000); // first page + stream open before the camera rolls
  const mov = join(out, `.${shot.id}.mov`);
  rmSync(mov, { force: true });
  const rec = spawn("xcrun", ["simctl", "io", dev.udid, "recordVideo", "--codec", "h264", "--force", mov], { stdio: "ignore" });
  await sleep(1000);
  for (const act of shot.during ?? []) {
    await sleep(act.at ?? 0);
    if (act.openURL) sh("xcrun", ["simctl", "openurl", dev.udid, act.openURL]);
    if (act.relaunch) sh("xcrun", ["simctl", "launch", "--terminate-running-process", dev.udid, BUNDLE, ...launchArgs, ...act.relaunch]);
  }
  await sleep((shot.seconds ?? 8) * 1000);
  rec.kill("SIGINT");
  await new Promise((r) => rec.on("exit", r));
  const mp4 = join(out, `${shot.id}.mp4`);
  // Phone centred on a 1920x1080 stage; trim the first second (recorder warm-up).
  sh("ffmpeg", ["-y", "-loglevel", "error", "-ss", "1", "-i", mov, "-filter_complex",
    // simctl writes frames only when the screen changes (variable frame rate): pad with the last
    // frame and cut to the scripted length.
    `color=c=${spec.stage ?? "0x0b0d12"}:s=1920x1080:r=30[bg];[0:v]scale=-2:1000:flags=lanczos,fps=30,tpad=stop_mode=clone:stop_duration=60[ph];[bg][ph]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p`,
    "-t", String(shot.seconds ?? 8), "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-an", mp4]);
  rmSync(mov, { force: true });
  const check = scanVideo(mp4, 1);
  if (check.hits.length) { failed++; console.error(`${shot.id}: SCREEN-SAFETY FAIL ${JSON.stringify(check.hits.slice(0, 3))}`); rmSync(mp4); continue; }
  console.log(`${shot.id}: ${durationSec(mp4).toFixed(1)} s -> ${mp4} (device ${DEVICE}, OCR ${check.frames} frames clean)`);
}
sh("xcrun", ["simctl", "status_bar", dev.udid, "clear"]);
process.exit(failed ? 1 : 0);
