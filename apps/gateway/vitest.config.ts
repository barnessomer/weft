import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          // WebSocket tests hold hibernatable sockets across awaits; isolated per-test
          // storage cannot pop frames with live sockets, so each test uses its own repo.
          isolatedStorage: false,
          singleWorker: false,
          main: "./src/index.ts",
          wrangler: { configPath: "./wrangler.toml", environment: "test" },
          miniflare: {
            bindings: { WEFT_ADMIN_TOKEN: "test-admin-token", TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
