import { defineConfig } from "vitest/config";

// Pure Node tests: handle() is driven with a fake Artifacts repo (readFile) and a fake R2
// bucket. HTMLRewriter is a Workers global; when it is missing (Node) HTML is served as-is
// and the URL rewriting is covered by rewriteAttr() unit tests.
export default defineConfig({ test: { environment: "node", include: ["test/**/*.test.ts"] } });
