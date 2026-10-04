export interface PolicyInput {
  repo: string;
  task: string;
  change: string;
  evidence?: Record<string, unknown>;
}

export interface PolicyDecision {
  type: "policy.decision";
  policy: string;
  allow: boolean;
  risk_tier: "low" | "medium" | "high";
  required_evidence: string[];
  auto_land: boolean;
  reasons: string[];
  evaluated_at: string;
  isolate: "dispatch";
}

/**
 * Repository policy-as-code. Deploy one compiled copy per repository into the
 * Dispatch Namespace with its repository slug as the script name.
 */
export function decide(input: PolicyInput, policyName: string): PolicyDecision {
  const evidence = input.evidence ?? {};
  const tests = evidence.tests as { passed?: number; failed?: number } | undefined;
  const review = evidence.review as { approved?: boolean } | undefined;
  const squiggles = evidence.squiggles as { error?: number } | undefined;
  const files = Array.isArray(evidence.files) ? evidence.files.map(String) : [];
  const sensitive = files.some((file) => /(^|\/)(auth|billing|security|migrations?)(\/|\.|$)/i.test(file));
  const risk_tier: PolicyDecision["risk_tier"] = sensitive ? "high" : review?.approved ? "low" : "medium";
  const required_evidence = risk_tier === "high" ? ["tests", "human_review"] : risk_tier === "medium" ? ["tests"] : ["tests"];
  const reasons: string[] = [];
  if (!tests || typeof tests.passed !== "number") reasons.push("test evidence is required");
  if ((tests?.failed ?? 0) > 0) reasons.push("tests failed");
  if ((squiggles?.error ?? 0) > 0) reasons.push("error diagnostics remain");
  if (risk_tier === "high" && review?.approved !== true) reasons.push("high-risk changes require human review");
  const allow = reasons.length === 0;
  return {
    type: "policy.decision",
    policy: policyName,
    allow,
    risk_tier,
    required_evidence,
    auto_land: allow && risk_tier === "low",
    reasons,
    evaluated_at: new Date().toISOString(),
    isolate: "dispatch",
  };
}
