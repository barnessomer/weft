import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const base = fileURLToPath(new URL("../assets/", import.meta.url));
const worker = new Worker(`
  const { parentPort, workerData } = require("node:worker_threads");
  const Parser = require(workerData.parser);
  (async () => {
    await Parser.init({ locateFile: () => workerData.runtimeWasm });
    const TypeScript = await Parser.Language.load(workerData.grammarWasm);
    const parser = new Parser();
    parser.setLanguage(TypeScript);
    const tree = parser.parse("export function twice(n: number) { return n * 2; }");
    parentPort.postMessage({ root: tree.rootNode.type, functions: tree.rootNode.descendantsOfType("function_declaration").length });
  })().catch((error) => parentPort.postMessage({ error: error.stack || String(error) }));
`, {
  eval: true,
  workerData: {
    parser: `${base}tree-sitter.cjs`,
    runtimeWasm: `${base}tree-sitter.wasm`,
    grammarWasm: `${base}tree-sitter-typescript.wasm`,
  },
});
const result = await new Promise((resolve, reject) => {
  worker.once("message", resolve);
  worker.once("error", reject);
});
await worker.terminate();
assert.deepEqual(result, { root: "program", functions: 1 });
console.log("web-tree-sitter Worker: parsed TypeScript (program, 1 function)");
