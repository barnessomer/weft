import type { EventRecord, SymbolKey } from "@weft/protocol";

/**
 * The durable planning-task boundary. Its caller supplies the repository event log and
 * a Vectorize-backed code retriever; this keeps planning deterministic at the gateway
 * boundary and makes the AI provider replaceable in tests.
 */
export class TaskAgent {
  constructor(private readonly deps: PlannerDependencies) {}

  async plan(input: PlanInput): Promise<PlanResult> {
    const task = requireText(input.task, "task");
    const description = requireText(input.description, "description");
    const claims = activeClaims(input.events);
    const retrieval = await this.deps.retriever.search({
      query: `${task}\n${description}`,
      limit: 8,
      excludeRepo: input.repo,
    });
    const prompt = planningPrompt({ task, description, repo: input.repo, claims, retrieval });
    const response = await this.deps.model.complete(prompt);
    const parsed = parsePlan(response);
    const plannedWrites = uniqueKeys(parsed.planned_writes);
    const predicted = plannedWrites.filter((key) => !claims.has(key));
    return {
      task,
      summary: parsed.summary,
      planned_writes: plannedWrites,
      predicted_claims: predicted,
      existing_claims: [...claims].sort(),
      retrieved_context: retrieval,
      raw_model_output: response,
    };
  }
}

export type PlanInput = {
  repo: string;
  task: string;
  description: string;
  events: readonly Pick<EventRecord, "kind" | "status" | "files" | "writes" | "payload">[];
};

export type CodeChunk = {
  id: string;
  text: string;
  score?: number;
  metadata: {
    repo: string;
    path: string;
    symbol: SymbolKey;
    start: number;
    end: number;
    commit: string;
  };
};

export type PlanResult = {
  task: string;
  summary: string;
  planned_writes: SymbolKey[];
  /** Claims are only a prediction. The caller must submit them as source: predicted. */
  predicted_claims: SymbolKey[];
  existing_claims: SymbolKey[];
  retrieved_context: CodeChunk[];
  raw_model_output: string;
};

export type PlannerDependencies = {
  model: { complete(prompt: string): Promise<string> };
  retriever: { search(input: { query: string; limit: number; excludeRepo: string }): Promise<CodeChunk[]> };
};

type ModelPlan = { summary: string; planned_writes: unknown };

function requireText(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function uniqueKeys(value: unknown): SymbolKey[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((key): key is string => typeof key === "string" && /^[^#\s]+#[^\s]+$/.test(key)))].sort();
}

function activeClaims(events: PlanInput["events"]): Set<SymbolKey> {
  const result = new Set<SymbolKey>();
  for (const event of events) {
    if (event.status !== "accepted") continue;
    if (event.kind === "claim") for (const file of event.files) result.add(file);
    if (event.kind === "release") {
      const payload = event.payload as { keys?: unknown } | undefined;
      if (Array.isArray(payload?.keys)) for (const key of payload.keys) if (typeof key === "string") result.delete(key);
    }
  }
  return result;
}

function planningPrompt(input: {
  task: string;
  description: string;
  repo: string;
  claims: Set<SymbolKey>;
  retrieval: CodeChunk[];
}): string {
  const context = input.retrieval.map((chunk) => ({
    repo: chunk.metadata.repo,
    path: chunk.metadata.path,
    symbol: chunk.metadata.symbol,
    commit: chunk.metadata.commit,
    text: chunk.text,
  }));
  return [
    "You are a software planning agent. Return JSON only, with summary and planned_writes.",
    "planned_writes must be an array of concrete symbol keys in path#qualified.name form.",
    "Do not include a symbol that an existing claim owns unless the task explicitly requires it.",
    `Repository: ${input.repo}`,
    `Task: ${input.task}`,
    `Description: ${input.description}`,
    `Existing claims: ${JSON.stringify([...input.claims].sort())}`,
    `Cross-repository semantic context: ${JSON.stringify(context)}`,
  ].join("\n");
}

function parsePlan(output: string): ModelPlan {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(output)?.[1] ?? output;
  try {
    const parsed = JSON.parse(fenced) as Partial<ModelPlan>;
    return { summary: typeof parsed.summary === "string" ? parsed.summary : "", planned_writes: parsed.planned_writes };
  } catch {
    // A malformed model response must not create broad claims.
    return { summary: output.trim().slice(0, 500), planned_writes: [] };
  }
}

export const _test = { activeClaims, parsePlan, planningPrompt };
