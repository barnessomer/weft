// Bash reconciliation (issue #8a): a Bash call can change files without any Edit/Write hook
// (shell redirects, cp, sed, heredocs, ln). These tests run the real bundle, as Claude Code
// does, with the shell command actually executed between the PreToolUse and PostToolUse hooks.
import { describe, expect, it, afterAll } from "vitest";
import { ReferenceCoordinator } from "@weft/protocol";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRICING_V1, PRICING_V2, checkout, serve } from "./helpers";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-claude.mjs");
const run = promisify(execFile);
const SID = "c-bash";
const servers: Array<{ close: () => void }> = [];
afterAll(() => servers.forEach((s) => s.close()));

const CART_V2 = `import type { Item } from "./pricing";

export function cartSummary(items: Item[], label: string): string {
  return \`\${label}: \${items.length} items\`;
}
`;

type Ev = { kind: string; files: string[] };

type Bed = { root: string; coord: ReferenceCoordinator; outside: string };

/** A coordinated checkout (installed through the bundle) plus a scratch dir outside it. */
async function bed(name: string): Promise<Bed> {
  const coord = new ReferenceCoordinator({ repo: "demo" });
  const { url, server } = await serve(coord);
  servers.push(server);
  const root = checkout(name);
  await run(process.execPath, [BUNDLE, "install", "--url", url, "--repo", "demo", "--agent", "claude-b", "--task", "T-8", "--title", "bash work"], {
    cwd: root,
    env: { ...process.env, WEFT_TOKEN: "local-test-token" },
  });
  const outside = mkdtempSync(join(tmpdir(), "weft-outside-"));
  return { root, coord, outside };
}

/** One hook invocation: JSON on stdin, the hook's JSON output (or undefined) back. */
async function hook(root: string, input: Record<string, unknown>): Promise<Record<string, any> | undefined> {
  const child = run(process.execPath, [BUNDLE, "hook"], { cwd: root, encoding: "utf8" });
  child.child.stdin!.end(JSON.stringify({ cwd: root, session_id: SID, ...input }));
  const { stdout } = await child;
  return stdout.trim() ? JSON.parse(stdout) : undefined;
}

async function start(b: Bed): Promise<void> {
  await hook(b.root, { hook_event_name: "SessionStart", source: "startup" });
}

/** A Bash tool call as Claude Code runs it: Pre hook, the real shell command, Post hook. */
async function bash(b: Bed, id: string, command: string): Promise<void> {
  await hook(b.root, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: id });
  await run("sh", ["-c", command], { cwd: b.root });
  await hook(b.root, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: id, tool_response: {} });
}

/** A Bash tool call that fails: Pre hook, the shell command (non-zero exit), PostToolUseFailure. */
async function bashFails(b: Bed, id: string, command: string): Promise<void> {
  await hook(b.root, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: id });
  await run("sh", ["-c", command], { cwd: b.root }).then(
    () => {
      throw new Error("expected the command to fail");
    },
    () => undefined,
  );
  await hook(b.root, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, tool_use_id: id, error: "Command exited with non-zero status code 1" });
}

/** Edit events the coordinator recorded for this checkout. */
function edits(b: Bed): Ev[] {
  return (b.coord.events(0, 1000).events as Ev[]).filter((e) => e.kind === "edit");
}

function logOf(root: string): string {
  try {
    return readFileSync(join(root, ".weft", "log", "adapter.log"), "utf8");
  } catch {
    return "";
  }
}

describe("Bash reconciliation: files a shell command changes are coordinated (issue #8a)", () => {
  it("(a) a file a shell command writes in the checkout gets an edit event", async () => {
    const b = await bed("bash-a");
    await start(b);
    const v2 = join(b.outside, "pricing-v2.ts");
    writeFileSync(v2, PRICING_V2);
    await bash(b, "bash-a1", `cp ${v2} src/pricing.ts`);
    expect(edits(b).map((e) => e.files)).toContainEqual(["src/pricing.ts"]);
  }, 30_000);

  it("(b) a symlink a shell command creates to a file outside the checkout is unreadable: logged, never submitted", async () => {
    const b = await bed("bash-b");
    await start(b);
    const secret = join(b.outside, "secret.ts");
    writeFileSync(secret, `export const TOKEN = "outside-secret-7731";\nexport function leakFn(a: number, b: number): number {\n  return a + b;\n}\n`);
    await bash(b, "bash-b1", `ln -s ${secret} src/leak.ts`);
    expect(logOf(b.root)).toContain("unreadable src/leak.ts");
    expect(edits(b).some((e) => e.files.includes("src/leak.ts"))).toBe(false);
    expect(JSON.stringify(b.coord.events(0, 1000, { include_diff: true }).events)).not.toContain("outside-secret-7731");
  }, 30_000);

  it("(c) two files changed by one Bash call are two edit events", async () => {
    const b = await bed("bash-c");
    await start(b);
    const v2 = join(b.outside, "pricing-v2.ts");
    const cart2 = join(b.outside, "cart-v2.ts");
    writeFileSync(v2, PRICING_V2);
    writeFileSync(cart2, CART_V2);
    await bash(b, "bash-c1", `cp ${v2} src/pricing.ts && cp ${cart2} src/cart.ts`);
    expect(edits(b).map((e) => e.files[0]).sort()).toEqual(["src/cart.ts", "src/pricing.ts"]);
  }, 30_000);

  it("(d) a file a Bash call edits and commits in one go is coordinated", async () => {
    const b = await bed("bash-d");
    await start(b);
    const v2 = join(b.outside, "pricing-v2.ts");
    writeFileSync(v2, PRICING_V2);
    await bash(b, "bash-d1", `cp ${v2} src/pricing.ts && git add src/pricing.ts && git commit -qm "pricing: tax option"`);
    expect(edits(b).map((e) => e.files)).toContainEqual(["src/pricing.ts"]);
  }, 30_000);

  it("(e) an Edit through a symlink is logged unreadable and not submitted", async () => {
    const b = await bed("bash-e");
    await start(b);
    const target = join(b.outside, "target.ts");
    writeFileSync(target, PRICING_V1);
    symlinkSync(target, join(b.root, "src/link.ts"));
    const oldS = "export function calcTotal(items: Item[]): number {";
    const newS = "export function calcTotal(items: Item[], opts: { taxRate: number }): number {";
    const input = { file_path: join(b.root, "src/link.ts"), old_string: oldS, new_string: newS };
    await hook(b.root, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: input, tool_use_id: "e1" });
    writeFileSync(join(b.root, "src/link.ts"), PRICING_V1.replace(oldS, newS)); // lands in the outside file
    await hook(b.root, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: input, tool_use_id: "e1", tool_response: {} });
    expect(logOf(b.root)).toContain("unreadable src/link.ts");
    expect(edits(b).some((e) => e.files.includes("src/link.ts"))).toBe(false);
  }, 30_000);
});

describe("Bash failures are reconciled too (issue #8b)", () => {
  it("a Bash call that writes a file and then fails still produces an edit event for it", async () => {
    const b = await bed("bash-fail");
    await start(b);
    const v2 = join(b.outside, "pricing-v2.ts");
    writeFileSync(v2, PRICING_V2);
    await bashFails(b, "bash-f1", `cp ${v2} src/pricing.ts && false`);
    expect(edits(b).map((e) => e.files)).toContainEqual(["src/pricing.ts"]);
  }, 30_000);

  it("install registers the failure hook for Bash", async () => {
    const b = await bed("bash-settings");
    const settings = JSON.parse(readFileSync(join(b.root, ".claude/settings.local.json"), "utf8")) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };
    const entry = settings.hooks.PostToolUseFailure?.find((e) => e.hooks.some((h) => h.command.includes("weft-claude")));
    expect(entry?.matcher).toBe("Bash");
  }, 30_000);
});
