import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, importReads } from "./analyze-cli";

describe("analyze-cli handle()", () => {
  it("classifies signature/body/new writes and keeps reads", () => {
    const res = handle({
      files: [
        {
          path: "src/a.ts",
          before: "export function f(a: number) { return a }\nexport function g() { return 1 }\n",
          after: "export function f(a: number, b = 2) { return a + b }\nexport function g() { return 2 }\nexport const k = 1;\n",
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.writes).toEqual(
      expect.arrayContaining([
        { key: "src/a.ts#f", kind: "signature" },
        { key: "src/a.ts#g", kind: "body" },
        { key: "src/a.ts#k", kind: "new" },
      ]),
    );
    expect(res.analyzed).toEqual(["src/a.ts"]);
  });

  it("skips files the TS analyzer does not understand", () => {
    const res = handle({ files: [{ path: "docs/design.md", before: "a", after: "b" }] });
    expect(res).toMatchObject({ ok: true, writes: [], analyzed: [] });
  });

  it("reports bad requests instead of throwing", () => {
    expect(handle({} as never)).toMatchObject({ ok: false });
  });
});

describe("importReads()", () => {
  it("turns relative imports into cross-file reads", () => {
    const text = [
      'import { f, g as gg } from "./a.js";',
      'import * as ns from "./c";',
      'import D from "../d";',
      'import { external } from "node:fs";',
      "export function h(x: ns.T) { return f(3) + ns.k() + gg() }",
    ].join("\n");
    expect(importReads(text, "src/b.ts").sort()).toEqual(
      ["d.ts#default", "src/a.ts#f", "src/a.ts#g", "src/c.ts#T", "src/c.ts#k"].sort(),
    );
  });

  it("resolves against the checkout (index files, prefix)", () => {
    const root = mkdtempSync(join(tmpdir(), "weft-imports-"));
    mkdirSync(join(root, "src/lib"), { recursive: true });
    writeFileSync(join(root, "src/lib/index.ts"), "export const x = 1;\n");
    const reads = importReads('import { x } from "./lib";\n', "ios/src/b.ts", root, "ios/");
    expect(reads).toEqual(["ios/src/lib/index.ts#x"]);
    expect(importReads('import { y } from "./missing";\n', "src/b.ts", root)).toEqual([]);
  });

  it("feeds handle(): an edit reading an imported symbol lists it", () => {
    const res = handle({
      files: [{ path: "src/api/client.ts", before: "", after: 'import { refreshToken } from "../auth/session";\nexport function fetchWithAuth() { return refreshToken() }\n' }],
    });
    expect(res.ok && res.reads).toContain("src/auth/session.ts#refreshToken");
  });
});
