import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Tests drive handle() with fake GATEWAY/ASSETS bindings, so no wrangler config (its
// service binding to weft-gateway is not resolvable in the test runtime).
export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        miniflare: { compatibilityDate: "2025-09-06" },
      },
    },
  },
});
