# Proposal: standardizing coding-agent hooks through WCP

**To:** Agentic AI Foundation (AAIF): a working-group discussion (Workflows & Process Integration, with Security & Privacy), and, in parallel, the Agent Plugins maintainers. Agent Plugins is an independently governed specification, not an AAIF project, and AAIF has no Agent Plugins working group.

**Now concrete:** the minimal layer proposed here is drafted as [Agent Hooks Core v0.1](protocol/hooks-core-v0.md), with a standalone [conformance suite](../packages/conformance/README.md) and [reports](standardization/reports/README.md); summary in the [one-pager](standardization/one-pager.md).

**Status:** Discussion proposal. Weft Coordination Protocol (WCP) v0.1 is an implementation draft, not a ratified or published standard.

## Summary

Agent Plugins 1.0 (announced on the AAIF blog, August 2026) establishes a portable plugin package model, but intentionally leaves the semantics of agent hooks unstandardized. This proposal recommends an AAIF work item for a small, runtime-neutral protocol for coding-agent lifecycle and tool hooks. Weft Coordination Protocol (WCP) is offered as an implementation-informed starting point—not a request to adopt Weft's server, data model, or product.

A common hook protocol would let a plugin declare which lifecycle events it observes, what context it can inject, whether it can block a tool call or stop, and how it reports diagnostics. Host-specific plugins could then translate their native APIs to common semantics, making coordination, policy, and audit plugins more portable across agent runtimes.

## Problem

Agent runtimes expose materially different hook surfaces. One may support pre-tool denial and post-tool context injection; another may only observe completed edits or gate session completion. Plugins currently need bespoke integrations and cannot reliably express their capabilities in a host-neutral way. This limits portability and creates ambiguity: a plugin that claims to "check edits" may be advisory in one runtime and enforceable in another.

The omission of hook semantics in Agent Plugins 1.0 should be treated as a deliberate boundary, not a flaw in that package format. Hook semantics are a separate interoperability layer that can evolve independently of plugin packaging.

## Proposal

Create an AAIF working item to define a minimal **Agent Hook Interoperability Protocol**, with WCP as one concrete reference implementation for discussion. The initial scope should include:

1. **Capability declaration:** observe, inject context, block a proposed action, and gate completion/commit, with explicit per-event support and versioning.
2. **Normalized lifecycle events:** session start/end, user prompt, pre/post tool call, and before/after agent completion. Each event carries stable session/run identity and a correlation ID.
3. **Decision envelope:** allow, advise, or deny; a short explanation; optional structured diagnostics; and a defined timeout/failure policy.
4. **Diagnostic model:** severity, source, affected resource/range when known, explanation, and references to causative events.
5. **Security and privacy:** least-privilege context, no implicit access to secrets, explicit handling of untrusted tool output, and documented retention/redaction behavior.
6. **Conformance suite:** host adapters declare tested capabilities and pass shared fixtures. Unsupported capabilities must be represented honestly rather than silently approximated.

WCP's edit-time event log, per-repository sequencing, and coordination arbitration are optional extensions, not prerequisites for the minimal hook interoperability layer. A standard must not require a central coordinator, a particular cloud provider, or a particular agent framework.

## Design principles

- **Portable semantics, native transports:** standardize meaning and envelopes, not a single plugin runtime or transport.
- **Fail behavior is explicit:** a hook declares whether timeout or service failure is fail-open, fail-closed, or host-controlled for each capability.
- **Capability is not assumed:** adapters advertise what the host actually permits; L0 observation is distinct from L2 pre-action denial or L3 completion gating.
- **Incremental adoption:** an observer-only plugin remains useful; stronger enforcement can be layered on when supported.
- **Interoperability over product alignment:** implementations may use local processes, HTTP, RPC, or in-process APIs.

## Relationship to Agent Plugins 1.0

Agent Plugins 1.0 answers how plugins are packaged and discovered. This proposal addresses how a plugin and host communicate about lifecycle and tool events. The two can be composed: a plugin package can declare a WCP-compatible adapter and its capabilities, while a host maps those declarations to native hooks. This proposal does not presume changes to the existing package specification.

## Prior art and implementation evidence

WCP v0.1 is implemented in [this repository](protocol/wcp-v0.md), with a JSON schema, reference coordinator, fixtures, and conformance runner under `packages/protocol`. Weft adapters translate Claude Code, Codex, OpenCode, Cursor, Gemini CLI fixtures, Hermes, and a file watcher into the shared protocol at differing capability levels. Those implementations are evidence of the portability problem and a source of test cases, not a claim that every runtime supports identical semantics or that WCP is already an industry standard.

## Suggested next steps

1. Invite maintainers of Agent Plugins and agent-runtime hook APIs to identify common lifecycle concepts and non-goals.
2. Compare existing host hook models and produce a capability matrix, including failure and timeout behavior.
3. Publish a short requirements document before choosing wire representation or adopting existing protocol pieces.
4. Use WCP and other implementations as inputs to an open, multi-implementation conformance suite.

The desired outcome is a small, vendor-neutral interoperability layer that makes plugins easier to port while leaving each runtime free to expose richer native capabilities.

## References

- [Agentic AI Foundation](https://aaif.io/)
- [Agent Plugins 1.0](https://agent-plugins.org/specification) and [the announcement](https://aaif.io/blog/from-skills-and-tools-to-portable-agent-plugins)
- [Agent Hooks Core v0.1](protocol/hooks-core-v0.md)
- [Weft Coordination Protocol v0.1](protocol/wcp-v0.md)
- [Weft design](design.md)
