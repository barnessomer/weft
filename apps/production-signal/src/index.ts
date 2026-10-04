import { detect, type D1Like, type ProductionError, type RevertWorkflow } from "./core";

export interface Env {
  WEFT_DB: D1Database;
  WEFT_REVERT_OPERATION: RevertWorkflow;
  WEFT_PROD_EVENTS: Queue<ProductionError>;
  WEFT_PROD: AnalyticsEngineDataset;
  WEFT_REPO: string;
  WEFT_SPIKE_WINDOW_SECONDS?: string;
  WEFT_SPIKE_THRESHOLD?: string;
}

type TailRecord = { event?: { exceptions?: unknown; logs?: unknown; request?: { url?: string }; response?: { status?: number } } | null; outcome?: string; scriptName?: string; eventTimestamp?: number };

function intVar(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function stringifyException(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const e = value as { name?: unknown; message?: unknown; stack?: unknown };
    const text = typeof e.stack === "string" ? e.stack : [e.name, e.message].filter((v): v is string => typeof v === "string").join(": ");
    return text || null;
  }
  return null;
}

async function eventId(repo: string, at: number, stack: string, script?: string): Promise<string> {
  const input = new TextEncoder().encode(`${repo}\n${at}\n${script ?? ""}\n${stack}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}

/** Convert Cloudflare Tail records into a minimal, non-secret error envelope. */
export async function errorsFromTail(events: TailRecord[], repo: string): Promise<ProductionError[]> {
  const out: ProductionError[] = [];
  for (const record of events) {
    const exceptions = Array.isArray(record.event?.exceptions) ? record.event!.exceptions : [];
    const stack = exceptions.map(stringifyException).find((v): v is string => Boolean(v));
    if (!stack) continue; // Requests with a 5xx response but no exception are not auto-revert evidence.
    const occurred_at = typeof record.eventTimestamp === "number" ? record.eventTimestamp : Date.now();
    const script = typeof record.scriptName === "string" ? record.scriptName : undefined;
    out.push({ event_id: await eventId(repo, occurred_at, stack, script), repo, occurred_at, stack, script, status: record.event?.response?.status });
  }
  return out;
}

export async function handleTail(events: TailRecord[], env: Env): Promise<void> {
  const errors = await errorsFromTail(events, env.WEFT_REPO);
  for (const error of errors) {
    env.WEFT_PROD.writeDataPoint({ indexes: [error.repo, error.script ?? "unknown"], blobs: [error.event_id, error.stack.slice(0, 1_000)], doubles: [error.occurred_at, error.status ?? 0] });
    await env.WEFT_PROD_EVENTS.send(error);
  }
}

export async function handleProductionBatch(batch: MessageBatch<ProductionError>, env: Env): Promise<void> {
  const windowMs = intVar(env.WEFT_SPIKE_WINDOW_SECONDS, 300, 1) * 1_000;
  const threshold = intVar(env.WEFT_SPIKE_THRESHOLD, 5, 1);
  for (const message of batch.messages) {
    try {
      await detect(message.body, { db: env.WEFT_DB as unknown as D1Like, revert: env.WEFT_REVERT_OPERATION, now: Date.now, windowMs, threshold });
      message.ack();
    } catch (error) {
      console.error("production signal detector failed", error instanceof Error ? error.message : String(error));
      message.retry({ delaySeconds: Math.min(60, 2 ** message.attempts) });
    }
  }
}

export default {
  tail(events: TraceItem[], env: Env, _ctx: ExecutionContext): Promise<void> { return handleTail(events as unknown as TailRecord[], env); },
  queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> { return handleProductionBatch(batch as MessageBatch<ProductionError>, env); },
} satisfies ExportedHandler<Env>;
