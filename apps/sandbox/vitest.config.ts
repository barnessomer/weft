import { defineConfig } from "vitest/config";

// Runner logic is runtime-independent: tests run in Node against a local child_process
// "container", the git-backed Artifacts fake and in-memory R2/storage. The Workers-specific
// glue (DO + Outbound entrypoint) is covered by `pnpm typecheck` and the live script.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
