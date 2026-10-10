# Security policy

Weft sits between coding agents and the code they change, so security problems matter here:
anything that lets one agent read, block or alter another agent's work without authority, leak
diffs or tokens, or break the guarantees of the event log.

## Reporting a vulnerability

Please report privately. **Do not open a public issue or pull request.**

- Use GitHub's private reporting: [Report a vulnerability](https://github.com/celador/weft/security/advisories/new)

Include what is affected, steps to reproduce, and the impact you see. You'll get a reply within
3 business days. Please give us a reasonable time to fix it before you publish anything; we'll
credit you in the advisory unless you prefer not to be named.

## Scope

In scope: the coordinator and gateway (`apps/gateway`, `packages/sequencer`), the protocol and
its reference implementation (`packages/protocol`), the harness adapters (`packages/adapters/*`),
and the web UI. Examples: bypassing an open conflict or the stop/commit gates, claims that can't
expire, token or scope escalation, config discovery that sends data to an unexpected server,
non-deterministic journal replay.

Out of scope: the public read-only demo showing demo data, denial of service by volume against
the preview deployment, and issues in third-party harnesses themselves.

## Supported versions

Weft is pre-1.0. Only `main` is supported.
