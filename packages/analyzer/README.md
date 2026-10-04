# @weft/analyzer

`@weft/analyzer` derives the TypeScript read/write sets sent with a WCP edit event.

## Runtime boundary

Run this package in the adapter that observes the filesystem edit, not in the sequencer Durable Object / Worker. It intentionally uses the TypeScript compiler API, which needs the adapter checkout and is unsuitable for the sequencer's small, deterministic Worker bundle. The adapter sends the returned `reads` and `writes` as event fields; the sequencer validates and persists them without parsing TypeScript.

## API

```ts
import { analyze, analyzeDiff } from "@weft/analyzer";

const oneFile = analyze(beforeText, afterText, "src/auth/session.ts");

const fromGitDiff = analyzeDiff(diff, (path) => checkout.readFile(path));
```

`analyze(before, after, path)` returns:

```ts
{
  reads: string[],
  writes: Array<{ key: string; kind: "signature" | "body" | "new" | "deleted" }>
}
```

Keys use the WCP format `path#qualified.name`. `analyzeDiff` accepts a standard unified git diff and a synchronous function that returns the current, post-edit contents of the requested path (or `undefined` for a deleted path). It reverses diff hunks to reconstruct the previous contents. Only TypeScript files (`.ts`, `.tsx`, `.mts`, `.cts`) are analyzed.

The analyzer intentionally treats renames as `deleted` plus `new`; it does not infer identity. It uses a single-file program today, so cross-file import resolution remains an adapter integration extension.
