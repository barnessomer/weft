# weft-demo

Demo trunk for Weft (M2 full scenario). Three small things share one repo:

- `src/auth`, `src/api`, `src/ui`, `src/server.ts`: an auth/session JSON service (tests in `test/`).
- `src/pricing.ts`, `src/cart.ts`, `src/orders.ts`, `src/catalog.ts`: a tiny shop.
- `public/`: the storefront (previewed per candidate, see `.weft/preview.json`).
- `src/worker.ts` + `wrangler.jsonc`: the deployed quote API (Workers Builds), watched for errors.

Tests: `node --test`. Typecheck: `tsc -p .` (`tsconfig.json` covers the service and the shop).
