import { describe, expect, it } from "vitest";
import { detect, type D1Like, type D1Statement, type ProductionError, type RevertWorkflow } from "../src/core";

class MemoryDb implements D1Like {
  errors: ProductionError[] = [];
  reverted = new Set<string>();
  workflowIds = new Map<string, string>();
  land = { op_id: "land-42", task: "task-42", created_at: 1_000 };
  prepare(sql: string): D1Statement {
    let args: unknown[] = [];
    return {
      bind: (...values) => { args = values; return this.prepareBound(sql, () => args); },
      run: async () => ({ meta: { changes: 0 } }),
      first: async <T>() => null as T | null,
    };
  }
  private prepareBound(sql: string, args: () => unknown[]): D1Statement {
    return {
      bind: () => this.prepareBound(sql, args),
      run: async () => {
        const a = args();
        if (sql.startsWith("INSERT OR IGNORE INTO production_errors")) {
          const event = { event_id: a[0], repo: a[1], occurred_at: a[2], stack: a[3], script: a[4], status: a[5] } as ProductionError;
          if (this.errors.some((x) => x.event_id === event.event_id)) return { meta: { changes: 0 } };
          this.errors.push(event); return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT OR IGNORE INTO production_reverts")) {
          const id = String(a[0]); if (this.reverted.has(id)) return { meta: { changes: 0 } }; this.reverted.add(id); return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE production_reverts")) { this.workflowIds.set(String(a[1]), String(a[0])); return { meta: { changes: 1 } }; }
        if (sql.startsWith("DELETE FROM production_reverts")) { this.reverted.delete(String(a[0])); return { meta: { changes: 1 } }; }
        return { meta: { changes: 0 } };
      },
      first: async <T>() => {
        const a = args();
        if (sql.startsWith("SELECT op_id")) return (this.land.created_at >= Number(a[1]) ? this.land : null) as T | null;
        if (sql.startsWith("SELECT COUNT")) return { n: this.errors.filter((e) => e.repo === a[0] && e.occurred_at >= Number(a[1]) && e.occurred_at >= Number(a[2])).length } as T;
        return null;
      },
    };
  }
}

class FakeWorkflow implements RevertWorkflow {
  calls: Array<{ id: string; params: any }> = [];
  async create(input: { id: string; params: any }) { this.calls.push(input); return { id: input.id }; }
}

const error = (id: string, at = 2_000): ProductionError => ({ event_id: id, repo: "weft-demo", occurred_at: at, stack: `TypeError: planted bug ${id}`, script: "weft-demo", status: 500 });

describe("production signal detector", () => {
  it("does not revert below the threshold, then triggers once with the stack trace evidence", async () => {
    const db = new MemoryDb(); const revert = new FakeWorkflow(); const deps = { db, revert, now: () => 2_000, windowMs: 5_000, threshold: 3 };
    expect(await detect(error("one"), deps)).toEqual({ triggered: false, error_count: 1 });
    expect(await detect(error("two"), deps)).toEqual({ triggered: false, error_count: 2 });
    const out = await detect(error("three"), deps);
    expect(out).toMatchObject({ triggered: true, error_count: 3, workflow_id: "prod-revert-land-42" });
    expect(revert.calls).toHaveLength(1);
    expect(revert.calls[0]!.params).toMatchObject({ repo: "weft-demo", op_id: "land-42", requested_by_type: "system", evidence: { kind: "production_tail_error", text: "TypeError: planted bug three" } });
  });

  it("deduplicates queue redelivery and never starts a second revert for the land op", async () => {
    const db = new MemoryDb(); const revert = new FakeWorkflow(); const deps = { db, revert, now: () => 2_000, windowMs: 5_000, threshold: 1 };
    await detect(error("same"), deps);
    await detect(error("same"), deps);
    expect(db.errors).toHaveLength(1);
    expect(revert.calls).toHaveLength(1);
  });
});
