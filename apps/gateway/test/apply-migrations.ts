import { applyD1Migrations, env } from "cloudflare:test";

// Idempotent: D1 records applied migrations in d1_migrations. Storage is shared
// (isolatedStorage: false) and test files run in parallel, so two setup files can
// race on the same migration: the loser sees "already exists". Wait and re-apply
// until d1_migrations agrees; any other migration error still throws.
for (let attempt = 0; ; attempt++) {
  try {
    await applyD1Migrations(env.WEFT_DB!, env.TEST_MIGRATIONS);
    break;
  } catch (err) {
    if (attempt >= 20 || !String(err).includes("already exists")) throw err;
    await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
  }
}
