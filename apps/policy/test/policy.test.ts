import { describe, expect, it } from "vitest";
import worker, { decide } from "../src/index";

const base = { repo: "acme", task: "t1", change: "c1" };

describe("repository policy", () => {
  it("allows reviewed, passing candidates and declares auto-land", () => {
    expect(decide({ ...base, evidence: { tests: { passed: 8, failed: 0 }, review: { approved: true }, squiggles: { error: 0 } } }, "acme-policy"))
      .toMatchObject({ policy: "acme-policy", allow: true, risk_tier: "low", required_evidence: ["tests"], auto_land: true, isolate: "dispatch" });
  });

  it("returns explainable denial reasons", () => {
    const d = decide({ ...base, evidence: { tests: { passed: 2, failed: 2 }, squiggles: { error: 1 } } }, "acme-policy");
    expect(d.allow).toBe(false);
    expect(d.reasons).toEqual(["tests failed", "error diagnostics remain"]);
  });

  it("requires human review for high-risk files", () => {
    const d = decide({ ...base, evidence: { files: ["src/auth/session.ts"], tests: { passed: 3, failed: 0 } } }, "acme-policy");
    expect(d).toMatchObject({ risk_tier: "high", required_evidence: ["tests", "human_review"], allow: false, auto_land: false });
  });

  it("serves decisions over the isolate fetch contract", async () => {
    const res = await worker.fetch(new Request("https://policy/evaluate", { method: "POST", body: JSON.stringify({ ...base, evidence: { tests: { passed: 1, failed: 0 } } }) }), { POLICY_NAME: "repo-policy" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ type: "policy.decision", policy: "repo-policy", allow: true });
  });
});
