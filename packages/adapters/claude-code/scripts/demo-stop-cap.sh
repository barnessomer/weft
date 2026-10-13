#!/usr/bin/env bash
# Experiment: does the Stop refusal cap let a stale agent finish while its cross-agent conflict is open,
# and is its commit still refused?
#
#   agent A (owner) changes calcTotal's signature in its checkout; the change is accepted.
#   agent B (stale: its base predates A's change) edits a caller of calcTotal the old way: stale_assumption.
#   B calls the Stop hook repeatedly with the same open error. Each call prints the decision.
#   B then commits the same stale edit with real `git commit`: the pre-commit gate refuses it.
#
# Runs the real adapter CLI (install + hook) against the protocol's reference coordinator over HTTP.
#
#   scripts/demo-stop-cap.sh                    # repo conflicts: hold (today's default)
#   DEMO_CONFLICTS=continue scripts/demo-stop-cap.sh
#   WEFT_KEEP=1 scripts/demo-stop-cap.sh        # keep the checkouts and logs for inspection
#
# Needs node >= 22, pnpm install done (esbuild in node_modules). Writes only to a mktemp directory.
set -euo pipefail

PKG="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$PKG/dist/weft-claude.mjs"
ESBUILD="$PKG/node_modules/.bin/esbuild"
MODE="${DEMO_CONFLICTS:-hold}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/weft-stop-cap.XXXXXX")"
COORD_PID=""

cleanup() {
  if [ -n "$COORD_PID" ]; then kill "$COORD_PID" 2>/dev/null || true; wait "$COORD_PID" 2>/dev/null || true; fi
  if [ "${WEFT_KEEP:-0}" = "1" ]; then echo "kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------- build
node "$PKG/scripts/build.mjs" >/dev/null
"$ESBUILD" "$PKG/scripts/demo-coordinator.ts" --bundle --platform=node --format=esm \
  --outfile="$WORK/coordinator.mjs" --log-level=warning

# ---------------------------------------------------------------- coordinator
DEMO_CONFLICTS="$MODE" node "$WORK/coordinator.mjs" >"$WORK/coordinator.log" 2>&1 &
COORD_PID=$!
URL=""
for _ in $(seq 1 50); do
  URL="$(sed -n 's/^listening \(http[^ ]*\).*/\1/p' "$WORK/coordinator.log" 2>/dev/null | head -1)"
  [ -n "$URL" ] && break
  sleep 0.2
done
[ -n "$URL" ] || { say "coordinator did not start:"; cat "$WORK/coordinator.log"; exit 1; }
say "== coordinator $(cat "$WORK/coordinator.log") (maxStopRefusals: default 5)"

# ---------------------------------------------------------------- fixtures
cat >"$WORK/pricing_v1.ts" <<'EOF'
export type Item = { price: number; qty: number };

export function calcTotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}
EOF
cat >"$WORK/pricing_v2.ts" <<'EOF'
export type Item = { price: number; qty: number };
export type PriceOptions = { taxRate: number };

export function calcTotal(items: Item[], opts: PriceOptions): number {
  const net = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  return net * (1 + opts.taxRate);
}
EOF
cat >"$WORK/cart_v1.ts" <<'EOF'
import { calcTotal, type Item } from "./pricing";

export function cartSummary(items: Item[]): string {
  return `${items.length} items`;
}
EOF
cat >"$WORK/cart_stale.ts" <<'EOF'
import { calcTotal, type Item } from "./pricing";

export function cartSummary(items: Item[]): string {
  return String(calcTotal(items));
}
EOF

# mkjson KIND SESSION CWD TOOL_USE_ID FILE [P1] [P2]: one hook payload on stdout
mkjson() {
  node -e '
    const fs = require("node:fs");
    const [kind, sid, cwd, id, file, p1, p2] = process.argv.slice(1);
    const payload = {
      stop: () => ({ hook_event_name: "Stop" }),
      prompt: () => ({ hook_event_name: "UserPromptSubmit", prompt: "continue" }),
      "pre-write": () => ({ hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: id, tool_input: { file_path: file, content: fs.readFileSync(p1, "utf8") } }),
      "post-write": () => ({ hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: id, tool_input: { file_path: file, content: fs.readFileSync(p1, "utf8") }, tool_response: { type: "update", originalFile: fs.readFileSync(p2, "utf8") } }),
      "pre-edit": () => ({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: id, tool_input: { file_path: file, old_string: p1, new_string: p2 } }),
    }[kind]();
    process.stdout.write(JSON.stringify({ session_id: sid, cwd, ...payload }));
  ' "$@"
}

# hook JSON: run the adapter's hook entry; prints its stdout (empty = allow / no output)
hook() { printf '%s' "$1" | node "$DIST" hook; }

# checkout NAME TASK: a git repo with two files, installed as a Weft checkout for agent NAME
checkout() {
  local dir="$WORK/$1"
  mkdir -p "$dir/src"
  cp "$WORK/pricing_v1.ts" "$dir/src/pricing.ts"
  cp "$WORK/cart_v1.ts" "$dir/src/cart.ts"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email demo@weft.invalid
  git -C "$dir" config user.name "weft demo"
  git -C "$dir" add -A
  git -C "$dir" commit -qm init
  node "$DIST" install --dir "$dir" --url "$URL" --repo demo --agent "$1" --task "T-$1" >/dev/null
  printf 'demo-token\n' >"$dir/.weft/token"
  chmod 600 "$dir/.weft/token"
}

checkout claude-b
checkout claude-a
A="$WORK/claude-a"
B="$WORK/claude-b"
SA="session-a"
SB="session-b"

# ---------------------------------------------------------------- the stale conflict
say "== B joins (base is before A's change)"
hook "$(mkjson prompt "$SB" "$B")" >/dev/null

say "== A joins, then changes calcTotal's signature in its checkout"
hook "$(mkjson prompt "$SA" "$A")" >/dev/null
hook "$(mkjson pre-write "$SA" "$A" "a1" "$A/src/pricing.ts" "$WORK/pricing_v2.ts")" >/dev/null
cp "$WORK/pricing_v2.ts" "$A/src/pricing.ts"
hook "$(mkjson post-write "$SA" "$A" "a1" "$A/src/pricing.ts" "$WORK/pricing_v2.ts" "$WORK/pricing_v1.ts")" >/dev/null
say "   A's signature change accepted; A's log: $(grep -o 'commit src/pricing.ts.*' "$A/.weft/log/adapter.log" | tail -1)"

say "== B edits its caller the old way (Edit tool)"
b_edit="$(hook "$(mkjson pre-edit "$SB" "$B" "b1" "$B/src/cart.ts" 'return `${items.length} items`;' 'return String(calcTotal(items));')")"
if printf '%s' "$b_edit" | grep -q '"permissionDecision":"deny"'; then
  say "   B's edit DENIED: $(printf '%s' "$b_edit" | grep -o 'stale_assumption[^.]*' | head -1)"
else
  say "   B's edit was not denied: ${b_edit:-<no output>}"
fi

# ---------------------------------------------------------------- the Stop gate, repeated
say "== B calls the Stop hook repeatedly (same open error each time)"
for i in 1 2 3 4 5 6 7; do
  out="$(hook "$(mkjson stop "$SB" "$B")")"
  if [ -z "$out" ]; then
    say "   stop $i: ALLOWED (no decision output)"
  else
    say "   stop $i: $(printf '%s' "$out" | grep -o 'Not done (stop refusal [0-9]*/[0-9]*)' || echo BLOCKED)"
  fi
done

# ---------------------------------------------------------------- the commit gate
say "== B commits the same stale edit with real git (pre-commit gate)"
cp "$WORK/cart_stale.ts" "$B/src/cart.ts"
git -C "$B" add src/cart.ts
set +e
commit_out="$(git -C "$B" commit -qm "cart: total via calcTotal" 2>&1)"
rc=$?
set -e
printf '%s\n' "$commit_out" | sed 's/^/   /'
say "   git commit exit code: $rc"
say "   commits on B after the attempt: $(git -C "$B" rev-list --count HEAD)"

# ---------------------------------------------------------------- the owner
say "== A (owner) on its next prompt"
owner="$(hook "$(mkjson prompt "$SA" "$A")")"
if printf '%s' "$owner" | grep -q 'conflicts with your change'; then
  say "   A was told: $(printf '%s' "$owner" | grep -o "[^\"]*conflicts with your change[^\"]*" | head -1 | cut -c1-140)"
else
  say "   A was not told (no owner notice)"
fi

say "== done: conflicts=$MODE"
