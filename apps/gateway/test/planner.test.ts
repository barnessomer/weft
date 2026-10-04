import { describe, expect, it } from "vitest";
import { TaskAgent, _test, type CodeChunk } from "../src/planner.js";

const chunk: CodeChunk = {
  id: "other:abc:src/auth.ts#verify",
  text: "export function verify(token: string) {}",
  metadata: { repo: "other", path: "src/auth.ts", symbol: "src/auth.ts#verify", start: 1, end: 1, commit: "abc" },
};

describe("TaskAgent", () => {
  it("retrieves cross-repository context and predicts only unclaimed writes", async () => {
    let query = "";
    const agent = new TaskAgent({
      retriever: { search: async (input) => { query = input.query; return [chunk]; } },
      model: { complete: async (prompt) => {
        expect(prompt).toContain("src/auth.ts#verify");
        return '{"summary":"add auth route","planned_writes":["src/api.ts#route","src/auth.ts#verify","not a key"]}';
      } },
    });
    const result = await agent.plan({
      repo: "app",
      task: "T-1",
      description: "Add authentication",
      events: [{ kind: "claim", status: "accepted", files: ["src/auth.ts#verify"], writes: [], payload: { source: "explicit" } }],
    });
    expect(query).toContain("Add authentication");
    expect(result.planned_writes).toEqual(["src/api.ts#route", "src/auth.ts#verify"]);
    expect(result.predicted_claims).toEqual(["src/api.ts#route"]);
    expect(result.existing_claims).toEqual(["src/auth.ts#verify"]);
  });

  it("removes released claim keys and never claims on malformed model output", async () => {
    const agent = new TaskAgent({ retriever: { search: async () => [] }, model: { complete: async () => "not json" } });
    const result = await agent.plan({
      repo: "app", task: "T-2", description: "Safe plan",
      events: [
        { kind: "claim", status: "accepted", files: ["src/a.ts#a"], writes: [], payload: {} },
        { kind: "release", status: "accepted", files: [], writes: [], payload: { keys: ["src/a.ts#a"] } },
      ],
    });
    expect(result.existing_claims).toEqual([]);
    expect(result.predicted_claims).toEqual([]);
  });

  it("handles JSON inside markdown fences", () => {
    expect(_test.parsePlan('```json\n{"summary":"x","planned_writes":["a.ts#x"]}\n```')).toEqual({ summary: "x", planned_writes: ["a.ts#x"] });
  });
});
