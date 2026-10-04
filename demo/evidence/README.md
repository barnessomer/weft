# Evidence: two real Claude Code sessions vs one Weft coordinator

Produced by `node demo/claude-collision.mjs [stop-gate]` on 2026-10-04 (Claude Code 2.1.289,
headless `claude -p --output-format stream-json --include-hook-events`), against the live
preview gateway `https://weft-gateway-preview.redacted-subdomain.workers.dev`. Each run
creates a fresh coordinator repo, two git worktrees of `demo/ts-shop` (one per agent, so
neither sees the other's edits on disk), mints agent tokens (never printed), and installs
this adapter in both with `weft-adapter-claude install`.

Scenario (design §8.2):

1. **claude-b** (task T-2) reads `src/pricing.ts` + `src/cart.ts` and plans
   `total(): number { return calcTotal(this.items); }` — no edits (`b1-plan.jsonl`).
2. **claude-a** (task T-1) changes `calcTotal(items)` → `calcTotal(items, opts: PriceOptions)`
   in its checkout and updates its caller (`a-signature.jsonl`). Accepted as log #4.
3. **claude-b** resumes the same conversation (`--resume`) and implements its plan
   (`b2-implement.jsonl`).

## `claude-collision/` — B receives the squiggle and changes course

Coordinator log (`coordinator-log.json`):

```
#4   accepted edit  commit base#3  claude-a changed signature of calcTotal, added calcTotal.net, PriceOptions in src/pricing.ts — Apply tax in calcTotal
#9   rejected edit  check  base#1  Blocked: claude-b edited Cart, added Cart.total in src/cart.ts — Show the cart total   [error stale_assumption src/pricing.ts#calcTotal <- #4]
#10  accepted edit  commit base#9  claude-b edited Cart in src/cart.ts — Show the cart total
#11  accepted edit  commit base#9  claude-b edited Cart, added Cart.total in src/cart.ts — Show the cart total
```

B's first `Edit` (adds `return calcTotal(this.items);`) was denied by the PreToolUse hook; the
tool result Claude saw (verbatim from `b2-implement.jsonl`):

```
PreToolUse:Edit hook error: [weft] Edit to src/cart.ts blocked: it conflicts with another agent's change (Weft edit-time coordination, log #9).
[weft error] stale_assumption src/cart.ts:15:12: You use src/pricing.ts#calcTotal, whose signature changed in #4 by claude-a after your base #1. (caused by claude-a · task T-1 · event #4). Suggestion: Read the new src/pricing.ts#calcTotal (event #4) and update this call site, or negotiate with claude-a.
  ↳ event #4 by claude-a changed src/pricing.ts (their change is not in your checkout yet):
    @@ -1,6 +1,9 @@
     export type Item = { sku: string; price: number; qty: number };
     
    -/** Sum of price × quantity over the cart. */
    -export function calcTotal(items: Item[]): number {
    -  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
    +export type PriceOptions = { taxRate: number };
    +
    +/** Sum of price × quantity over the cart, including tax. */
    +export function calcTotal(items: Item[], opts: PriceOptions): number {
    +  const net = items.reduce((sum, item) => sum + item.price * item.qty, 0);
    +  return net * (1 + opts.taxRate);
     }
```

B then said "claude-a changed `calcTotal` to require `opts: PriceOptions`. To keep
`total(): number` as specified without inventing a tax rate, the cart will take its
`PriceOptions` in the constructor", made two edits (both accepted, #10/#11), and finished:

> **What changed from the plan:** Weft blocked my first attempt because claude-a (task T-1)
> changed `calcTotal` to `calcTotal(items, opts: PriceOptions)` to add tax, so `Cart` now takes
> a required `PriceOptions` argument in its constructor and passes it to `calcTotal`.

`landing.txt`: both branches committed through the installed git hooks (trailers
`Change-Id`/`Task-Id`/`Agent-Id` present); B's checkout alone fails `tsc` (it is written
against A's in-flight signature, `Expected 1 arguments, but got 2`), and **`main` after merging
agent-a then agent-b typechecks clean (`tsc: exit 0`)** — the conflict was resolved at edit
time, before any commit existed.

## `claude-stop-gate/` — L3: B is told to give up; Weft won't let it finish

Same setup, but B's turn-2 prompt says "if a hook blocks one of your edits, do not retry or
adapt anything: reply with what the hook said and end your turn". B obeyed the user, so the
Stop hook refused to let it finish five times (`decision:"block"`, reason = the open
`stale_assumption` with A's diff), then the runaway guard let it stop (`adapter-b.log`):

```
check src/cart.ts base #1 -> reject #8 (stale_assumption)
stop gate refused #1 … #5 (stale_assumption:src/pricing.ts#calcTotal)
stop gate: letting Claude stop after 5 refusals; open errors stay visible in the feed
session end: keeping s3 open (1 open errors)
```

Because the session kept its open error past SessionEnd, the git **pre-commit gate refused
B's commit** (`landing.txt`): `agent-b: commit refused: weft: commit refused — 1 open
error(s): [weft error] stale_assumption src/pricing.ts:4:17: …`.

## Files

Per scenario: `*.prompt.txt` (exact prompts), `b1-plan.jsonl`, `a-signature.jsonl`,
`b2-implement.jsonl` (full stream-json transcripts incl. hook events), `adapter-{a,b}.log`,
`coordinator-log.json` (observer API dump incl. diffs), `install.txt`, `landing.txt`, `run.json`.
