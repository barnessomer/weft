# B13 live run: planted bug → production error spike → auto-revert (preview)

`node apps/production-signal/scripts/live.mjs prove` → `run.json` (tokens scrubbed). Final run:
140 s end to end, 2026-10-04, preview stack. No human action after the land request.

Topology (all real Cloudflare resources):

- **Demo target**: Worker `weft-demo` (https://weft-demo.redacted-subdomain.workers.dev), connected
  to **Workers Builds** from the Artifacts trunk `weft-preview/weft-demo` (`main`, deploy command
  `npx wrangler deploy`, connected in the dashboard via *Create application → Continue with
  Artifacts*). Every trunk push (land, revert, seed) builds and deploys it. The trunk's
  `wrangler.jsonc` names `weft-production-signal-preview` as **Tail Consumer**.
- **Signal**: `weft-production-signal-preview` (Tail handler) writes each exception to Analytics
  Engine `weft_prod_preview` and sends it to Queue `weft-prod-events-preview`; the same Worker
  consumes the queue and runs the detector against D1 `weft-preview` (`production_errors`,
  `production_reverts`, `landings`).
- **Rule**: ≥ `WEFT_SPIKE_THRESHOLD` (5) exceptions within `WEFT_SPIKE_WINDOW_SECONDS` (600) after
  the most recent unreverted `land` of the repo → start `RevertOperation` once per land op
  (`prod-revert-<op_id>`, D1 latch) with the triggering stack trace as evidence.

What happened in `run.json`:

| t (s) | step |
|---|---|
| 3 | preflight: `GET /quote?sku=pear&qty=2` → 200 from trunk `b09fcdb` |
| 13 | agent `claude-b13` pushes the planted bug to its fork: `url.searchParams.get("unit")!.toLowerCase()` (throws when `?unit` is absent; unit tests do not cover the Worker) |
| 46 | ProcessRevision: `processed` (sandbox `node --test` green) |
| 72 | `POST /changes/{id}/land` → LandChange → `land` #87 `op-8fd2fb0b…`, trunk `8efc97b` |
| 78 | Workers Builds has deployed the bug (land → 500 in 5.8 s); 8 production requests, all 500 |
| 88 | detector latch in D1: 5 errors, triggered **15.9 s after the land row**; `prod-revert-op-8fd2fb0b…` running |
| 104 | RevertOperation complete: `revert` #88 (`reverts_seq` 87), revert commit `f804de0` on trunk |
| 115 | Workers Builds deployed the revert: `/quote` 200 again (43 s after the land) |
| 139 | final: task `b13-mutj3m36` **open**, change `reverted`, agent told (`message` #89), evidence `production_tail_error` |

Evidence attached to the change (what the reopened card shows):

```
TypeError: Cannot read properties of null (reading 'toLowerCase')
    at Object.fetch (worker.js:30:48)
    (request: GET /quote)
```

`analytics_engine_weft_prod_preview` in the final step: 5 data points for `weft-demo` in the
spike (Analytics Engine SQL API).

An earlier run (`op-5004c582…`, trunk `4fca7ab` → revert `a52cfff`) behaved the same (trigger 29 s
after land, healed 50 s after land); it also exposed a script bug (the workflow API answers 400,
not 404, for a not-yet-started instance), fixed before the final run.

Live findings fixed in `apps/production-signal` while proving this:

1. Tail `TraceItem.exceptions` is top level, not under `event`; the detector saw nothing before.
   Workers' `stack` is frames only, so the `Name: message` line is prefixed.
2. Analytics Engine accepts exactly one index: `writeDataPoint(): Maximum of 1 indexes supported.`
   threw inside the Tail handler and blocked the Queue send. Now `indexes: [repo]`, script in
   `blob1`, and a failed metrics write never blocks the detector.
