# Weft — plan and schedule

Today: Sat 2026-10-03 (day 0). Submission deadline: Wed 2026-10-14. Internal target: code
frozen 10-12, video recorded 10-13, submitted 10-13 (one day buffer).

| Day | Date | Milestone |
|---|---|---|
| 0 | 10-03 | Design, board, spikes S1–S3 running, scaffold |
| 1–2 | 10-04/05 | Protocol spec v0, analyzer, sequencer DO |
| 3–4 | 10-06/07 | Claude Code + Codex adapters. **M1: two live agents, one conflict caught at edit time** |
| 5–6 | 10-08/09 | Artifacts fork-per-task, sandbox runner, workflows, landing queue |
| 7–8 | 10-10/11 | Web UI, evidence (previews, screenshots, AI Gateway transcripts), negotiation, auto-revert, Gemini/Cursor adapters. **M2: full demo scenario runs end to end** |
| 9 | 10-12 | Hardening, demo repo, docs, code freeze |
| 10 | 10-13 | John records video; submit |
| 11 | 10-14 | Buffer / deadline |

Critical path: S2 → protocol → sequencer → adapters → M1 → Artifacts integration →
workflows → M2 → demo → video.

Slip rule: if M1 is not green by end of 10-07, cut Gemini/Cursor adapters and Vectorize
code index first; never cut the edit-time squiggle, Artifacts forks, or auto-revert.
