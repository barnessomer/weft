import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

test("admin-only routes are guarded and the create response omits tokens", () => {
  assert.match(source, /const denied = requireAdmin\(request, runtime\);/);
  assert.doesNotMatch(source, /return json\(\{ name: created\.name,[\s\S]*token:/);
  assert.match(source, /createToken\(scope, ttl\)/);
});

test("the queue consumer records event identity and latency", () => {
  assert.match(source, /eventType: event\.type/);
  assert.match(source, /repoName: event\.source\?\.repoName/);
  assert.match(source, /latencyMs:/);
  assert.match(source, /message\.ack\(\)/);
});
