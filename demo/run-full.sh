#!/usr/bin/env bash
# One command for the full Weft demo (docs/design.md §8) on the deployed preview stack.
#   demo/run-full.sh [--run N] [--only t1,t6] [--skip-revert]
# See demo/scenarios/full.md. Needs: wrangler OAuth login, ~/.config/weft preview tokens,
# claude (logged in, or CLAUDE_CODE_OAUTH_TOKEN), codex (logged in), opencode.
# WEFT_PIN_EDGE_IP=<cloudflare edge ip> pins *.elier.ai locally while public DNS is missing.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
unset CLOUDFLARE_API_TOKEN
if [ -n "${WEFT_PIN_EDGE_IP:-}" ]; then
  export NODE_OPTIONS="--require $PWD/demo/lib/pin-dns.cjs ${NODE_OPTIONS:-}"
fi
exec node demo/m2-full.mjs "$@"
