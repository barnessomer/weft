import { defineConfig } from "vitest/config";

// Workflow logic is runtime-independent (src/core): tests run in Node with real git + Mergiraf
// (apps/sandbox/image/weft-job.mjs), the git-backed Artifacts fake, D1 = node:sqlite with the
// gateway's migrations and a journaled SqlCoordinator. The Cloudflare glue (src/index.ts) is
// covered by `pnpm typecheck` and the live run (scripts/live.mjs).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
