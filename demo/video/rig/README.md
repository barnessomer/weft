# Video recording rig

Everything that turns `../script.md` + `../storyboard.md` into `out/weft-demo.mp4` without a
human at the controls. Node ≥ 22 (`export PATH=/opt/homebrew/opt/node@24/bin:$PATH`), run from
the repo root.

```
cd demo/video/rig && npm ci && npx playwright install chromium && cd -   # once (not a pnpm workspace member)
brew install vhs                                                          # once (pulls ttyd); ffmpeg + whisper already installed

node demo/video/rig/narrate.mjs --dry                                     # words/estimated time per section
node demo/video/rig/dogfood-stats.mjs --write demo/video/dogfood-stats.json --sentence   # refresh §09 numbers
node demo/video/rig/narrate.mjs --provider cf-aura2 --voice orion          # → demo/video/audio/NN.mp3
node demo/video/rig/record-web.mjs                                        # → clips/web/*.mp4
node demo/video/rig/render-term.mjs                                       # → clips/term/*.mp4
node demo/video/rig/record-sim.mjs [--build]                              # → clips/sim/*.mp4
node demo/video/rig/render-cards.mjs                                      # → clips/cards/*.mp4
node demo/video/rig/render-diagram.mjs                                    # → clips/diagram/S02a.mp4, S11a.mp4 (needs whisper cache: run assemble --plan first)
node demo/video/rig/assemble.mjs --plan                                   # slot vs clip per shot, no encoding (flags SHORT takes)
node demo/video/rig/assemble.mjs                                          # → out/weft-demo.mp4, out/captions.srt, out/timeline.json
```

`clips/`, `audio/`, `out/` are gitignored. Final binaries > 50 MB go to R2 `weft-media` (R3).

## Files

| File | Does |
|---|---|
| `lib.mjs` | script.md parser (`## NN · Title` + ```` ```narration ```` block), arg parsing, secret lookup (never printed), wrangler OAuth token, ffprobe |
| `narrate.mjs` | TTS per section: `cf-aura2` (Workers AI Aura-2), `gpt-audio` (OpenAI via OpenRouter), `edge`, `say`; loudnorm; `manifest.json` |
| `record-web.mjs` + `shots/web.json` | Playwright video of web UI views, 1920x1080 @30, page zoom 1.25, step DSL (goto/waitFor/click/hover/select/fill/scroll/hold/mark), trimmed to `mark start..end` |
| `play.mjs` + `shots/term.json` | prints transcript excerpts from evidence files with pacing + colour (`--estimate` = scripted length) |
| `render-term.mjs` | writes a VHS tape per term shot (`clips/term/.tapes/`), films it, OCR-checks it |
| `record-sim.mjs` + `shots/sim.json` | Hérmes Changes feed on a dedicated simulator, `simctl io recordVideo`, phone composed on a 1920x1080 stage |
| `render-cards.mjs` + `shots/cards.json` | title/end/stat/quote/timeline slides → still clips (assemble gives stills a slow push-in from the PNG instead of a frozen frame) |
| `render-diagram.mjs` | animated architecture diagrams (S02a, S11a): HTML/SVG filmed with Playwright; each step fires on its narration cue words (whisper timestamps, same mapping as assemble) |
| `assemble.mjs` + `edl.json` | cut shots to narration length, burn captions, mux audio, concat, SRT, timeline, final OCR check |
| `screen-safety.mjs` + `ocr.swift` | forbidden-pattern list, text redaction for transcripts, Apple Vision OCR of rendered frames |
| `dogfood-stats.mjs` | numbers for §09 from the `weft` repo's own log |

## Web auth

The web UI is `https://weft-web-preview.elier.ai` (never a `*.workers.dev` URL —
`record-web.mjs` refuses one). Two supported ways in, both without anything on screen:

1. **Cloudflare Access service token** (once John enables Access on the hostname,
   `docs/web-ui.md` → "Set up Cloudflare Access"): create a service token in Zero Trust →
   Access → Service Auth, add it to the app's policy (Include → Service Token; action
   *Service Auth*), then run with `WEFT_ACCESS_CLIENT_ID` / `WEFT_ACCESS_CLIENT_SECRET` in the
   environment. They go out as `CF-Access-Client-Id/-Secret` headers on every request; Access
   answers with the JWT the Worker verifies. Put them in the environment from a file, never on
   a command line that gets filmed.
2. **Operator key** (current preview: `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` are empty, so the
   Worker's fallback login is active — this is the "non-Access route"). The key is read from
   `~/.config/weft/web-preview-key` and POSTed to `/login` through the browser context's request
   API *before* a page exists, so the login form is never filmed; the session cookie is
   `HttpOnly; Secure; SameSite=Strict`. Dry run: `auth operator-key` on all 11 shots.

The header shows the session principal (`operator`), not an email.

## Screen safety

Never on screen: `*.workers.dev` URLs (the account's workers.dev subdomain is a customer's
company name), customer names, personal chats, tokens/keys. Three layers:

1. **Sources**: `play.mjs` passes every transcript line through `redact()` (workers.dev hosts →
   elier.ai, token-shaped strings → `[redacted]`, local paths shortened). Cards are scanned before
   rendering.
2. **Live DOM**: `record-web.mjs` probes `document.body.innerText` + URL + title after every step
   and aborts the shot on a hit (the clip is deleted, no debug screenshot is kept). It also
   *warns* when a link/img attribute matches (not visible, but a data smell).
3. **Pixels**: `screen-safety.mjs video` OCRs rendered clips (1 frame/s; Apple Vision) —
   render-term, record-sim and assemble run it automatically. Verified to catch a planted
   `https://weft-demo.example-co.workers.dev` frame.

Private patterns (customer names, people) live in `~/.config/weft/video-forbidden.txt`, one
regex per line, outside the repo so the names are never committed.

## Dry run (2026-10-04, current preview data)

- web: 11/11 shots recorded (S00a S01c S02b S03a S04a S05a S05b S05c S06d S07b S09a), OCR clean.
- term (VHS 0.12.1): 6/6 (S03b S03c S03d S04b S06c, live S10c: 118 protocol tests pass), OCR clean.
- sim: 3/3 (S08a S08b S09b) on "Weft Video iPhone 17 Pro" (iOS 26.5), app = committed
  `wt/weft-feed` (build 33 code) exported with `git archive` and built with xcodebuild, OCR clean.
- cards: 10/10.
- narration: all 12 sections with Aura-2 orion (7:07 of speech).
- assembly: `assemble.mjs` → 7:23 (442.9 s), H.264 1920x1080 30 fps + AAC 48 kHz, 29 MB,
  118 caption cues, shots cut on narration cues (whisper word timestamps), final OCR of 221
  frames: 0 hits. Kept in git: `../dryrun/contact-sheet.jpg` (one frame per section),
  `../dryrun/captions.srt`, `../dryrun/timeline.json`. The MP4 itself stays local (gitignored).
- Watch-back findings, fixed: a term shot ended on the shell prompt (tapes now stop before the
  player exits); terminal shots with few lines were sparse (bigger font per shot); §03 cuts
  were out of step with the narration (cue-based slots).
- Watch-back findings for R3: 24 shots are shorter than their slots and freeze on the last
  frame (assemble prints `last frame held …`; e.g. S05a board 6 s in a 31 s slot). Take longer
  holds in `shots/web.json` / `sim.json` (target = `seconds` in `timeline.json`) and give the
  cards gentle motion or more content. S05b now starts at "Every push is rebased" (EDL changed
  after the dry run).

## Final cut (R3, 2026-10-04)

- **Video**: https://weft-media.elier.ai/weft-demo.mp4 (R2 bucket `weft-media`, custom domain
  `weft-media.elier.ai`; 7:38 = 458.5 s, H.264 1920x1080 30 fps + AAC 48 kHz, 72 MB, sha256
  `0789c68c6b14a1def892529f21862ee8d2ae2c55c15b00a4b59956b243cbd64b`). Captions:
  https://weft-media.elier.ai/weft-demo.en.srt. Too big for git (> 50 MB): `demo/video/weft-demo.mp4`
  is gitignored; `../captions.srt`, `../timeline.json` and `../contact-sheet.jpg` are committed.
- Narration: Workers AI Aura-2 `orion`, one mp3 per section (`audio/NN.mp3`, 7:07 of speech),
  integrated loudness -17.3 LUFS. 120 burned-in caption cues on whisper word timing; spot-checked
  against the final mix (e.g. "This is Weft" spoken 13.58 s, cue 13.46 s; "Git and GitHub" 17.12 s,
  cue 17.37 s).
- Every shot covers its slot (`assemble.mjs --plan`: no SHORT takes); stills get a slow push-in.
  S02a and S11a are animated architecture diagrams (`render-diagram.mjs`) that light up each
  component as it is named.
- Screen safety: final OCR 229 frames, 0 hits; each clip OCR-checked as rendered.
- Watch-back fixes: web UI Replay showed the whole log instead of animating (a render during the
  replay refilled the list; `apps/web/public/app.js` now shows only what the replay has reached,
  and a filtered replay replays only the filtered records; deployed to weft-web-preview);
  captions split "Agent Plugins 1." / "0 spec" (sentence splitter fixed); S02a's verdict arrow
  crossed the adapters (rerouted); simctl's first still frame was trimmed away, leaving S08a black
  (record-sim now fills frames before trimming); S08a read "45 repos" (observe-only token scoped to
  the 4 repos on screen, `~/.config/weft/observer-video-token`); S09b showed an empty filter
  (now opens the first collision, `weft:6`); S10c ran in the worktree (`cwd: main-checkout`).

## Known issues (historical, all resolved in the final cut)


- **Evidence screenshots/previews are broken in the Task view** (S05b, S06d): D1 `evidence` rows
  and `x_evidence` payloads written before the hostname move still hold
  `https://weft-previews-preview.<customer>.workers.dev/...` URLs; that host no longer resolves.
  Needs a data fix (rewrite to `weft-previews-preview.elier.ai`, re-sign if the signature covers
  the host) — follow-up card.
- S04a negotiation must come from a B11 run on the **preview** gateway (evidence runs used local
  `wrangler dev`).
- S08a reads "Connecting · 45 repos" with the all-repos observer token; mint an observer token
  scoped to the repos on screen.
- VHS `Wait` returned early; tapes use explicit sleeps from `play.mjs --estimate` (or one timed
  run for `exec` shots).
- `simctl recordVideo` writes frames only on change; record-sim pads with the last frame.
- Playwright's video records CSS pixels: a smaller viewport with `deviceScaleFactor` only adds
  a grey border, so enlargement uses CSS `zoom`.
- This ffmpeg has no libass/drawtext: captions are rendered as PNGs (Playwright) and overlaid.
- Web Analytics' auto-injected beacon is blocked by the web UI's CSP (console noise only).
