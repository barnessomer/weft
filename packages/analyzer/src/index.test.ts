import { describe, expect, it } from "vitest";
import { analyze, analyzeDiff } from "./index.js";

const path = "src/math.ts";

describe("@weft/analyzer", () => {
  const corpus = [
    ["body change", "export function add(a: number, b: number) { return a + b; }", "export function add(a: number, b: number) { return a - b; }", [["src/math.ts#add", "body"]]],
    ["signature change", "export function add(a: number) { return a; }", "export function add(a: number, b = 0) { return a + b; }", [["src/math.ts#add", "signature"]]],
    ["new export", "export const a = 1;", "export const a = 1; export function twice(n: number) { return n * 2; }", [["src/math.ts#twice", "new"]]],
    ["deleted function", "export function old() { return 1; }", "", [["src/math.ts#old", "deleted"]]],
    ["rename reports delete and new", "export function oldName() { return 1; }", "export function newName() { return 1; }", [["src/math.ts#newName", "new"], ["src/math.ts#oldName", "deleted"]]],
    ["moved function retains key", "\n\nexport function stable() { return 1; }", "export function stable() { return 1; }\n\n", []],
    ["type alias contract", "export type User = { id: string };", "export type User = { id: string; name: string };", [["src/math.ts#User", "signature"]]],
    ["variable initializer is signature-level", "export const limit = 10;", "export const limit = 20;", [["src/math.ts#limit", "signature"]]],
    ["class method body", "export class Box { value() { return 1; } }", "export class Box { value() { return 2; } }", [["src/math.ts#Box", "body"], ["src/math.ts#Box.value", "body"]]],
  ] as const;

  it.each(corpus)("classifies %s", (_name, before, after, writes) => {
    expect(analyze(before, after, path).writes.map(({ key, kind }) => [key, kind])).toEqual(writes);
  });

  it("finds local call and type reads", () => {
    const result = analyze(
      "function helper() { return 1; } type Token = string; export function f(x: Token) { return helper(); }",
      "function helper() { return 1; } type Token = string; export function f(x: Token) { return helper(); }",
      path,
    );
    expect(result.reads).toEqual(["src/math.ts#Token", "src/math.ts#helper"]);
  });

  it("analyzes a modified file from a unified diff and current checkout contents", () => {
    const after = "export function add(a: number) {\n  return a - 1;\n}\n";
    const diff = [
      "diff --git a/src/math.ts b/src/math.ts",
      "--- a/src/math.ts",
      "+++ b/src/math.ts",
      "@@ -1,3 +1,3 @@",
      " export function add(a: number) {",
      "-  return a + 1;",
      "+  return a - 1;",
      " }",
      "",
    ].join("\n");
    expect(analyzeDiff(diff, (file) => file === path ? after : undefined)).toEqual({
      reads: [], writes: [{ key: "src/math.ts#add", kind: "body" }],
    });
  });

  it("analyzes additions and deletions without treating a non-TypeScript diff as source", () => {
    const diff = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+export function fresh() { return 1; }",
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export function old() { return 1; }",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    expect(analyzeDiff(diff, (file) => file === "src/new.ts" ? "export function fresh() { return 1; }" : undefined)).toEqual({
      reads: [],
      writes: [
        { key: "src/new.ts#fresh", kind: "new" },
        { key: "src/old.ts#old", kind: "deleted" },
      ],
    });
  });

  it("rejects a diff that does not correspond to adapter checkout contents", () => {
    const diff = "diff --git a/src/math.ts b/src/math.ts\n--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1 +1 @@\n-before\n+after\n";
    expect(() => analyzeDiff(diff, () => "different")).toThrow("diff does not match current contents");
  });
});
