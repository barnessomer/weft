// Read guard: the edit hooks read the checkout file before and after an edit. A file that exists
// but may not be read (symlink, unreadable, over the size cap) must never be read as absent: that
// would submit a deletion, or an edit against a HEAD baseline. Real bundle.
import { describe, expect, it, afterAll } from "vitest";
import { ReferenceCoordinator } from "@weft/protocol";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRICING_V1, checkout, serve } from "./helpers";

const BUNDLE = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "weft-claude.mjs");
const run = promisify(execFile);
const SID = "c-guard";
const servers: Array<{ close: () => void }> = [];
afterAll(() => servers.forEach((s) => s.close()));

type Bed = { root: string; coord: ReferenceCoordinator; outside: string };

async function bed(name: string): Promise<Bed> {
  const coord = new ReferenceCoordinator({ repo: "demo" });
  const { url, server } = await serve(coord);
  servers.push(server);
  const root = checkout(name);
  await run(process.execPath, [BUNDLE, "install", "--url", url, "--repo", "demo", "--agent", "claude-b", "--task", "T-8a"], {
    cwd: root,
    env: { ...process.env, WEFT_TOKEN: "local-test-token" },
  });
  return { root, coord, outside: mkdtempSync(join(tmpdir(), "weft-outside-")) };
}

async function hook(root: string, input: Record<string, unknown>): Promise<void> {
  const child = run(process.execPath, [BUNDLE, "hook"], { cwd: root, encoding: "utf8" });
  child.child.stdin!.end(JSON.stringify({ cwd: root, session_id: SID, ...input }));
  await child;
}

const editedFiles = (b: Bed) =>
  (b.coord.events(0, 1000).events as Array<{ kind: string; files: string[] }>).filter((e) => e.kind === "edit").flatMap((e) => e.files);

function logOf(root: string): string {
  try {
    return readFileSync(join(root, ".weft", "log", "adapter.log"), "utf8");
  } catch {
    return "";
  }
}

const OLD = "export function calcTotal(items: Item[]): number {";
const NEW = "export function calcTotal(items: Item[], opts: { taxRate: number }): number {";

/** One Edit call as Claude Code runs it; `between` runs where the tool would write. */
async function edit(b: Bed, rel: string, between: () => void): Promise<void> {
  await hook(b.root, { hook_event_name: "SessionStart", source: "startup" });
  const input = { file_path: join(b.root, rel), old_string: OLD, new_string: NEW };
  await hook(b.root, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: input, tool_use_id: "e1" });
  between();
  await hook(b.root, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: input, tool_use_id: "e1", tool_response: {} });
}

describe("read guard: symlinks, unreadable and oversized files are never read as absent (#19)", () => {
  it("an Edit through a symlink to a file outside the checkout is logged unreadable and not submitted", async () => {
    const b = await bed("guard-link");
    const target = join(b.outside, "target.ts");
    writeFileSync(target, PRICING_V1);
    symlinkSync(target, join(b.root, "src/link.ts"));
    await edit(b, "src/link.ts", () => writeFileSync(join(b.root, "src/link.ts"), PRICING_V1.replace(OLD, NEW)));
    expect(logOf(b.root)).toContain("unreadable src/link.ts");
    expect(editedFiles(b)).not.toContain("src/link.ts");
  }, 30_000);

  it("an Edit under a symlinked directory is logged unreadable and not submitted", async () => {
    const b = await bed("guard-dirlink");
    mkdirSync(join(b.outside, "lib"));
    writeFileSync(join(b.outside, "lib", "p.ts"), PRICING_V1);
    symlinkSync(join(b.outside, "lib"), join(b.root, "src/lib"));
    await edit(b, "src/lib/p.ts", () => writeFileSync(join(b.root, "src/lib/p.ts"), PRICING_V1.replace(OLD, NEW)));
    expect(logOf(b.root)).toContain("unreadable src/lib/p.ts");
    expect(editedFiles(b)).not.toContain("src/lib/p.ts");
  }, 30_000);

  it("a new file under a symlinked directory is not read as absent (no check, no edit submitted)", async () => {
    const b = await bed("guard-dirlink-new");
    mkdirSync(join(b.outside, "lib"));
    symlinkSync(join(b.outside, "lib"), join(b.root, "src/lib"));
    await edit(b, "src/lib/new.ts", () => writeFileSync(join(b.root, "src/lib/new.ts"), PRICING_V1));
    expect(logOf(b.root)).toContain("unreadable src/lib/new.ts; not coordinated");
    expect(logOf(b.root)).not.toContain("check src/lib/new.ts"); // the proposed text is never sent
    expect(editedFiles(b)).not.toContain("src/lib/new.ts");
  }, 30_000);

  it("a file that becomes unreadable after the edit is not submitted as a deletion", async () => {
    const b = await bed("guard-eacces");
    const p = join(b.root, "src/pricing.ts");
    await edit(b, "src/pricing.ts", () => {
      writeFileSync(p, PRICING_V1.replace(OLD, NEW));
      chmodSync(p, 0o000);
    });
    chmodSync(p, 0o644);
    expect(logOf(b.root)).toContain("unreadable src/pricing.ts after the edit");
    expect(editedFiles(b)).not.toContain("src/pricing.ts");
  }, 30_000);

  it("a file that grows over the size cap is not submitted as a deletion", async () => {
    const b = await bed("guard-big");
    await edit(b, "src/pricing.ts", () =>
      writeFileSync(join(b.root, "src/pricing.ts"), PRICING_V1.replace(OLD, NEW) + "//" + "x".repeat(1 << 20)),
    );
    expect(logOf(b.root)).toContain("unreadable src/pricing.ts after the edit");
    expect(editedFiles(b)).not.toContain("src/pricing.ts");
  }, 30_000);

  it("a file over the cap before the edit is not submitted after it shrinks (no HEAD baseline)", async () => {
    const b = await bed("guard-shrink");
    const p = join(b.root, "src/pricing.ts");
    writeFileSync(p, PRICING_V1 + "//" + "x".repeat(1 << 20));
    await edit(b, "src/pricing.ts", () => writeFileSync(p, PRICING_V1.replace(OLD, NEW)));
    expect(logOf(b.root)).toContain("unreadable src/pricing.ts before the edit");
    expect(editedFiles(b)).not.toContain("src/pricing.ts");
  }, 30_000);

  it("an in-checkout symlink replaced by a regular file during the edit is not submitted", async () => {
    const b = await bed("guard-replaced-link");
    writeFileSync(join(b.root, "src/real.ts"), PRICING_V1);
    symlinkSync(join(b.root, "src/real.ts"), join(b.root, "src/alias.ts"));
    await edit(b, "src/alias.ts", () => {
      unlinkSync(join(b.root, "src/alias.ts"));
      writeFileSync(join(b.root, "src/alias.ts"), PRICING_V1.replace(OLD, NEW));
    });
    expect(logOf(b.root)).toContain("unreadable src/alias.ts before the edit");
    expect(editedFiles(b)).not.toContain("src/alias.ts");
  }, 30_000);
});
