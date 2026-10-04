// node:sqlite adapter implementing the Sql surface (tests and local tooling only; the
// Durable Object uses ctx.storage.sql directly).

import { DatabaseSync } from "node:sqlite";
import type { Sql, SqlCursor, SqlValue } from "./sql";

export function nodeSql(path = ":memory:"): Sql & { db: DatabaseSync } {
  const db = new DatabaseSync(path);
  return {
    db,
    exec<T>(query: string, ...bindings: SqlValue[]): SqlCursor<T> {
      const stmt = db.prepare(query);
      const rows = stmt.all(...bindings) as unknown as T[];
      // Rows come back as null-prototype objects; normalize so deep equality works.
      return { toArray: () => rows.map((r) => ({ ...(r as object) }) as T) };
    },
  };
}
