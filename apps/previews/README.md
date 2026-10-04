# weft-previews

Per-revision previews of candidate changes, served straight out of Cloudflare Artifacts, and
signed evidence blobs (screenshots, visual diffs) from R2. Part of B10 (see `docs/design.md`,
"Update 2026-10-04 (B10, evidence)").

    /p/<artifacts-repo>/<sha40>/<sig>/<path>   static site of that commit (root from .weft/preview.json)
    /e/<sig>/<r2-key>                          evidence blob from R2 weft-evidence
    /v1/health

`<sig>` is an HMAC (`src/sign.ts`, key `WEFT_PREVIEW_KEY`) over repo+sha or the R2 key, minted by
weft-workflows. Previews are immutable (cache forever), `noindex`, and sandboxed by CSP so one
candidate's scripts cannot read another's storage on this origin. Root-relative `href`/`src`/
`action` attributes in HTML are rewritten into the preview prefix.

Repo opt-in, `.weft/preview.json`:

```json
{ "root": "public", "routes": ["/", "/pricing.html"], "spa": false }
```

Tests: `pnpm test` (Node, fake Artifacts + R2). Deploy: see `docs/runbook.md` (B10).
