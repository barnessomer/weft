# S3 — TypeScript symbol read/write extraction

## Recommendation

Use the TypeScript compiler API in the adapter/runtime that observes an edit, then send the
resulting `reads` and `writes` in the WCP event to the Durable Object. Do not put the compiler
API into the sequencer Worker for v0.

The prototype in `spikes/analyzer/` implements this recommendation for a single TypeScript file:

```ts
analyze(before, after, path)
// => { reads: string[], writes: Array<{ key, kind }> }
```

Keys have the design-specified `path#qualified.name` form. Writes are `signature`, `body`,
`new`, or `deleted`. A rename intentionally produces `deleted` for the old key and `new` for the
new key; matching a rename is a separate heuristic and must not silently assert identity.

This preserves semantic symbol resolution for calls and type references, while keeping the
sequencer's Worker bundle small and deterministic. The adapter has the full repository checkout
needed for module resolution; the sequencer only needs the already-derived event fields.

B3 contract: expose `analyze` in `packages/analyzer` as an adapter-side function, and make
`analyzeDiff(diff, readFile)` obtain the before/after text from the adapter checkout. The B3
worker must consume, validate, and persist the supplied sets; it should not re-parse TypeScript.

## Prototype and measured corpus

`spikes/analyzer/src/analyzer.ts` uses `typescript.createProgram` and the type checker. It maps
calls, type references, and local imported names to their declaration keys, and compares named
declaration signatures/bodies before and after an edit.

The test corpus has 11 realistic edit scenarios:

| Scenario | Expected result | Result |
|---|---|---|
| Function body edit | body write | pass |
| Function parameter/signature edit | signature write | pass |
| New exported function | new write | pass |
| Function removal | deleted write | pass |
| Rename | old deleted + new | pass |
| Function move with unchanged text | no write | pass |
| Type alias contract edit | signature write | pass |
| Exported variable initializer edit | signature write | pass |
| Local function call | read | pass |
| Local type reference | read | pass |
| Class-method body edit | class + method body writes | pass |

Verified command (Node 24.21.0, TypeScript 4.4.4):

```text
$ NODE_PATH=/usr/local/lib/node_modules node --experimental-strip-types test/run.ts
analyzer corpus: 11/11 cases passed
```

The spike intentionally uses the globally available compiler package because the workspace
scaffold/dependency lockfile does not exist yet. B3 must add a pinned TypeScript dependency; it
must not retain the `NODE_PATH` test setup.

## Compiler API vs web-tree-sitter

| Criterion | TypeScript compiler API | web-tree-sitter |
|---|---|---|
| Symbol identity for calls/types/import aliases | Yes, via type checker | No; syntax only unless Weft builds its own resolver |
| Precise signature/body classification | Yes, based on declaration AST | Yes for spans, but semantics must be implemented separately |
| Cross-file import resolution | Yes with a project compiler host | Not built in |
| Raw runtime payload measured here | `typescript.js`: 9.3 MiB | parser JS 164 KiB + parser WASM 188 KiB + TS grammar WASM 1.4 MiB = about 1.8 MiB |
| Suitable for sequencer Worker | No recommendation: large Node-oriented compiler payload and checkout/module-resolution assumptions | Promising parser payload, but insufficient alone for semantic read sets |

A `web-tree-sitter` 0.24.5 parser plus TypeScript grammar was executed inside a Node Worker
thread, not merely in the main process:

```text
$ node test/worker-runner.mjs
web-tree-sitter Worker: parsed TypeScript (program, 1 function)
```

The Worker fixture and the exact parser/grammar WASM assets are committed under
`spikes/analyzer/`. This proves the parser/WASM combination works in a worker-style JavaScript
runtime. It does **not** prove Cloudflare workerd compatibility: no Cloudflare Worker deployment
or local workerd run was performed in this spike. Before selecting tree-sitter for production,
B3/Sandbox should run the fixture in a `wrangler dev --local` Worker and verify module-WASM asset
loading. The installed Wrangler version was `4.134.0`.

## Mergiraf

Installed and tested locally: Mergiraf 0.20.0 (Homebrew formula, GPL-3.0-only). `mergiraf
languages` lists both `Typescript (*.ts, *.mts, *.cts)` and `Typescript (TSX) (*.tsx)`.

A three-way merge changed `alpha` on the left and `beta` on the right in the same physical
line of a `.ts` file. `git merge-file` returned exit code 1 and produced conflict markers;
Mergiraf structurally resolved that same conflict with no markers:

```text
$ git merge-file git-merged.ts base.ts right.ts
# exit 1; <<<<<<<, =======, and >>>>>>> present
$ mergiraf merge base.ts left.ts right.ts --output merged.ts
INFO Mergiraf: Solved 1 conflict.
$ grep -Ec '<<<<<<<|=======|>>>>>>>' merged.ts
0

export function alpha() { return 10; } export function beta() { return 20; }
```

Mergiraf is a native Rust CLI/merge driver, not a Worker library. It is appropriate for the
Sandbox/container rebase step described in the design, not the sequencer. The installed binary is
macOS arm64, so it cannot be used as evidence of Linux execution. Docker is installed but its
daemon was unavailable on this host, so no Linux-container run was possible. The source project
is Rust and Mergiraf publishes platform-specific packages; provision/build its Linux binary in
the Sandbox image, then repeat the committed fixture there before claiming container support.

## Known limits

- The prototype's single-file compiler host intentionally has no package/module resolution; B3
  should use the adapter's real `tsconfig` and program host for imported symbols.
- Interface/type-member edits are conservatively `signature`; exported constants' initializer
  edits are also conservatively `signature`.
- Formatting-only edits to a declaration body currently count as a body write. Hash normalized
  syntax, not source text, if that becomes noisy in observed events.
- No unified-diff parser is included in the spike. `analyzeDiff` belongs in B3 because it needs
  the adapter's repository-aware `readFile` contract.
