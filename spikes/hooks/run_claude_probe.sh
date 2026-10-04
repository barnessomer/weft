#!/bin/sh
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FIXTURE="$HERE/fixtures/claude"
EVIDENCE="$HERE/evidence"
mkdir -p "$EVIDENCE"
rm -f "$FIXTURE/blocked.txt" "$EVIDENCE/claude-events.jsonl" "$EVIDENCE/claude-events.stop-once" "$EVIDENCE/claude-transcript.jsonl"

export WEFT_CLAUDE_HOOK_LOG="$EVIDENCE/claude-events.jsonl"
(
  cd "$FIXTURE"
  claude -p --verbose --output-format stream-json --include-hook-events \
    --no-session-persistence --setting-sources project \
    --settings "$FIXTURE/hooks.settings.json" \
    --allowedTools Read Write Edit -- \
    "Read probe.txt with the Read tool. Then use only the Write tool to create blocked.txt containing 'should not exist'. Do not use any fallback tool if denied. Finally report the result and obey any hook feedback." \
    > "$EVIDENCE/claude-transcript.jsonl"
)

test ! -e "$FIXTURE/blocked.txt"
grep -q 'WEFT_PROBE_DENY' "$EVIDENCE/claude-transcript.jsonl"
grep -q 'CONTEXT_ACK' "$EVIDENCE/claude-transcript.jsonl"
grep -q 'STOP_ACK' "$EVIDENCE/claude-transcript.jsonl"
printf '%s\n' 'Claude hook probe passed: deny, context injection, and stop continuation observed.'
