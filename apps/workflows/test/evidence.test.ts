import { describe, expect, it } from "vitest";
import { collectVisualEvidence } from "../src/core/evidence";

type Row = { kind: string; status: string; data: Record<string, unknown>; uri?: string };
const result = { status: "clean" as const, rebased: "abc" };

function writer(rows: Row[]) {
  return { evidence: async (_change: string, _sha: string, kind: string, status: Row["status"], data: unknown, uri?: string) => rows.push({ kind, status, data: data as Record<string, unknown>, uri }) };
}

describe("visual evidence", () => {
  it("stores preview, Browser Rendering screenshot and AI review with durable URIs", async () => {
    const rows: Row[] = [];
    await collectVisualEvidence(writer(rows), {
      preview: async () => ({ url: "https://preview.example/change-1", expires_at: "2026-10-05T00:00:00Z", provider: "workers" }),
      screenshot: async () => ({ uri: "r2://weft-evidence/change-1/abc.png", width: 1440, height: 900, sha256: "digest" }),
      review: async () => ({ verdict: "needs_human", summary: "The pricing card has a visible overflow.", model: "reviewer" }),
    }, { repo: "demo", change: "change-1", sha: "abc", result, intent: "Fix pricing", risk: "medium" });
    expect(rows.map((r) => [r.kind, r.status, r.uri])).toEqual([
      ["preview", "pass", "https://preview.example/change-1"],
      ["screenshot", "pass", "r2://weft-evidence/change-1/abc.png"],
      ["visual_review", "pending", undefined],
    ]);
    expect(rows[2]!.data).toMatchObject({ screenshot: "r2://weft-evidence/change-1/abc.png", preview: "https://preview.example/change-1" });
  });

  it("records a failed deployment rather than allowing an unreviewed candidate to look clean", async () => {
    const rows: Row[] = [];
    await collectVisualEvidence(writer(rows), { preview: async () => { throw new Error("deploy unavailable"); } }, { repo: "demo", change: "change-1", sha: "abc", result, intent: null, risk: "low" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "preview", status: "fail", data: { error: "deploy unavailable" } });
  });
});
