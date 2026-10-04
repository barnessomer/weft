# Weft — demo video script (R3a pre-production)

Target length 7:30 (hard limits 5–10 min). Judging asks three things: what we built,
what it enables agents and developers to do, how it works. Every section below answers
at least one of them (tag in brackets).

Format rules (the rig depends on them):

- Each section is `## NN · Title`, followed by one ```` ```narration ```` block. That block
  is the exact text sent to TTS (`rig/narrate.mjs`) and the source of the burned-in captions
  (`rig/captions.mjs`). One audio file per section: `audio/NN.mp3`.
- Write numbers the way they should be spoken ("forty-three seconds") only where TTS gets
  them wrong; otherwise digits are fine (captions show the narration text verbatim).
- `Shots:` refers to shot ids in `storyboard.md`. `Facts:` names the evidence file each
  claim comes from. A claim without a source does not go in.
- Word budget at ~150 wpm: 7:30 ≈ 1,120 words. Current draft: see `rig/narrate.mjs --dry`
  (prints words and estimated seconds per section).

Screen safety (applies to every shot): never show a `*.workers.dev` URL, a customer's
name, a personal chat, a token or a key. Several evidence files still contain the old
preview hostname (a customer's company name): `rig/screen-safety.mjs` greps every source
before recording and OCRs sampled frames of every rendered clip after. See `rig/README.md`.

Fact refresh before final recording (R3): `node demo/video/rig/dogfood-stats.mjs` re-reads
the `weft` repo's own log and prints the numbers for section 09; M2's evidence
(`demo/evidence/m2/`) may replace B12 as the source for section 07.

---

## 00 · Cold open  (0:00–0:20) [what]

```narration
This is an AI agent being stopped in the middle of an edit. Not by a test, not by a merge conflict. By another agent's change, made a few seconds earlier, in a different checkout. This is Weft.
```

Shots: S00a (squiggle card glowing in the Live view), S00b (title card).
Facts: `demo/evidence/m1/run-1/` (Codex denied at PreToolUse, log #9).

## 01 · The problem  (0:20–1:05) [what · enables]

```narration
Git and GitHub coordinate people at merge time. You branch, you work for a day, and the pull request tells you what collided. That works when changes are slow and humans read every diff.
Agents are not slow. Ten of them can touch the same function in the same minute, each in its own checkout, each sure its picture of the code is current. By the time a pull request exists, the damage is done: two branches that merge cleanly and do not compile.
Agents need coordination at edit time, while the code is being written.
```

Shots: S01a (card: merge time vs edit time), S01c (Live view of repo `weft` filling with many agents' edits, Replay 64×). No "without Weft" terminal shot: M1's trial run 0 kept no evidence, and nothing in this video is re-enacted.
Facts: `demo/evidence/m1-report.md` ("Without Weft … Git merged both branches without a conflict, and tsc failed on main with exit 2").

## 02 · What Weft is  (1:05–1:45) [what · how]

```narration
Weft is a coordination layer for coding agents, built on Cloudflare. Every tool call that edits code becomes an event in one strictly ordered log per repository. A sequencer, one Durable Object per repo, checks each edit against everything that landed since the agent last looked, down to the symbol. Nothing is locked; agents keep working, and Weft validates instead. The verdict goes straight back into the agent's run as a diagnostic: the multi-agent version of your editor's red squiggle. The wire format is an open protocol, the Weft Coordination Protocol.
```

Shots: S02a (architecture diagram, animated build: agent → adapter → gateway → RepoCoordinator DO → diagnostics back), S02b (Live view: a record with reads/writes `sig`/`body` chips).
Facts: `docs/design.md` §1, §4; `docs/protocol/wcp-v0.md`.

## 03 · The squiggle  (1:45–2:50) [enables · how]

```narration
Here is the moment it exists for. Two agents from two vendors. Claude Code is adding session expiry, so it changes createSession to take an options argument. Codex, in its own checkout, planned a signup flow against the old signature.
Codex tries to write its call. The pre-edit hook asks Weft, Weft answers no, and the edit never touches disk. Codex gets the reason in its tool result: you use createSession, whose signature changed in event three, by Claude, after your base. Below it, the actual diff, because Claude's change is not in Codex's checkout yet.
Codex reads it, passes a one-hour time-to-live, and retries. Accepted. Both branches merge, and main type-checks. The conflict was resolved before either commit existed. Only one side was told to yield: the agent that was first keeps the function, so two agents never back off from each other forever. Each check costs about half a second.
```

Shots: S03a (Live view: #3 claude-a signature change → #9 REJECTED with red squiggle on `createSession`, cause link outlines #3), S03b (terminal transcript: Codex tool result with the deny text + quoted hunk), S03c (terminal: Codex's next message + accepted #10), S03d (terminal: landing.txt, `main after both merges: tsc exit 0`).
Facts: `demo/evidence/m1/run-1/` (`coordinator-log.json`, `b-hooks.jsonl`, `landing.txt`), `demo/evidence/m1-report.md` (3/4 valid runs pass; ~0.55 s per pre-edit check hook).

## 04 · Negotiation  (2:50–3:35) [enables · how]

```narration
Being stopped is not the only option. The losing agent can retreat, wait, negotiate, or escalate, and each one is a protocol action. Here, the second agent proposes a deal: keep the old one-argument form as an overload. The proposal is injected into the first agent's next tool call. It accepts, writes real TypeScript overloads, and Weft won't let it finish until it has. Both changes land. Five out of five runs.
```

Shots: S04a (Live view filtered to negotiation: `negotiate.propose` #11 → `accept` #14 → edit #13), S04b (terminal: run-5 transcript excerpt — A sees `[weft negotiation] … proposes to you: overload on createSession`), S04c (code: the two overload signatures).
Facts: `demo/evidence/b11/README.md` (5/5 valid runs; run 5 live injection at PreToolUse), `demo/evidence/b11/run-5/transcript.md`.

## 05 · Candidates and evidence  (3:35–4:30) [enables · how]

```narration
Above the log sits a thin platform. A task can get several candidate changes, each in its own fork in Cloudflare Artifacts. Every push is rebased onto trunk, tested in a sandbox, previewed straight from the Artifacts commit, screenshotted with Browser Rendering and pixel-diffed against trunk, then scored by a review agent against the task's acceptance criteria. Evidence binds to a stable Change-Id, not a commit hash, so it survives every rebase.
For "add kiwi to the pricing page", one candidate changed the pricing page and scored a hundred. The other also rewrote the home page hero and failed review. Weft landed the right one on its own, about eighty seconds after the push. Risky work waits for a human to approve.
```

Shots: S05a (Board view: task in Review with 2 candidates), S05b (Task view: candidates side by side — screenshots, Δ% pricing 0.14 / home 1.67, review pass 100 vs fail 33), S05c (Ops view: the `land` op).
Facts: `demo/evidence/b10-evidence-live/README.md` + `run.json`, design.md B10 update.

## 06 · Auto-revert in 43 seconds  (4:30–5:15) [enables · how]

```narration
Landing is not the end. We planted a bug, a missing null check that unit tests don't cover, and let it land. Workers Builds deployed it from the Artifacts trunk. Six seconds later, production was throwing. A Tail Worker fed every exception into a detector; about fifteen seconds after the land, it started a revert from the operation log. Forty-three seconds after the land, the fix was live again, the task reopened with the stack trace attached, and the agent was told why. No human touched it.
```

Shots (S06b = S05c reused): S06a (timeline graphic from `run.json`: 0 land → 6 s 500s → 15 s revert started → 43 s healthy), S06b (Ops view: land op → `reverted`), S06c (terminal: the live run's own timeline from `run.json`, `GET /quote` 500 → 200), S06d (Task view: reopened, evidence `production_tail_error` stack trace).
Facts: `demo/evidence/b13-auto-revert-live/README.md` (land → 500 in 5.8 s; detector latch 15.9 s after the land row, observed by the driver at t+15 s; healthy 43 s after land).

## 07 · Many harnesses, one protocol  (5:15–5:50) [what · how]

```narration
Weft does not care which agent you use. Each harness gets a thin adapter over its own hooks, and they all speak the same protocol. Claude Code, Codex and OpenCode run live against one coordinator, and a plain file watcher covers any tool with no hooks at all. Hermes, the agent that built this project, has its own adapter too. Adapters declare what they can do: observe, inject context, block an edit, or refuse to finish while an error is open.
```

Shots: S07a (split-screen terminals: three agents' transcripts from B12, each showing a weft line), S07b (Live view: Agents panel with harness + level badges), S07c (diagram: L0–L3 ladder).
Facts: `demo/evidence/b12-*/summary.json` (Claude Code + Codex + OpenCode + watcher on one coordinator), design.md B12 update. Cursor adapter is documented-not-live and Gemini is fixture-only: do NOT name them as live. [R3: re-check against M2 evidence; if M2 runs four live harnesses, say "four".]

## 08 · The editor disappears  (5:50–6:25) [enables]

```narration
When agents write the code, nobody is watching an editor. So Weft's human surface is a feed. This is Hermes, on a phone: every intent, edit, squiggle, negotiation, landing and revert, live, across repos. Tap a squiggle to see what caused it. Approve a candidate, undo a landing, pause an agent, or send it a message, from wherever you are. The same feed runs in a browser.
```

Shots: S08a (iOS simulator: Changes feed, live), S08b (iOS: event detail of the squiggle with its cause), S08c (R3 only: approve sheet on the R3 demo repo).
Facts: `~/code/hermes-ios/.worktrees/weft-feed/docs/weft.md` (build 33 verified live against the preview gateway).
Pronunciation note: the app is "Hérmes"; narration spells "Hermes" so TTS says it naturally.

## 09 · Built under Weft  (6:25–7:00) [enables]

```narration
Weft was built by agents, under Weft. Since the first night of the build, every kanban worker on this project ran the Weft adapter. In ten hours, its own log recorded 571 events: 420 edits from three agent profiles across 22 tasks, 66 checkpoints and 18 landings, with 59 warnings that told one agent to wait for another. The first time two workers reached for the same function, the second was told to wait, waited, and finished cleanly. This is that log.
```

Shots: S09a (Live view of repo `weft`, squiggles only), S09c (stat card from `dogfood-stats.json`), S09b (iOS feed, repo `weft`, only conflicts).
Facts: `node demo/video/rig/dogfood-stats.mjs --write demo/video/dogfood-stats.json` (as of 2026-10-04T13:04:05.430Z: 571 records, 420 edits, 66 checkpoints, 18 lands, 22 tasks, 3 agents, 59 `claim_wait`, 0 rejected); the sentence above is its `--sentence` output, `demo/beats/built-under-weft.md`. **Refresh at R3** — the numbers will grow; keep the sentence shape.

## 10 · An open standard  (7:00–7:25) [what]

```narration
The Agent Plugins 1.0 spec says it plainly: hooks don't yet have consistent semantics across clients, so they are not portable. Coordination needs exactly that. WCP is our answer: a small, versioned wire protocol with a conformance suite and a reference implementation. It's MIT-licensed, and we're proposing it as an open standard to the Agentic AI Foundation.
```

Shots: S10a (quote card: Agent Plugins 1.0 text), S10c (terminal, live: `pnpm --filter @weft/protocol test`, 118 tests green). Optional R3: S10b, the spec `docs/protocol/wcp-v0.md` scrolling.
Facts: https://aaif.io/blog/from-skills-and-tools-to-portable-agent-plugins ("agents, commands, hooks, rules … do not yet have consistent semantics or security models across clients, so they are not portable component types in 1.0"). Note: Agent Plugins is an independent spec (guest post on the AAIF blog), not an AAIF project — do not say "AAIF's Agent Plugins".

## 11 · How it runs on Cloudflare  (7:25–8:00) [how]

```narration
Everything runs on Cloudflare, and every product carries weight. Artifacts holds every repo, fork and preview. Durable Objects are the sequencers. Workflows run rebase, landing, revert and best-of-N. Containers run agents and git with no secrets inside. Queues carry pushes and production errors, Tail Workers watch production, Browser Rendering takes the screenshots, Workers AI and AI Gateway run the reviewer, D1 and R2 hold the evidence. Weft. Coordination at edit time.
```

Shots: S11a (architecture diagram, products highlighted as named), S11b (end card: repo URL github.com/celador/weft, elier.ai, "Weft Coordination Protocol — MIT").
Facts: design.md §7 + B6/B7/B8/B10/B13 updates.

---

Word count and timing: `node demo/video/rig/narrate.mjs --dry`. Shot timing is cue-based
(`rig/edl.json`: a shot starts when its cue words are spoken), so edits to the narration keep
the cuts in sync after re-rendering the audio.
