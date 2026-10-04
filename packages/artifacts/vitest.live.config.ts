import { defineConfig } from "vitest/config";

// Live Cloudflare proof (network, wrangler OAuth, preview admin token). Not part of the gate.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.live.ts"], testTimeout: 180_000 },
});
