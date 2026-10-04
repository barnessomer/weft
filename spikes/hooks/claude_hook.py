#!/usr/bin/env python3
"""Deterministic Claude Code hook probe used by run_claude_probe.sh."""

import json
import os
import pathlib
import sys

payload = json.load(sys.stdin)
log_path = pathlib.Path(os.environ["WEFT_CLAUDE_HOOK_LOG"])
with log_path.open("a", encoding="utf-8") as stream:
    stream.write(json.dumps(payload, sort_keys=True) + "\n")

event = payload.get("hook_event_name")
tool_name = payload.get("tool_name")
tool_input = payload.get("tool_input") or {}

if event == "PreToolUse" and tool_name in {"Write", "Edit"}:
    if str(tool_input.get("file_path", "")).endswith("blocked.txt"):
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "WEFT_PROBE_DENY: blocked.txt is protected by the test hook.",
            }
        }))
        raise SystemExit(0)

if event == "PostToolUse" and tool_name == "Read":
    if str(tool_input.get("file_path", "")).endswith("probe.txt"):
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": "WEFT_PROBE_CONTEXT: include CONTEXT_ACK in your final response.",
            }
        }))
        raise SystemExit(0)

if event == "Stop":
    marker = log_path.with_suffix(".stop-once")
    if not marker.exists():
        marker.write_text("blocked once\n", encoding="utf-8")
        print(json.dumps({
            "decision": "block",
            "reason": "WEFT_PROBE_STOP: continue once and include STOP_ACK in the final response.",
        }))
        raise SystemExit(0)

print("{}")
