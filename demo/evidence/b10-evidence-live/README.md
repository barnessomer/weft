# B10 live evidence: previews, screenshots, visual diff, risk, review

`node apps/workflows/scripts/live-b10.mjs` on 2026-10-04 against the preview stack
(weft-gateway-preview, weft-workflows-preview, weft-sandbox-preview, weft-previews-preview,
Artifacts `weft-preview`, D1 `weft-preview`, R2 `weft-evidence-preview`, Browser Rendering,
Workers AI via AI Gateway `default`). Full log: `run.json` (82.6 s, push to landed).

Task `b10-mutjeffj`, "Add kiwi to the pricing page", acceptance criteria:
1. The pricing page lists kiwi at $4.00 per kg
2. The home page is unchanged
3. The catalog has a kiwi price and tests pass

| | claude-a (right) | codex-b (misread the task) |
|---|---|---|
| change | pricing row + catalog price | home hero text + catalog price |
| tests (rebased tree, sandbox) | 2/2 pass | 2/2 pass |
| visual diff vs trunk | `/` 0.00 %, `/pricing.html` 0.14 % | `/` 1.67 %, `/pricing.html` 0.00 % |
| risk (heuristic + llama-3.1-8b) | low | low |
| review (llama-3.3-70b, AI Gateway) | **pass 100**, 3/3 criteria met | **fail 33**, criteria 1 and 2 unmet |
| BestOfN score | 1180 (winner, auto-landed: risk low + review pass) | 819 |

Files:
- `a-index.png`, `a-pricing.html.png`: claude-a's preview (Browser Rendering, 1280×800)
- `b-index.png`, `b-pricing.html.png`: codex-b's preview
- `trunk-index.png`, `trunk-pricing.html.png`: trunk at the rebase base
- `a-pricing.html.diff.png`, `b-index.diff.png`: pixel diffs (changed pixels magenta over a grey ghost)
- `b9-task-view.png`: the B9 web UI task view rendering this evidence
- `run.json`: every step, evidence rows, x_evidence on the checkpoint and land records

Checks in `run.json` → "fetched artifacts": preview pages 200 with the sandbox CSP, CSS URL
rewritten into the preview prefix, kiwi present on A's pricing page and absent on B's, a forged
signature 404s, every screenshot/diff URL returns `image/png`. The URLs in `run.json` are
capability links to demo content (they stop working if `WEFT_PREVIEW_KEY` is rotated).
