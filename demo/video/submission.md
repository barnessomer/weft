# Cloudflare "Build the next GitHub" submission packet

Form: https://www.cloudflare.com/git-competition/submit/ (closes 2026-10-14 23:59 PDT)
Rules: https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf

STATUS: NOT SUBMITTED. Everything below is ready to paste; the entry needs John to confirm
eligibility and attendance and to submit it himself (see "Open items").

## Open items (need John)

1. Eligibility (rules §3): entrants must be legal residents of the US or Canada. Confirm
   John qualifies, and what to put for "Team location".
2. Attendance (rules §6-7): finalists present live at Cloudflare Connect, Moscone West, San
   Francisco, on 2026-10-21; the winner must be physically present. Form requires a first
   attendee (name + email). Default below: John.
3. Automated entry (rules §4, §5, §13): "Persons may not enter using robotic, programmed, or
   any other automated means of entry", and script-generated applications can be
   disqualified. The form is also Turnstile-protected. So an agent must not press Submit.
   John should paste these fields, attach the video, tick the two boxes and submit; then
   save a screenshot of the confirmation as demo/video/submission-confirmation.png.

## Assets (verified 2026-10-04)

- Repo: https://github.com/celador/weft (PUBLIC, MIT LICENSE detected by GitHub; README and
  docs/try-it.md render, HTTP 200)
- Video file to upload: /Users/john/github/weft/demo/video/weft-demo.mp4
  (7:38, H.264 1080p30 + AAC, 72,222,894 bytes, sha256
  0789c68c6b14a1def892529f21862ee8d2ae2c55c15b00a4b59956b243cbd64b; form accepts
  MP4/WebM/MOV up to 2 GiB; rules require 5-10 minutes)
- Public copy of the video: https://weft-media.elier.ai/weft-demo.mp4
  (captions: https://weft-media.elier.ai/weft-demo.en.srt)
- Run instructions on GitHub: https://github.com/celador/weft/blob/main/docs/try-it.md

## Field values

Team name (max 120): Weft (Atelier)

Primary contact name: John Aaron Nelson

Primary contact email: john@elier.ai

Team location (max 160): TBD by John (see open item 1)

First attendee name: John Aaron Nelson

First attendee email: john@elier.ai

Second attendee name / email (optional): leave blank

Project name (max 160): Weft Coordination Protocol (WCP)

Project vision (max 2000):

GitHub coordinates humans at merge time. Agents need coordination at edit time. When dozens or thousands of agents work one codebase, branches and pull requests find conflicts far too late: after the work is done, in a review queue nobody can keep up with.

Weft moves coordination into the edit itself. Every coding agent already changes code through tool calls (Edit, Write, apply_patch, shell). Weft streams each tool-call edit into one strictly ordered log per repository. A sequencer validates the edit's symbol-level read/write sets against everything accepted since the agent's base, and answers inside the agent's own run, through its native hooks, with positioned diagnostics: the multi-agent equivalent of an editor's red squiggles. Conflicts get resolved while the code is being written, before a commit exists. No file locks, no mutual retreat: exactly one party is told to adapt, by log order and priority.

Above the log sits a thin platform: tasks (intent), candidate changes with stable Change-Ids, evidence (tests, previews, screenshots, transcripts), selection among competing candidates, serialized landing on trunk, and automatic revert from the operation log. Humans watch the same event stream from the web or iOS and can approve, pause, message, undo or inspect evidence.

WCP is harness-neutral. The same protocol drives Claude Code, Codex, OpenCode and Hermes through thin adapters, so agents from different vendors cooperate on one repo. We built Weft with Weft: the agents that wrote it coordinated through it. We have drafted WCP as an open hook-interoperability proposal so any harness can speak it.

How you used Cloudflare (max 2000):

Weft is built entirely on Cloudflare's developer platform.

- Workers: the WCP gateway (check/edit/events API, adapter and human endpoints), the web UI, the preview service and product integrations.
- Durable Objects with SQLite: one coordinator per repository holds the authoritative ordered WCP log, assigns sequence numbers, validates every edit and runs the submit queue. Cloudflare's single-instance guarantee is our leader election.
- Artifacts: hosts each repository's trunk and an isolated fork per agent candidate, with repo-scoped tokens; Artifacts push events (via Queues event subscriptions) become WCP checkpoint events.
- Queues and Workflows: durable, retryable revision processing, test runs, candidate selection, landing and revert.
- Containers / Sandbox SDK: isolated git merges, builds, tests and optional agent runs; credentials stay outside the container.
- D1: cross-repo index of tasks, changes, revisions and evidence. R2: logs, transcripts, screenshots and the demo media.
- Workers AI, AI Gateway and Browser Rendering: risk/review assistance, attributable model traffic, and visual evidence (screenshots and diffs of previews). Workers AI also narrated our demo video.
- Tail Workers: production exceptions flow back into the log as signals that can trigger an automatic revert.

Open source repository URL: https://github.com/celador/weft

Instructions to run your project (max 4000):

Full guide: https://github.com/celador/weft/blob/main/docs/try-it.md

Prerequisites: Git, Node.js 22+ (CI uses Node 24), pnpm 9. Docker only for the container-specific tests. The local path needs no Cloudflare account, API token or model credentials.

1. Clone and install:
   git clone https://github.com/celador/weft.git
   cd weft
   pnpm install --frozen-lockfile
   (With Corepack: corepack enable && corepack prepare pnpm@9 --activate first.)

2. Run the WCP conformance suite (schema validation plus the reference coordinator's scenarios):
   pnpm --filter @weft/protocol test
   Whole-repo type and test gate:
   pnpm -r typecheck && pnpm -r test

3. Start the gateway locally (Wrangler dev; Durable Object state stays local):
   pnpm --filter @weft/gateway dev
   then in a second terminal:
   curl -i http://localhost:8787/v1/health

4. Optional, deploy the gateway preview to your own Cloudflare account:
   pnpm exec wrangler login && pnpm exec wrangler whoami
   unset CLOUDFLARE_API_TOKEN
   pnpm --filter @weft/gateway deploy:preview
   curl -i https://<your-gateway-preview-host>/v1/health
   The full multi-agent demo also needs Artifacts, D1, Queues, Workflows, Sandbox and evidence resources; docs/runbook.md covers provisioning, and demo/run-full.sh --run N runs the end-to-end scenario (18 live agents, 6 tasks) against a deployed stack.

Protocol spec: docs/protocol/wcp-v0.md. Design: docs/design.md.

Checkbox: I confirm this project was built using Cloudflare Workers and Artifacts. -> tick
(verified: apps/gateway/src/artifacts.ts, packages/artifacts)

Checkbox: I confirm this submission follows the competition terms. -> tick only after open
items 1-3 are settled.

## Confirmation

(fill in after submitting: date/time, confirmation text/ID, screenshot path)
