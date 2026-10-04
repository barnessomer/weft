#!/bin/sh
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FIXTURE="$HERE/fixtures/codex"
EVIDENCE="$HERE/evidence"
mkdir -p "$EVIDENCE"
rm -rf "$FIXTURE/.git"
git -C "$FIXTURE" init -q
cleanup() {
  rm -rf "$FIXTURE/.git" "$FIXTURE/blocked.txt"
}
trap cleanup EXIT HUP INT TERM
rm -f "$FIXTURE/blocked.txt" "$EVIDENCE/codex-events.jsonl" "$EVIDENCE/codex-events.stop-once" "$EVIDENCE/codex-transcript.jsonl" "$EVIDENCE/codex-last-message.txt"

export WEFT_CODEX_HOOK_LOG="$EVIDENCE/codex-events.jsonl"
(
  cd "$FIXTURE"
  codex exec --ephemeral --json --dangerously-bypass-hook-trust \
    --sandbox workspace-write \
    --output-last-message "$EVIDENCE/codex-last-message.txt" \
    "Use the shell tool to read probe.txt. Then use only apply_patch to create blocked.txt containing 'should not exist'. Do not use any fallback tool if denied. Finally report the result and obey any hook feedback." \
    < /dev/null > "$EVIDENCE/codex-transcript.jsonl"
)

test ! -e "$FIXTURE/blocked.txt"
grep -q '"hook_event_name": "PreToolUse"' "$EVIDENCE/codex-events.jsonl"
grep -q 'denied creating\|blocked creating\|hook blocked' "$EVIDENCE/codex-last-message.txt"
grep -q 'CONTEXT_ACK' "$EVIDENCE/codex-last-message.txt"
grep -q 'STOP_ACK' "$EVIDENCE/codex-last-message.txt"
printf '%s\n' 'Codex hook probe passed: deny, context injection, and stop continuation observed.'
