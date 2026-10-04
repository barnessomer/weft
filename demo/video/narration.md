# Narration voice: comparison and pick

**Pick: Workers AI `@cf/deepgram/aura-2-en`, speaker `orion`** (`rig/narrate.mjs --provider
cf-aura2 --voice orion`). Fallback: Edge neural `en-US-AndrewMultilingualNeural` (Hermes's own
TTS provider).

Samples (script sections 00 + 01, rendered 2026-10-04, loudness-normalised to -16 LUFS) are in
`samples/<provider-voice>/{00,01}.mp3`; numbers in `samples/metrics.json`.

| Candidate | How | Available? | WER vs script (whisper small.en) | Pace | Pitch SD (semitones) | Notes |
|---|---|---|---|---|---|---|
| **cf-aura2 · orion** | Workers AI REST, wrangler OAuth token | yes | **0.0 %** | 167 wpm | **5.6** | Male, warm; most pitch movement of the set; licensed for production use through Workers AI; on-brand (one more Cloudflare product carrying weight) |
| cf-aura2 · athena | same | yes | 1.5 % | 185 wpm | 4.4 | Female; fast for a technical explainer |
| edge · Andrew (multilingual) | `edge-tts` (Hermes TTS provider `edge`) | yes | 0.0 % | 175 wpm | 3.8 | Natural, slightly flatter; uses Edge's read-aloud service, whose terms are not meant for published content → fallback only |
| edge · Aria | same (Hermes's configured default voice) | yes | 0.0 % | 158 wpm | 3.4 | Female; flattest neural option; most silence between phrases |
| macOS say · Samantha | `say -v Samantha` | yes | 3.0 % | 193 wpm | 3.0 | Only compact voices installed (no Premium/Enhanced); audibly robotic; baseline only |
| OpenAI `gpt-audio` (voices cedar/marin) | OpenRouter (`OPENROUTER_API_KEY`, the only OpenAI-model key Hermes has; `VOICE_TOOLS_OPENAI_KEY` is not set) | **blocked today** | – | – | – | `403 Budget limit exceeded (daily limit)` on 2026-10-04 (same wall that aborted M1 runs 3–4). `narrate.mjs --provider gpt-audio` is implemented (streamed pcm16 → mp3); retry at R3 after the daily reset and A/B against orion before the final render |

How the numbers were made (reproducible):

- WER: `whisper <sample> --model small.en`, normalised words vs the script text, Levenshtein.
- Pace: words of the script / rendered seconds (includes the 0.45 s paragraph pauses the renderer
  inserts).
- Pitch SD: autocorrelation F0 on voiced 40 ms frames, SD in semitones around the median — a
  rough proxy for monotony (octave errors inflate it a little for every voice alike). No human
  listening test was possible in this headless run; the numbers plus the licensing argument
  decided it. A 60-second human listen of `samples/cf-aura2-orion/` vs `samples/edge-andrew/`
  is the cheap check before R3's final render.

Rendering notes (`rig/narrate.mjs`):

- One mp3 per script section, paragraphs rendered separately and joined with 0.45 s of silence,
  then `loudnorm` to -16 LUFS / -1.5 dBTP (YouTube-friendly).
- TTS-only respellings (captions keep the script text): `WCP` → "W C P", `createSession` →
  "create Session", `Change-Id` → "Change I D", `D1`/`R2` → "D-one"/"R-two". "Hérmes" is written
  "Hermes" in the script so every voice says it naturally.
- Full narration with orion (dry run, current script): 7:07 of speech; with lead/tail gaps the
  cut is ~7:20 (`out/timeline.json` after `assemble.mjs`).
- Cost: Workers AI Aura-2 is billed per character on Workers Paid; the whole script is ~6,300
  characters per render — cents.
