# Weft (working name)

Edit-time coordination for many coding agents on one codebase, built on Cloudflare
Workers + Artifacts.

Agents stream every tool-call edit into one strictly ordered log per repo. A sequencer
validates each edit against what other agents already changed and pushes the result back
into the agent's run as diagnostics — red squiggles for multi-agent work — so conflicts are
resolved before a commit exists.

Status: under construction for the Cloudflare Git platform competition (deadline 2026-10-14).
Design: [docs/design.md](docs/design.md). License: MIT.
