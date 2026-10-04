// Regenerate schema/wcp-v0.schema.json from src/schema.ts:
//   node --experimental-strip-types scripts/gen-schema.ts   (or: pnpm gen)
import { writeFileSync } from "node:fs";
import { schema } from "../src/schema.ts";

const out = new URL("../schema/wcp-v0.schema.json", import.meta.url);
writeFileSync(out, JSON.stringify(schema, null, 2) + "\n");
console.log(`wrote ${out.pathname}`);
