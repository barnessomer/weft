import { describe, expect, it, vi } from "vitest";
import { emailBody, emailSubject, emailTaskId, evaluatePolicy, metric, validatePolicyInput } from "../src/platform";

describe("platform policy integration", () => {
  const passing = { repo: "acme", task: "t-1", change: "c-1", evidence: { tests: { failed: 0 }, review: { approved: true }, cost_usd: 1, squiggles: { error: 0 } } };

  it("validates bounded policy input and rejects malformed input", () => {
    expect(validatePolicyInput(passing)).toEqual(passing);
    expect(validatePolicyInput({ repo: "../bad", task: "t", change: "c" })).toBeNull();
    expect(validatePolicyInput({ repo: "ok", task: "", change: "c" })).toBeNull();
  });

  it("uses dispatch isolation and validates its output", async () => {
    const fetch = vi.fn(async () => Response.json({ type: "policy.decision", policy: "custom", allow: true, reasons: [], evaluated_at: "now", isolate: "dispatch" }));
    const decision = await evaluatePolicy(passing, { get: () => ({ fetch }) });
    expect(decision.isolate).toBe("dispatch");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses an explainable deterministic fallback", async () => {
    const decision = await evaluatePolicy({ ...passing, evidence: { ...passing.evidence, tests: { failed: 2 } } });
    expect(decision.allow).toBe(false);
    expect(decision.reasons).toContain("test failures reported");
    expect(decision.isolate).toBe("builtin");
  });

  it("extracts safe email fields and deterministic task ids", () => {
    const raw = "Subject: ship release\r\nMessage-ID: <abc@example>\r\nContent-Type: text/plain\r\n\r\nPlease ship this release.\r\n";
    expect(emailSubject(raw)).toBe("ship release");
    expect(emailBody(raw)).toBe("Please ship this release.");
    expect(emailTaskId("<abc@example>", "ship release")).toBe(emailTaskId("<abc@example>", "ship release"));
    expect(emailTaskId("<abc@example>", "ship release")).toMatch(/^email-ship-release-/);
  });

  it("writes PII-free operational telemetry", () => {
    const writeDataPoint = vi.fn();
    metric({ writeDataPoint }, "acme", "policy.evaluate", "allow", Date.now() - 4, "web");
    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect(writeDataPoint.mock.calls[0][0].indexes).toEqual(["acme"]);
    expect(writeDataPoint.mock.calls[0][0].blobs).toEqual(["policy.evaluate", "allow", "web"]);
    expect(writeDataPoint.mock.calls[0][0].doubles[0]).toBeGreaterThanOrEqual(0);
  });
});
