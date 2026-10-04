# Agent hook capability matrix

Status: research snapshot (2026-10-03)

This note maps documented hook behavior in five agent runtimes to the Weft Capability Protocol (WCP) levels proposed in `docs/design.md`:

- **L0 — observe:** receive a lifecycle event and inspect its payload.
- **L1 — inject:** add model-visible context after observing an event.
- **L2 — pre-edit block:** deny an edit before it is applied.
- **L3 — stop/commit gate:** refuse completion and force another agent turn, or gate a commit before it executes.

A product is assigned the highest level for which its official documentation describes both the necessary input and the output/control semantics. Event names alone are not evidence. “L3” below is justified by a documented stop-continuation control; it does **not** imply a distinct atomic “before commit” lifecycle event. A shell-level `git commit` can usually be intercepted as a tool call, but that is a tool policy, not a transaction boundary over every possible repository write.

## Executive matrix

| Runtime | L0 observe | L1 model injection | L2 deny before edit | L3 refuse stop | Highest documented WCP level |
|---|---|---|---|---|---|
| Claude Code | Yes | Yes | Yes | Yes | **L3** |
| OpenAI Codex | Yes | Yes | Yes | Yes | **L3** |
| Gemini CLI | Yes | Yes | Yes | Yes | **L3** |
| Cursor | Yes | Yes | Yes | Yes | **L3** |
| GitHub Copilot CLI / coding agent hooks | Yes | Yes | Yes | Yes | **L3** |

All five can meet the abstract L0–L3 ladder. They are not wire-compatible: event names, payload shapes, result-merging rules, timeouts, asynchronous behavior, and tool coverage differ.

## Normalized capability matrix

| Runtime | Pre-tool event and observable edit data | Pre-edit denial and model feedback | Post-tool model context | Stop gate | Timing and execution |
|---|---|---|---|---|---|
| Claude Code | `PreToolUse`; common tool fields are `tool_name`, `tool_input`, `tool_use_id`. File-tool inputs expose tool-specific fields such as `file_path` and content/replacement data. There is no documented universal normalized diff field. | `hookSpecificOutput.permissionDecision: "deny"`; `permissionDecisionReason` is fed back to Claude. `allow` may include `updatedInput`. Exit 2 is also a blocking path. | `PostToolUse` sees `tool_input` and `tool_response`; `hookSpecificOutput.additionalContext` is model-visible. | `Stop` can return `decision: "block"` plus `reason`; `stop_hook_active` lets hooks avoid loops. | Command hooks default to 600 s; prompt/agent hooks default to 30 s. Per-handler `timeout` is configurable. Command hooks support `async: true`, but async hooks cannot make timely blocking decisions. |
| OpenAI Codex | `PreToolUse`; `tool_name`, `tool_use_id`, `tool_input`. `apply_patch` edits are reported as `tool_name: "apply_patch"` with the patch command in `tool_input.command`; there is no separate normalized diff field. | `permissionDecision: "deny"` plus `permissionDecisionReason`, legacy `decision: "block"`/`reason`, or exit 2. The reason becomes model-visible feedback. Supported calls can be rewritten with `allow` + `updatedInput`. | `PostToolUse` sees `tool_input` and `tool_response`; `additionalContext` is extra developer context. A post-tool block replaces the model-visible tool result but cannot undo side effects. | `Stop` returns `decision: "block"` and `reason`; Codex creates a continuation prompt. `stop_hook_active` is supplied. | 600 s default for most hooks; `SessionEnd` and `Interrupt` default to 1 s and allow at most 3 s. `async: true` is supported for command hooks, but background hooks cannot block, approve, rewrite, or continue the triggering operation. Matching command hooks launch concurrently. |
| Gemini CLI | `BeforeTool`; payload includes `tool_name` and tool-specific `tool_input`. This makes a file path or edit body available only when the selected tool’s input contains it; no universal normalized diff is documented. | Synchronous `BeforeTool` output can allow, deny, ask, or modify tool input. A denial reason is returned as feedback to the agent. | `AfterTool` receives `tool_name`, `tool_input`, and `tool_response`; documented output can add context/feedback and can replace tool output. | `AfterAgent` can reject completion and send a reason back into another agent iteration. | Command hooks are synchronous by default. `async: true` is supported, but asynchronous output cannot influence the current lifecycle decision. Configurable timeout is in milliseconds; the documented default is 60,000 ms. Hooks in a matcher group run sequentially or in parallel according to the group configuration. |
| Cursor | `preToolUse` receives `tool_name` and `tool_input`; file-specific hooks include `beforeReadFile`, `afterFileEdit`, and related events. `afterFileEdit` exposes file paths and edits, but is post-edit. Generic `preToolUse` has no guaranteed normalized diff. | `preToolUse` can return `permission: "deny"` with a user/agent-facing message. Denial occurs before tool execution; file-edit coverage therefore depends on the edit being represented as a hooked tool call. | `postToolUse` can return `additional_context`; post-file events provide observations but cannot undo an edit. | `stop` can return `followup_message`, causing another agent loop; `loop_limit` bounds repeated continuation. | Hooks are synchronous unless an event is explicitly documented as fire-and-forget; `timeout` is configurable in seconds and defaults to 30 s. Cursor documents parallel execution of matching hooks. |
| GitHub Copilot | `preToolUse` / `PreToolUse`; camelCase payload uses `toolName` and `toolArgs` (VS Code-compatible form uses snake_case). Tool arguments may contain file paths/edit bodies, but there is no universal normalized diff field. | `permissionDecision: "deny"`; `permissionDecisionReason` is required and is shown to the agent. `modifiedArgs` can replace arguments. In cloud agent, `ask` is treated as deny. | `postToolUse` can return `additionalContext` and/or replace the model-facing result with `modifiedResult.textResultForLlm`. | `agentStop` (and `subagentStop`) can return `decision: "block"` plus `reason`, forcing another turn. CLI overrides after 8 consecutive blocks. | Command hooks default to 30 s (`timeoutSec`, or `timeout` alias). Notification hooks are asynchronous/fire-and-forget; `/clear` session-end dispatch is detached. Decision-bearing hooks are processed synchronously. |

## Claude Code

### Documented events

The current official reference lists these exact event names:

`SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, and `SessionEnd`.

For Weft, the decisive path is:

1. `PreToolUse` receives `tool_name`, `tool_input`, and `tool_use_id` before execution.
2. A synchronous hook can deny with `hookSpecificOutput.permissionDecision: "deny"` and explain with `permissionDecisionReason`. The documentation’s own example says the reason is fed back to Claude.
3. `PostToolUse` receives the original input and `tool_response`; `additionalContext` is added to Claude’s context.
4. `Stop` receives `stop_hook_active` and the latest assistant message. A `decision: "block"` response with `reason` prevents stopping and continues the agent.

`tool_input` is tool-specific. For built-in file tools this exposes fields such as path and proposed content/replacements, but the hook API does not promise a normalized diff for every edit-capable tool. WCP should preserve the raw object and derive a normalized edit envelope only in a tool adapter.

### Configuration and execution

Supported locations include:

- `~/.claude/settings.json`
- `.claude/settings.json`
- `.claude/settings.local.json`
- managed policy settings
- plugin `hooks/hooks.json`
- skill and subagent frontmatter

Command hooks, HTTP hooks, MCP-tool hooks, prompt hooks, and agent hooks are documented. The default command timeout is 600 seconds; prompt and agent handlers default to 30 seconds. Command hooks may use `async: true`; asynchronous hooks are suitable for L0 and delayed L1, not L2/L3, because the triggering operation is no longer waiting for their decision.

### Classification

**L3 documented.** `PreToolUse` establishes L2 and `Stop` establishes L3. No separate repository-transaction or commit-finalization event is documented.

Sources:

- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/hooks.md

## OpenAI Codex

### Documented events

The official hooks reference lists these exact event names:

`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`, `Interrupt`, `SessionStart`, `SubagentStart`, and `SessionEnd`.

Relevant wire behavior:

- `PreToolUse` includes `turn_id`, `tool_name`, `tool_use_id`, and `tool_input` in addition to common fields. Bash and `apply_patch` place their command/patch in `tool_input.command`; MCP and other local tools send their argument object.
- Denial supports `hookSpecificOutput.permissionDecision: "deny"` with `permissionDecisionReason`, legacy `decision: "block"` with `reason`, or exit code 2 with the reason on stderr.
- A supported call can be rewritten with `permissionDecision: "allow"` and `updatedInput`.
- `PostToolUse` adds `tool_response`; `additionalContext` becomes extra developer context. A post-tool block replaces feedback seen by the model but does not undo effects.
- `Stop` includes `stop_hook_active` and `last_assistant_message`. `decision: "block"` with `reason` creates a new continuation prompt. A matching `continue: false` takes precedence over continuation decisions.

### Configuration and execution

Codex discovers `hooks.json` and inline `[hooks]` tables in `config.toml` at active configuration layers, notably user `~/.codex/` and trusted project `.codex/` layers; plugins may bundle hooks.

Most hooks default to 600 seconds. `SessionEnd` and `Interrupt` default to 1 second and accept at most 3 seconds. Matching command hooks for an event launch concurrently. `async: true` runs a command hook in the background; its `additionalContext` is delivered at the next safe point, but background hooks explicitly cannot block, approve, rewrite, or force continuation. `SessionEnd` is always synchronous but advisory.

### Classification

**L3 documented.** Codex explicitly documents both pre-execution `apply_patch` denial and stop continuation. A `git commit` issued through a hooked tool can be denied, but there is no distinct atomic commit lifecycle event.

Sources:

- https://learn.chatgpt.com/docs/hooks
- https://learn.chatgpt.com/docs/hooks.md

## Gemini CLI

### Documented events

The official hook reference lists:

`SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `PreCompress`, and `Notification`.

Relevant behavior:

- `BeforeTool` supplies `tool_name` and `tool_input` before execution. Its synchronous result can allow, deny, ask, or modify input. Denial carries a reason that is fed back to the agent.
- `AfterTool` supplies `tool_name`, `tool_input`, and `tool_response`; it can alter model-facing output and provide feedback/context, but cannot undo side effects.
- `BeforeAgent` can inject context before the agent loop.
- `AfterAgent` runs after an agent loop attempts to finish and can reject completion with a reason, causing the loop to continue. This is the L3 control, not merely an event whose name suggests stopping.

The generic tool envelope does not guarantee `file_path`, edit text, or diff as top-level fields. Those are available only when the selected tool’s documented input supplies them. Weft should not classify an unknown custom/MCP edit tool as L2 until its `tool_input` schema is known and the call is covered by `BeforeTool`.

### Configuration and execution

Hooks are configured in Gemini settings (`~/.gemini/settings.json`, project `.gemini/settings.json`) and may also be supplied by extensions. Command handlers accept a configurable timeout in milliseconds, with a documented default of 60,000 ms. The reference supports synchronous and asynchronous command hooks and matcher-group execution ordering. Async hooks cannot contribute a decision to the lifecycle point that has already continued, so they are L0/delayed-L1 only.

### Classification

**L3 documented.** `BeforeTool` establishes L2 for covered edit tools; `AfterAgent` establishes refusal/continuation at L3. No separate atomic commit event is documented.

Sources:

- https://geminicli.com/docs/hooks/
- https://geminicli.com/docs/hooks/reference
- https://geminicli.com/docs/hooks/writing-hooks

## Cursor

### Documented events

The current Cursor hooks reference documents these event names:

`sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterReadFile`, `beforeTabFileRead`, `afterTabFileEdit`, `afterFileEdit`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, and `stop`.

Legacy/specialized before/after events coexist with the generic `preToolUse` and `postToolUse` events. The generic pre-tool payload includes the tool name and arguments. A synchronous `preToolUse` result can deny execution and include a message. File-specific post events expose paths and edit records, but because they occur after the write, they are L0/L1 evidence only and cannot establish L2 by themselves.

`postToolUse` can return `additional_context`, making L1 explicit. `stop` can return a `followup_message`; Cursor starts another agent loop with that message. The documented `loop_limit` constrains repeated follow-ups.

### Configuration and execution

Cursor loads hooks from project `.cursor/hooks.json` and user `~/.cursor/hooks.json`; enterprise/policy-managed hooks may add another layer. The documented handler timeout is configurable in seconds and defaults to 30 seconds. Multiple matching hooks run in parallel. Notification-style hooks may be fire-and-forget, while permission and stop outputs require the synchronous path.

### Classification

**L3 documented.** The level depends on generic `preToolUse` covering the actual edit tool, not on `afterFileEdit`. `stop` plus `followup_message` provides the L3 continuation gate. No atomic commit-finalization event is documented.

Source:

- https://cursor.com/docs/hooks

## GitHub Copilot CLI and coding agent

### Documented events

The official reference lists these camelCase event names (and accepts the corresponding PascalCase VS Code-compatible forms):

`agentStop`, `errorOccurred`, `notification`, `permissionRequest`, `postToolUse`, `postToolUseFailure`, `preCompact`, `preToolUse`, `sessionEnd`, `sessionStart`, `subagentStart`, `subagentStop`, `userPromptSubmitted`, and `userPromptTransformed`.

Key controls:

- `preToolUse` / `PreToolUse` carries `toolName`/`tool_name` and `toolArgs`/`tool_input`-style tool arguments according to the selected format. Output accepts `permissionDecision` (`allow`, `deny`, `ask`), required `permissionDecisionReason` for denial, and optional `modifiedArgs`.
- The reason is explicitly shown to the agent. Under cloud agent, `ask` is treated as deny because there is no user.
- `postToolUse` can return `additionalContext` and can replace the model-facing successful result with `modifiedResult.textResultForLlm`.
- `agentStop` and `subagentStop` accept `decision: "block"` and `reason`; the reason becomes the next-turn prompt. The CLI has a runaway guard that ends the turn after eight consecutive block continuations; `stop_hook_active` is available to self-limit.

Cloud-agent behavior differs from local CLI behavior. Cloud jobs pre-approve tool permissions, so `permissionRequest` is ineffective there; the reference directs policy enforcement to `preToolUse`. Not every local event fires in cloud jobs.

### Configuration and execution

Copilot CLI combines policy, user, repository, inline settings, and plugin sources. Principal locations include:

- repository `.github/hooks/*.json`
- user `~/.copilot/hooks/*.json` (or `$COPILOT_HOME/hooks/*.json`)
- `.github/copilot/settings.json` and `.github/copilot/settings.local.json`
- user `~/.copilot/settings.json`
- compatible repository `.claude/settings.json` / `.claude/settings.local.json`
- plugin `hooks.json` or `hooks/hooks.json`

Cloud agent discovers repository `.github/hooks/*.json` by default. Command hooks use `timeoutSec` (or `timeout` as an alias) in seconds, defaulting to 30. `notification` is explicitly asynchronous and fire-and-forget. A CLI `/clear` dispatches session-end hooks detached. These asynchronous paths cannot gate the already-continuing operation.

### Classification

**L3 documented.** `preToolUse` gives L2 for covered edit calls and `agentStop` supplies L3. The eight-continuation guard means an absolute indefinite stop veto is not available. No separate atomic commit event is documented.

Source:

- https://docs.github.com/en/copilot/reference/hooks-reference

## Implications for WCP

### 1. Normalize envelopes, not semantics away

A portable adapter should preserve raw vendor payloads while exposing at least:

```text
observe.event
observe.session_id
observe.turn_id?
observe.tool.name?
observe.tool.call_id?
observe.tool.input?
observe.tool.output?
observe.edit.path?
observe.edit.before?
observe.edit.after?
observe.edit.patch?
control.allow | control.deny | control.continue
control.reason?
context.model_visible?
```

`edit.*` fields must be nullable. None of the five references guarantees a normalized diff for every tool invocation. Deriving a patch from raw arguments is an adapter responsibility and should carry a provenance marker such as `derived_from: tool_input`.

### 2. Require synchronous delivery for L2 and L3

All runtimes have asynchronous or detached paths, but a background observer cannot retroactively prevent an edit or stop. WCP negotiation should therefore record both the event and delivery mode:

- `observe` may be synchronous or asynchronous;
- `inject` may be immediate or delayed;
- `deny_edit` requires synchronous pre-tool delivery;
- `refuse_stop` requires synchronous stop/after-agent delivery.

### 3. Separate stop gates from commit gates

The documented common denominator is a **stop gate**. A practical **commit gate** can be built by denying a shell/tool call whose inspected arguments invoke `git commit`, but that does not cover commits created outside the agent tool path and is not an atomic hook around repository state. WCP should advertise these separately:

```text
cap.stop_gate = true
cap.commit_gate = "tool_interception" | "native" | false
```

For the five products reviewed here, official documentation supports `tool_interception`; a native atomic commit hook is **not documented**.

### 4. Preserve denial feedback

Every L2 implementation needs a model-visible reason; otherwise the model cannot repair the attempted edit. The adapters should map vendor fields (`permissionDecisionReason`, `reason`, message fields) to one WCP `control.reason`, while preserving the original field in the raw envelope.

## Unknowns and non-claims

- This document does not claim that every custom/MCP tool is intercepted. Coverage depends on each runtime’s documented tool path and the installed tool’s schema.
- It does not claim that any post-edit hook can roll back filesystem changes.
- It does not treat a log, notification, status message, or event name as model context unless the vendor documents model-facing delivery.
- It does not infer file paths, content, or diffs when the generic payload only promises an opaque/tool-specific argument object.
- It does not claim a native atomic Git commit gate for any reviewed runtime.
- Product behavior may change faster than this research note. Adapters should be integration-tested against the installed runtime version and fail closed when a required L2/L3 output field is rejected.

## Verified vs documented (local probes, 2026-10-03)

| Runtime | L0 observe | L1 inject | L2 deny edit | L3 refuse stop | Evidence |
|---|---|---|---|---|---|
| Claude Code 2.1.289 | **verified** (`PostToolUse` Read payload with `file_path` + `tool_response`) | **verified** (`additionalContext` → model echoed CONTEXT_ACK) | **verified** (`PreToolUse` Write denied; `blocked.txt` not created; model quoted the reason) | **verified** (`Stop` block → `stop_hook_active: true` second Stop, model emitted STOP_ACK) | `spikes/hooks/evidence/claude-*.jsonl`, `run_claude_probe.sh` |
| OpenAI Codex CLI | **verified** (`PostToolUse` Bash, `PreToolUse` with `tool_name: apply_patch` and the full patch in `tool_input.command`) | documented only | documented only (probe hit `PreToolUse` on `apply_patch`; turn then failed on a ChatGPT usage limit, so the deny outcome is not confirmed by a final message) | documented only | `spikes/hooks/evidence/codex-*.jsonl`, `run_codex_probe.sh` — re-run after quota reset (B5) |
| Gemini CLI, Cursor, Copilot | documented only | documented only | documented only | documented only | official docs (not installed / fixture-only per plan) |

Downstream: B4 can build on Claude Code L3 directly. B5 must re-run `run_codex_probe.sh` to confirm L1–L3 on Codex. Codex edits arrive as `apply_patch` text, which the adapter parses into WCP `edit.patch` (feed it to `analyzeDiff`).
