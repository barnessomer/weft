import { applyD1Migrations, env } from "cloudflare:test";

// Idempotent: D1 records applied migrations in d1_migrations.
await applyD1Migrations(env.WEFT_DB!, env.TEST_MIGRATIONS);
