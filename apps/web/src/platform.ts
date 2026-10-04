export type PolicyInput = {
  repo: string;
  task: string;
  change: string;
  evidence?: {
    tests?: { passed?: number; failed?: number };
    review?: { approved?: boolean };
    cost_usd?: number;
    squiggles?: { error?: number; warning?: number };
    files?: string[];
  };
};

export type PolicyDecision = {
  type: "policy.decision";
  policy: string;
  allow: boolean;
  reasons: string[];
  risk_tier: "low" | "medium" | "high";
  required_evidence: string[];
  auto_land: boolean;
  evaluated_at: string;
  isolate: "dispatch" | "builtin";
};

export interface DispatchNamespace {
  get(name: string): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

export interface AnalyticsEngine {
  writeDataPoint(event: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}


export function validatePolicyInput(value: unknown): PolicyInput | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (![v.repo, v.task, v.change].every((x) => typeof x === "string" && x.length > 0 && x.length <= 256)) return null;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(v.repo as string)) return null;
  return value as PolicyInput;
}

/** Deterministic local equivalent used by tests/dev when a dispatch namespace is absent. */
export function builtinPolicy(input: PolicyInput): PolicyDecision {
  const e = input.evidence ?? {};
  const reasons: string[] = [];
  const sensitive = (e.files ?? []).some((file) => /(^|\/)(auth|billing|security|migrations?)(\/|\.|$)/i.test(file));
  const risk_tier: PolicyDecision["risk_tier"] = sensitive ? "high" : e.review?.approved ? "low" : "medium";
  if (!e.tests || typeof e.tests.passed !== "number") reasons.push("test evidence is required");
  if ((e.squiggles?.error ?? 0) > 0) reasons.push("unresolved error squiggles");
  if ((e.tests?.failed ?? 0) > 0) reasons.push("test failures reported");
  if (risk_tier === "high" && !e.review?.approved) reasons.push("high-risk changes require human review");
  if ((e.cost_usd ?? 0) > 2) reasons.push("candidate cost exceeds $2 policy budget");
  const allow = reasons.length === 0;
  return { type: "policy.decision", policy: input.repo, allow, risk_tier, required_evidence: risk_tier === "high" ? ["tests", "human_review"] : ["tests"], auto_land: allow && risk_tier === "low", reasons, evaluated_at: new Date().toISOString(), isolate: "builtin" };
}

export async function evaluatePolicy(input: PolicyInput, dispatch?: DispatchNamespace): Promise<PolicyDecision> {
  if (!dispatch) return builtinPolicy(input);
  const worker = dispatch.get(input.repo);
  const response = await worker.fetch("https://policy.internal/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`policy isolate returned ${response.status}`);
  const decision = (await response.json()) as PolicyDecision;
  if (decision?.type !== "policy.decision" || typeof decision.allow !== "boolean" || !Array.isArray(decision.reasons)) throw new Error("policy isolate returned an invalid decision");
  return { ...decision, policy: input.repo, isolate: "dispatch" };
}

export function metric(engine: AnalyticsEngine | undefined, repo: string, operation: string, outcome: string, startedAt: number, source = "web"): void {
  if (!engine) return;
  try {
    engine.writeDataPoint({ indexes: [repo], blobs: [operation, outcome, source], doubles: [Date.now() - startedAt, 1] });
  } catch (error) {
    console.warn("analytics write failed", error);
  }
}

export function emailTaskId(messageId: string, subject: string): string {
  let hash = 2166136261;
  for (const c of `${messageId}\n${subject}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "request";
  return `email-${slug}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function emailSubject(raw: string): string {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  return /^subject:\s*(.+)$/im.exec(unfolded)?.[1]?.trim().slice(0, 240) || "Email request";
}

export function emailBody(raw: string): string {
  const split = raw.search(/\r?\n\r?\n/);
  const body = split >= 0 ? raw.slice(split).trim() : raw.trim();
  return body.slice(0, 12_000);
}
