import assert from "node:assert/strict";
import { analyze } from "../src/analyzer.ts";

type Case = { name: string; before: string; after: string; writes: Array<[string, string]>; reads?: string[] };
const path = "src/math.ts";
const cases: Case[] = [
  { name: "body change", before: "export function add(a: number, b: number) { return a + b; }", after: "export function add(a: number, b: number) { return a - b; }", writes: [["src/math.ts#add", "body"]] },
  { name: "signature change", before: "export function add(a: number) { return a; }", after: "export function add(a: number, b = 0) { return a + b; }", writes: [["src/math.ts#add", "signature"]] },
  { name: "new export", before: "export const a = 1;", after: "export const a = 1; export function twice(n: number) { return n * 2; }", writes: [["src/math.ts#twice", "new"]] },
  { name: "deleted function", before: "export function old() { return 1; }", after: "", writes: [["src/math.ts#old", "deleted"]] },
  { name: "rename reports delete and new", before: "export function oldName() { return 1; }", after: "export function newName() { return 1; }", writes: [["src/math.ts#newName", "new"], ["src/math.ts#oldName", "deleted"]] },
  { name: "moved function retains key and has no write", before: "\n\nexport function stable() { return 1; }", after: "export function stable() { return 1; }\n\n", writes: [] },
  { name: "type alias contract", before: "export type User = { id: string };", after: "export type User = { id: string; name: string };", writes: [["src/math.ts#User", "signature"]] },
  { name: "variable initializer is signature-level", before: "export const limit = 10;", after: "export const limit = 20;", writes: [["src/math.ts#limit", "signature"]] },
  { name: "call read", before: "function helper() { return 1; } export function f() { return helper(); }", after: "function helper() { return 1; } export function f() { return helper(); }", writes: [], reads: ["src/math.ts#helper"] },
  { name: "type read", before: "type Token = string; export function f(x: Token) { return x; }", after: "type Token = string; export function f(x: Token) { return x; }", writes: [], reads: ["src/math.ts#Token"] },
  { name: "class method body", before: "export class Box { value() { return 1; } }", after: "export class Box { value() { return 2; } }", writes: [["src/math.ts#Box", "body"], ["src/math.ts#Box.value", "body"]] },
];

for (const test of cases) {
  const result = analyze(test.before, test.after, path);
  assert.deepEqual(result.writes.map((w) => [w.key, w.kind]), test.writes, test.name);
  if (test.reads) assert.deepEqual(result.reads, test.reads, `${test.name}: reads`);
}
console.log(`analyzer corpus: ${cases.length}/${cases.length} cases passed`);
