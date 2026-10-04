import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        // WebSocket tests hold hibernatable sockets across awaits; isolated per-test
        // storage cannot pop frames with live sockets, so each test uses its own repo.
        isolatedStorage: false,
        singleWorker: false,
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { WEFT_ADMIN_TOKEN: "test-admin-token" },
        },
      },
    },
  },
});
