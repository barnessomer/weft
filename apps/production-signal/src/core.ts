export type ProductionError = {
  event_id: string;
  repo: string;
  occurred_at: number;
  stack: string;
  script?: string;
  status?: number;
};

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<{ meta: { changes?: number } }>;
  first<T>(): Promise<T | null>;
}
export interface D1Like { prepare(sql: string): D1Statement }
export interface RevertWorkflow {
  create(input: { id: string; params: unknown }): Promise<{ id: string }>;
}

export type DetectorDeps = {
  db: D1Like;
  revert: RevertWorkflow;
  now(): number;
  windowMs: number;
  threshold: number;
};

type Land = { op_id: string; task: string | null; created_at: number };

/**
 * Persist one tail error and trigger exactly one RevertOperation for a recent land operation
 * once its post-land error count reaches the configured threshold. The workflow does the actual
 * revert, reopens its task, and records evidence through the normal B8 path.
 */
export async function detect(error: ProductionError, deps: DetectorDeps): Promise<{ triggered: boolean; error_count?: number; workflow_id?: string }> {
  const now = deps.now();
  if (error.occurred_at < now - deps.windowMs || error.occurred_at > now + 60_000) return { triggered: false };
  await deps.db
    .prepare(`INSERT OR IGNORE INTO production_errors (event_id, repo, occurred_at, stack, script, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(error.event_id, error.repo, error.occurred_at, error.stack.slice(0, 8_000), error.script ?? null, error.status ?? null, now)
    .run();
  // Keep the D1 signal table bounded; Analytics Engine is the durable metrics store.
  await deps.db.prepare(`DELETE FROM production_errors WHERE occurred_at < ?`).bind(now - deps.windowMs * 2).run();

  const land = await deps.db
    .prepare(`SELECT op_id, task, created_at FROM landings WHERE repo = ? AND kind = 'land' AND status = 'landed' AND created_at >= ? ORDER BY created_at DESC LIMIT 1`)
    .bind(error.repo, now - deps.windowMs)
    .first<Land>();
  if (!land) return { triggered: false };

  const countRow = await deps.db
    .prepare(`SELECT COUNT(*) AS n FROM production_errors WHERE repo = ? AND occurred_at >= ? AND occurred_at >= ?`)
    .bind(error.repo, now - deps.windowMs, land.created_at)
    .first<{ n: number }>();
  const errorCount = countRow?.n ?? 0;
  if (errorCount < deps.threshold) return { triggered: false, error_count: errorCount };

  // The unique key is a concurrency-safe latch: queue redelivery and simultaneous batches cannot
  // start more than one revert for the same land operation.
  const claimed = await deps.db
    .prepare(`INSERT OR IGNORE INTO production_reverts (land_op_id, repo, triggered_at, error_count, sample_stack) VALUES (?, ?, ?, ?, ?)`)
    .bind(land.op_id, error.repo, now, errorCount, error.stack.slice(0, 8_000))
    .run();
  if (!claimed.meta.changes) return { triggered: false, error_count: errorCount };

  try {
    const started = await deps.revert.create({
      id: `prod-revert-${land.op_id}`,
      params: {
        repo: error.repo,
        op_id: land.op_id,
        reason: `production error spike: ${errorCount} errors in ${Math.round(deps.windowMs / 1000)}s after land ${land.op_id}`,
        requested_by: "weft-production-signal",
        requested_by_type: "system",
        evidence: { kind: "production_tail_error", text: error.stack.slice(0, 8_000), data: { event_id: error.event_id, script: error.script, status: error.status, error_count: errorCount, window_seconds: Math.round(deps.windowMs / 1000) } },
      },
    });
    await deps.db.prepare(`UPDATE production_reverts SET workflow_id = ? WHERE land_op_id = ?`).bind(started.id, land.op_id).run();
    return { triggered: true, error_count: errorCount, workflow_id: started.id };
  } catch (cause) {
    // Release the latch if the workflow did not start; Queue redelivery can safely retry.
    await deps.db.prepare(`DELETE FROM production_reverts WHERE land_op_id = ? AND workflow_id IS NULL`).bind(land.op_id).run();
    throw cause;
  }
}
