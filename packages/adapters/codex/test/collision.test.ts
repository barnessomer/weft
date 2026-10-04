import { describe, expect, it } from "vitest";
import { ReferenceCoordinator } from "@weft/protocol";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeChanges, unifiedDiff } from "../src/analysis";
import { CodexAdapter, type HookInput } from "../src/hooks";
import { applyChunks, parsePatch, patchPaths, proposedFiles, shellPatch } from "../src/edits";
import type { Loaded } from "../src/config";
import type { Transport } from "../src/client";
import { CART_V1, PRICING_V1, PRICING_V2, checkout, refTransport } from "./helpers";

function adapter(root: string, agent: string, task: string, transport: Transport): CodexAdapter {
  const loaded: Loaded = { root, token: "test", config: { url: "http://unused", repo: "demo", agent, task: { id: task, title: `${task} work` }, change: `I-${agent}` } };
  let t = 1_790_000_000_000;
  return new CodexAdapter(loaded, { transport, analyze: (c, r, p) => analyzeChanges(c, r, p), diff: (rel, b, a) => unifiedDiff(rel, b, a), now: () => (t += 5_000) });
}
const hook = (session: string, cwd: string, extra: Partial<HookInput>): HookInput => ({ hook_event_name: "PreToolUse", session_id: session, cwd, ...extra });

/** Run one apply_patch the way Codex does: PreToolUse, apply (unless denied), PostToolUse. */
async function applyPatch(a: CodexAdapter, session: string, root: string, id: string, command: string) {
  const pre = (await a.handle(hook(session, root, { tool_name: "apply_patch", tool_input: { command }, tool_use_id: id }))) as any;
  if (pre?.hookSpecificOutput?.permissionDecision === "deny") return { pre, post: undefined, applied: false };
  for (const f of proposedFiles(command, (p) => {
    try {
      return readFileSync(resolve(root, p), "utf8");
    } catch {
      return null;
    }
  })) {
    if (typeof f.after === "string") writeFileSync(resolve(root, f.path), f.after);
  }
  const post = (await a.handle(hook(session, root, { hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { command }, tool_use_id: id, tool_response: "Success" }))) as any;
  return { pre, post, applied: true };
}

describe("apply_patch grammar", () => {
  it("parses add/update/delete/move and applies update hunks like Codex", () => {
    const cmd = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@ export function f() {",
      "-  return 1;",
      "+  return 2;",
      "*** Add File: src/b.ts",
      "+export const b = 1;",
      "*** Delete File: src/c.ts",
      "*** Update File: src/d.ts",
      "*** Move to: src/e.ts",
      "@@",
      " x",
      "*** End Patch",
    ].join("\n");
    const ops = parsePatch(cmd);
    expect(ops.map((o) => `${o.kind}:${o.path}`)).toEqual(["update:src/a.ts", "add:src/b.ts", "delete:src/c.ts", "update:src/d.ts"]);
    expect(patchPaths({ command: cmd })).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]);
    const files: Record<string, string> = { "src/a.ts": "export function f() {\n  return 1;\n}\n", "src/c.ts": "x\n", "src/d.ts": "x\n" };
    const out = proposedFiles(cmd, (p) => files[p] ?? null);
    expect(out).toEqual([
      { path: "src/a.ts", before: files["src/a.ts"], after: "export function f() {\n  return 2;\n}\n" },
      { path: "src/b.ts", before: null, after: "export const b = 1;\n" },
      { path: "src/c.ts", before: "x\n", after: null },
      { path: "src/d.ts", before: "x\n", after: null },
      { path: "src/e.ts", before: null, after: "x\n" },
    ]);
  });

  it("tolerates whitespace drift, appends pure additions, and reports non-applying hunks", () => {
    expect(applyChunks("a\n  b  \nc\n", [{ old: ["b"], new: ["B"], eof: false }])).toBe("a\nB\nc\n");
    expect(applyChunks("a\n", [{ old: [], new: ["z"], eof: false }])).toBe("a\nz\n");
    expect(applyChunks("a\n", [{ old: ["nope"], new: ["x"], eof: false }])).toBeUndefined();
  });
});

describe("apply_patch through the shell", () => {
  it("extracts heredoc and argv forms, with an optional cd", () => {
    const body = "*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch";
    expect(shellPatch(`apply_patch <<'PATCH'\n${body}\nPATCH`)).toEqual({ patch: body });
    expect(shellPatch(`cd src && applypatch <<"EOF"\n${body}\nEOF`)).toEqual({ patch: body, cd: "src" });
    expect(shellPatch(`apply_patch '${body}'`)).toEqual({ patch: body });
    expect(shellPatch("cat README.md")).toBeUndefined();
    expect(shellPatch("echo apply_patch")).toBeUndefined();
  });
});

describe("Codex hooks against the reference coordinator", () => {
  it("A changes a signature; B's apply_patch Update adding a stale call is denied at PreToolUse; B adapts", async () => {
    const coord = new ReferenceCoordinator({ repo: "demo", now: () => 1_790_000_000_000 });
    const t = refTransport(coord);
    const rootA = checkout("a");
    const rootB = checkout("b");
    const A = adapter(rootA, "codex-a", "T-1", t);
    const B = adapter(rootB, "codex-b", "T-2", t);

    await B.handle(hook("sb", rootB, { hook_event_name: "SessionStart", source: "startup" }));
    await A.handle(hook("sa", rootA, { hook_event_name: "SessionStart", source: "startup" }));
    const sig = [
      "*** Begin Patch",
      `*** Update File: ${join(rootA, "src/pricing.ts")}`,
      "@@",
      " export type Item = { price: number; qty: number };",
      "+export type PriceOptions = { taxRate: number };",
      " ",
      "-export function calcTotal(items: Item[]): number {",
      "-  return items.reduce((sum, i) => sum + i.price * i.qty, 0);",
      "+export function calcTotal(items: Item[], opts: PriceOptions): number {",
      "+  const net = items.reduce((sum, i) => sum + i.price * i.qty, 0);",
      "+  return net * (1 + opts.taxRate);",
      " }",
      "*** End Patch",
    ].join("\n");
    const a = await applyPatch(A, "sa", rootA, "a1", sig);
    expect(a.applied).toBe(true);
    expect(readFileSync(join(rootA, "src/pricing.ts"), "utf8")).toBe(PRICING_V2);
    expect(coord.log.some((e) => e.agent === "codex-a" && e.status === "accepted" && e.writes?.some((w) => w.key === "src/pricing.ts#calcTotal" && w.kind === "signature"))).toBe(true);

    // B (relative path, cwd = checkout) writes the call the old way
    const stale = ["*** Begin Patch", "*** Update File: src/cart.ts", "@@", "-  return `${items.length} items`;", "+  return `${items.length} items, total ${calcTotal(items)}`;", "*** End Patch"].join("\n");
    const b1 = await applyPatch(B, "sb", rootB, "b1", stale);
    expect(b1.applied).toBe(false);
    const reason: string = b1.pre.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toMatch(/\[weft error\] stale_assumption src\/cart\.ts:4:\d+/);
    expect(reason).toContain("+export function calcTotal(items: Item[], opts: PriceOptions): number {");
    expect(readFileSync(join(rootB, "src/cart.ts"), "utf8")).toBe(CART_V1);

    // B adapts to the new signature: accepted, committed with its diff
    const fixed = stale.replace("calcTotal(items)", "calcTotal(items, { taxRate: 0 })");
    const b2 = await applyPatch(B, "sb", rootB, "b2", fixed);
    expect(b2.applied).toBe(true);
    const last = coord.log.at(-1)!;
    expect(last).toMatchObject({ agent: "codex-b", status: "accepted", kind: "edit" });
    expect(PRICING_V1).not.toBe(PRICING_V2);
  });

  it("same collision when the model sends apply_patch through Bash and Codex fires no PostToolUse", async () => {
    const coord = new ReferenceCoordinator({ repo: "demo", now: () => 1_790_000_000_000 });
    const t = refTransport(coord);
    const rootA = checkout("sa");
    const rootB = checkout("sb");
    const A = adapter(rootA, "codex-a", "T-1", t);
    const B = adapter(rootB, "codex-b", "T-2", t);
    await B.handle(hook("sb", rootB, { hook_event_name: "SessionStart", source: "startup" }));
    await A.handle(hook("sa", rootA, { hook_event_name: "SessionStart", source: "startup" }));
    writeFileSync(join(rootA, "src/pricing.ts"), PRICING_V2);
    const sigPatch = `*** Begin Patch\n*** Update File: src/pricing.ts\n@@\n-export function calcTotal(items: Item[]): number {\n+export function calcTotal(items: Item[], opts: PriceOptions): number {\n*** End Patch`;
    // A: native tool, edit already on disk -> PostToolUse commits it (before = HEAD)
    await A.handle(hook("sa", rootA, { hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { command: sigPatch }, tool_use_id: "a1", tool_response: "ok" }));
    expect(coord.log.some((e) => e.agent === "codex-a" && e.status === "accepted" && e.writes?.some((w) => w.key === "src/pricing.ts#calcTotal" && w.kind === "signature"))).toBe(true);

    const patch = (call: string) => `*** Begin Patch\n*** Update File: src/cart.ts\n@@\n-  return \`\${items.length} items\`;\n+  return \`\${items.length} items, total \${${call}}\`;\n*** End Patch`;
    const bash = (cmd: string, id: string, event = "PreToolUse") => B.handle(hook("sb", rootB, { hook_event_name: event, tool_name: "Bash", tool_input: { command: cmd }, tool_use_id: id }));
    const denied = (await bash(`apply_patch <<'PATCH'\n${patch("calcTotal(items)")}\nPATCH`, "b1")) as any;
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("stale_assumption");

    const ok = await bash(`apply_patch <<'PATCH'\n${patch("calcTotal(items, { taxRate: 0 })")}\nPATCH`, "b2");
    expect((ok as any)?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    // Codex applies it; no PostToolUse arrives. The next hook commits the edit from disk.
    const p = join(rootB, "src/cart.ts");
    writeFileSync(p, readFileSync(p, "utf8").replace("return `${items.length} items`;", "return `${items.length} items, total ${calcTotal(items, { taxRate: 0 })}`;"));
    const before = coord.log.length;
    await bash('node --test "test/**/*.test.ts"', "b3");
    const committed = coord.log.slice(before).find((e) => e.agent === "codex-b" && e.kind === "edit");
    expect(committed).toMatchObject({ status: "accepted", mode: "commit", files: ["src/cart.ts"] });
  });
});
