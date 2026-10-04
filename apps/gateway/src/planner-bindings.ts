import type { CodeChunk, PlannerDependencies } from "./planner.js";

/** Minimal structural bindings so unit tests do not need a live Cloudflare account. */
type AiBinding = { run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> };
type VectorizeBinding = {
  query(vector: number[], options: { topK: number; returnMetadata: "all" }): Promise<{ matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>;
};

export function cloudflarePlanner(ai: AiBinding, index: VectorizeBinding, gateway?: string): PlannerDependencies {
  return {
    model: {
      async complete(prompt) {
        const response = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
          messages: [{ role: "system", content: "Return strict JSON only." }, { role: "user", content: prompt }],
        }, gateway ? { gateway } : undefined);
        if (typeof response === "string") return response;
        if (response && typeof response === "object") {
          const value = response as { response?: unknown; result?: { response?: unknown } };
          if (typeof value.response === "string") return value.response;
          if (typeof value.result?.response === "string") return value.result.response;
        }
        throw new Error("AI Gateway returned no text response");
      },
    },
    retriever: {
      async search({ query, limit, excludeRepo }) {
        const embedded = await ai.run("@cf/baai/bge-base-en-v1.5", { text: [query] });
        const vector = embedding(embedded);
        const { matches } = await index.query(vector, { topK: limit * 3, returnMetadata: "all" });
        return matches.flatMap((match): CodeChunk[] => {
          const metadata = match.metadata;
          if (!metadata || metadata.repo === excludeRepo || !isChunkMetadata(metadata)) return [];
          return [{ id: match.id, score: match.score, text: typeof metadata.text === "string" ? metadata.text : "", metadata }];
        }).slice(0, limit);
      },
    },
  };
}

function embedding(value: unknown): number[] {
  if (Array.isArray(value) && value.every((n) => typeof n === "number")) return value;
  if (value && typeof value === "object") {
    const candidate = value as { data?: unknown; shape?: unknown };
    if (Array.isArray(candidate.data) && Array.isArray(candidate.data[0])) return candidate.data[0] as number[];
  }
  throw new Error("embedding model returned no vector");
}

function isChunkMetadata(value: Record<string, unknown>): value is CodeChunk["metadata"] & { text?: string } {
  return ["repo", "path", "symbol", "commit"].every((key) => typeof value[key] === "string")
    && typeof value.start === "number" && typeof value.end === "number";
}
