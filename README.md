# Weft Coordination Protocol (WCP)

Weft coordinates coding agents while they edit—not only when they open a pull request. Agents submit tool-call edits to a per-repository sequencer. The sequencer validates each edit against accepted changes since the agent's base and returns actionable diagnostics to the agent through its native hooks. Humans see the same event stream and can approve, pause, message, undo, or inspect evidence.

The goal is to make concurrent agent work safer without file locks or requiring agents to stop and wait for a human merge. WCP is the harness-neutral wire protocol; Weft is its Cloudflare-backed implementation and set of adapters.

Status: research/demo implementation; WCP v0.1 is a draft, not a published standard. See [the design](docs/design.md), [protocol specification](docs/protocol/wcp-v0.md), and [try it yourself](docs/try-it.md).

## Architecture

```mermaid
flowchart LR
  subgraph agents[Agent workspaces]
    H[Claude Code / Codex / OpenCode / Hermes] --> A[Harness adapter + analyzer]
  end
  A -->|check / edit / events| G[Gateway]
  G --> C[Repo coordinator\nDurable Object + SQLite\nordered WCP log]
  C -->|verdicts / diagnostics / inbox| A
  C --> Q[Queues]
  Q --> W[Workflows\nprocess / select / land / revert]
  W --> S[Sandbox containers\nmerge / tests / agent]
  W --> R[Artifacts + evidence]
  G --> D[D1 index]
  HN[Human web / iOS clients] <-->|observe / human actions| G
```

Adapters translate harness hooks into WCP requests; the protocol and coordinator do not depend on any one coding agent. Artifacts hosts repos and candidate forks. A single Durable Object per repo assigns event order and validates edits. Workflows orchestrate revision processing, candidate selection, landing, and revert. Sandboxes perform git and test operations without exposing credentials to the agent container. D1 indexes tasks, changes, revisions, and evidence; R2 stores run artifacts. The live demo and preview environment are described in [the runbook](docs/runbook.md).

## Why Cloudflare

- **Workers** provide the gateway, UI, preview service, and product integrations close to the coordination API.
- **Durable Objects with SQLite** give each repository one authoritative ordered log, state machine, and submit queue.
- **Artifacts** supplies the trunk and isolated candidate forks.
- **Queues and Workflows** make push processing, tests, selection, landing, and recovery durable and retryable.
- **Containers / Sandbox SDK** isolate git, builds, tests, and optional agent runs; credentials are mediated outside the container.
- **D1** indexes cross-repo tasks and evidence; **R2** retains logs, transcripts, and screenshots.
- **Workers AI, AI Gateway, and Browser Rendering** support risk/review assistance, attributable model traffic, and visual evidence. They are supporting services, not required to understand the core WCP event model.

The implementation is evolving; the [design](docs/design.md) distinguishes core, strong, and optional product integrations. No production deployment is implied by this repository.

## Try it

Follow [docs/try-it.md](docs/try-it.md) to install the toolchain, run the protocol conformance suite locally, and optionally deploy a preview using your own Cloudflare account. The local path needs no Cloudflare account, API token, or provider credential.

## Repository map

- `packages/protocol` — WCP types, schema, validator, reference coordinator, and conformance fixtures.
- `packages/analyzer` — TypeScript diff-to-symbol read/write analysis.
- `packages/adapters` — harness-specific hook translators.
- `apps/gateway`, `apps/workflows`, `apps/sandbox`, `apps/web` — coordination API, durable jobs, isolated execution, and human UI.
- `demo/` — scenarios, drivers, and recorded evidence.
- `docs/` — design, protocol, runbooks, and [AAIF proposal](docs/proposal-aaif.md).

## License

MIT; see [LICENSE](LICENSE).
