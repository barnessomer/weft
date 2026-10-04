// B10 evidence per revision: preview, screenshots + visual diff against trunk, risk
// classification of the diff, and a review agent scoring the candidate against the task's
// acceptance criteria. All of it lands as D1 `evidence` rows (B9 shows them) and is summarized
// into the vendor field `x_evidence` that ProcessRevision stamps on a checkpoint record (the
// Hérmes Changes feed and the video read it from there).
//
// Runtime-neutral: the capabilities (Artifacts-backed previews, Browser Rendering, Workers AI
// via AI Gateway, R2) are supplied by the Worker entry point (src/evidence-cf.ts); the policy,
// prompts, parsing and the persisted shape live here and are unit-tested in Node.

import type { JobResult, Risk, StepLike } from "./types";

export type EvidenceStatus = "pass" | "fail" | "info" | "pending";
export type EvidenceWriter = {
  evidence(change: string, sha: string, kind: string, status: EvidenceStatus, data: unknown, uri?: string): Promise<void>;
};

/** An exact revision of an Artifacts repo (the candidate's fork or trunk). */
export type RevisionRef = { repo: string; sha: string };

export type PreviewInfo = {
  /** Preview of the candidate as it would land (rebased onto trunk). */
  url: string;
  /** Preview of trunk at the sha the candidate was rebased onto (visual-diff baseline). */
  trunk_url: string | null;
  /** Key routes to capture (from `.weft/preview.json`). */
  routes: string[];
  provider: string;
};
export type Shot = { uri: string; key: string; width: number; height: number };
export type Capture = { route: string; candidate: Shot; trunk?: Shot | null; diff?: { ratio: number; pixels: number; total: number; uri: string | null } | null; error?: string };
export type RiskResult = { risk: Risk; reasons: string[]; model: string | null; heuristic: Risk; classified: Risk | null };
export type CriterionResult = { criterion: string; met: boolean | null; note: string };
export type Review = { verdict: "pass" | "fail" | "needs_human"; score: number; summary: string; criteria: CriterionResult[]; model: string };

export type ReviewInput = {
  title: string | null;
  criteria: string[];
  patch: string;
  files: Array<{ status: string; path: string }>;
  tests: JobResult["tests"] | null;
  visual: Array<{ route: string; ratio: number | null }>;
  risk: Risk | null;
  /** Candidate screenshot of the first route (PNG bytes, base64) for vision-capable reviewers. */
  screenshot_b64?: string | null;
  /** Attribution (AI Gateway metadata). */
  repo?: string;
  change?: string;
};

export type EvidenceCapabilities = {
  /** Preview URLs for the candidate + trunk revisions; null when the repo has no preview config. */
  preview?(input: { repo: string; change: string; candidate: RevisionRef; trunk: RevisionRef | null }): Promise<PreviewInfo | null>;
  /** Screenshot each key route of candidate and trunk (Browser Rendering), store in R2, pixel-diff. */
  capture?(input: { repo: string; change: string; sha: string; onto: string | null; preview: PreviewInfo }): Promise<Capture[]>;
  /** Risk classification of the diff (Workers AI). */
  classify?(input: { repo?: string; change?: string; title: string | null; patch: string; files: Array<{ status: string; path: string }>; diffstat: JobResult["diffstat"] | null }): Promise<{ risk: Risk; reasons: string[]; model: string }>;
  /** Review agent (AI Gateway) scoring the candidate against the acceptance criteria. */
  review?(input: ReviewInput): Promise<Review>;
  /** Fetch a stored screenshot (base64) for the reviewer. Optional. */
  screenshot?(key: string): Promise<string | null>;
};

export type XEvidence = {
  preview_url: string | null;
  trunk_preview_url?: string | null;
  tests: { passed: number; failed: number; total: number } | null;
  screenshots: string[];
  visual_diff?: Array<{ route: string; ratio: number | null; uri: string | null }>;
  review: { verdict: string; summary: string; score?: number } | null;
  risk?: Risk | null;
  cost_usd: number | null;
};

// ------------------------------------------------------------------------------ risk (pure)

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
export const maxRisk = (...r: Array<Risk | null | undefined>): Risk => r.reduce<Risk>((m, x) => (x && RANK[x] > RANK[m] ? x : m), "low");

const HIGH_PATHS: Array<[RegExp, string]> = [
  [/(^|\/)migrations?\//i, "database migration"],
  [/(^|\/)(auth|security|crypto|session|permissions?)[^/]*(\/|\.|$)/i, "auth/security code"],
  [/(^|\/)\.github\/workflows\//, "CI pipeline"],
  [/(^|\/)(wrangler\.(toml|jsonc?)|Dockerfile)$/, "deployment config"],
];
const MEDIUM_PATHS: Array<[RegExp, string]> = [
  [/(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.(toml|lock)|go\.(mod|sum))$/, "dependencies"],
  [/(^|\/)(config|settings)[^/]*\.(ts|js|json|ya?ml|toml)$/i, "configuration"],
  [/\.sql$/i, "SQL"],
];

/** Deterministic floor for the risk tier (the model can raise it, never lower it). */
export function heuristicRisk(files: Array<{ status: string; path: string }>, diffstat: JobResult["diffstat"] | null): { risk: Risk; reasons: string[] } {
  const reasons: string[] = [];
  let risk: Risk = "low";
  for (const f of files) {
    for (const [re, why] of HIGH_PATHS)
      if (re.test(f.path)) {
        risk = "high";
        reasons.push(`${why}: ${f.path}`);
      }
    for (const [re, why] of MEDIUM_PATHS)
      if (re.test(f.path)) {
        risk = maxRisk(risk, "medium");
        reasons.push(`${why}: ${f.path}`);
      }
    if (f.status === "D") {
      risk = maxRisk(risk, "medium");
      reasons.push(`deletes ${f.path}`);
    }
  }
  const churn = (diffstat?.insertions ?? 0) + (diffstat?.deletions ?? 0);
  if (churn > 1500) {
    risk = "high";
    reasons.push(`large diff (${churn} lines)`);
  } else if (churn > 400) {
    risk = maxRisk(risk, "medium");
    reasons.push(`sizeable diff (${churn} lines)`);
  }
  return { risk, reasons: [...new Set(reasons)].slice(0, 12) };
}

export function riskPrompt(input: { title: string | null; patch: string; files: Array<{ status: string; path: string }> }): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content:
        "You classify the deployment risk of a code change for an automated landing queue. " +
        'Answer with ONLY a JSON object: {"risk":"low"|"medium"|"high","reasons":["short reason", ...]}. ' +
        "low = cosmetic/docs/tests/isolated logic with tests; medium = behaviour change in shared code, config, dependencies, public API; " +
        "high = auth/security, data migrations or deletion, payments, infra/deploy, anything hard to undo.",
    },
    { role: "user", content: `Task: ${input.title ?? "(untitled)"}\nFiles:\n${input.files.map((f) => `${f.status} ${f.path}`).join("\n").slice(0, 3000)}\n\nDiff:\n${input.patch.slice(0, 12_000)}` },
  ];
}

/** First parseable JSON object in a model answer (models wrap JSON in prose or fences). */
export function extractJson(text: string): Record<string, unknown> | null {
  const t = text.replace(/```(?:json)?/gi, "");
  for (let start = t.indexOf("{"); start >= 0; start = t.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

export function parseRisk(text: string): { risk: Risk; reasons: string[] } | null {
  const j = extractJson(text);
  const r = String(j?.risk ?? "").toLowerCase();
  if (r !== "low" && r !== "medium" && r !== "high") return null;
  const reasons = Array.isArray(j?.reasons) ? (j!.reasons as unknown[]).map((x) => String(x).slice(0, 200)).slice(0, 8) : [];
  return { risk: r, reasons };
}

// ------------------------------------------------------------------------------ review (pure)

export function reviewPrompt(input: ReviewInput): Array<{ role: "system" | "user"; content: string }> {
  const criteria = input.criteria.length ? input.criteria : [`The change accomplishes the task: ${input.title ?? "(untitled)"}`, "The change does not break existing behaviour"];
  const tests = input.tests ? `${input.tests.status}${input.tests.summary ? ` (${input.tests.summary.pass ?? "?"} passed, ${input.tests.summary.fail ?? "?"} failed)` : ""}` : "not run";
  const visual = input.visual.length ? input.visual.map((v) => `${v.route}: ${v.ratio === null ? "no baseline" : `${(v.ratio * 100).toFixed(2)}% of pixels differ from trunk`}`).join("; ") : "no preview";
  return [
    {
      role: "system",
      content:
        "You are a strict code reviewer in an automated merge pipeline. Score the candidate change against EACH acceptance criterion, using only the evidence given (diff, tests, visual diff). " +
        'Answer with ONLY a JSON object: {"criteria":[{"criterion":"...","met":true|false|null,"note":"one sentence"}],"score":0-100,"verdict":"pass"|"fail"|"needs_human","summary":"one or two sentences"}. ' +
        "met=null when the evidence cannot show it. verdict pass only if every criterion is met and nothing looks wrong; fail if a criterion is clearly not met or the diff is broken; otherwise needs_human.",
    },
    {
      role: "user",
      content: [
        `Task: ${input.title ?? "(untitled)"}`,
        `Acceptance criteria:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
        `Tests on the rebased tree: ${tests}`,
        `Visual diff vs trunk (Browser Rendering screenshots of the candidate's preview vs trunk's, per route; 0.00% = the rendered page is pixel-identical to trunk, i.e. unchanged): ${visual}`,
        `Risk tier: ${input.risk ?? "unknown"}`,
        `Changed files:\n${input.files.map((f) => `${f.status} ${f.path}`).join("\n").slice(0, 2000)}`,
        `Diff:\n${input.patch.slice(0, 14_000)}`,
      ].join("\n\n"),
    },
  ];
}

export function parseReview(text: string, criteria: string[], model: string): Review | null {
  const j = extractJson(text);
  if (!j) return null;
  const verdict = String(j.verdict ?? "").toLowerCase();
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "needs_human") return null;
  const rawCriteria = Array.isArray(j.criteria) ? (j.criteria as Array<Record<string, unknown>>) : [];
  const out: CriterionResult[] = rawCriteria.slice(0, 20).map((c, i) => ({
    criterion: String(c?.criterion ?? criteria[i] ?? `criterion ${i + 1}`).slice(0, 500),
    met: c?.met === true ? true : c?.met === false ? false : null,
    note: String(c?.note ?? "").slice(0, 400),
  }));
  let score = Number(j.score);
  if (!Number.isFinite(score)) score = out.length ? Math.round((100 * out.filter((c) => c.met).length) / out.length) : 0;
  score = Math.max(0, Math.min(100, Math.round(score)));
  // Fail closed: a "pass" that leaves a criterion unmet (or unknown) is downgraded.
  let v = verdict as Review["verdict"];
  if (v === "pass" && out.some((c) => c.met === false)) v = "fail";
  else if (v === "pass" && out.some((c) => c.met === null)) v = "needs_human";
  return { verdict: v, score, summary: String(j.summary ?? "").slice(0, 600), criteria: out, model };
}

export function reviewStatus(review: Pick<Review, "verdict">): EvidenceStatus {
  return review.verdict === "pass" ? "pass" : review.verdict === "fail" ? "fail" : "pending";
}

// ------------------------------------------------------------------------------ pipeline

export type EvidenceInput = {
  repo: string;
  change: string;
  /** The pushed revision (evidence rows key on it). */
  sha: string;
  result: JobResult;
  title: string | null;
  criteria: string[];
  /** Candidate fork + trunk Artifacts repo names (preview sources). */
  fork: string;
  trunk: string;
};

export type EvidenceOutcome = { x: XEvidence; risk: Risk | null; review: Review | null };

const safeError = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 1_000);

/**
 * Run the B10 evidence stages as separate durable steps: preview → screenshots + visual diff
 * → risk → review. A missing capability is recorded as `info` (not silently skipped); an
 * operational failure becomes `fail` evidence so an unreviewed candidate never looks clean.
 * Each step writes its rows and returns plain data, so a replay never duplicates rows.
 */
export async function collectEvidence(step: StepLike, store: EvidenceWriter, caps: EvidenceCapabilities, input: EvidenceInput): Promise<EvidenceOutcome> {
  const r = input.result;
  const rebased = r.rebased ?? r.head ?? input.sha;
  const ev = (kind: string, status: EvidenceStatus, data: unknown, uri?: string) => store.evidence(input.change, input.sha, kind, status, data, uri);

  // 1. Preview of the candidate as it would land, and of trunk at the same base.
  const preview = await step.do("evidence: preview", async (): Promise<PreviewInfo | null> => {
    if (!caps.preview) {
      await ev("preview", "info", { available: false, reason: "preview capability is not configured" });
      return null;
    }
    try {
      const p = await caps.preview({ repo: input.repo, change: input.change, candidate: { repo: input.fork, sha: rebased }, trunk: r.onto ? { repo: input.trunk, sha: r.onto } : null });
      if (!p) await ev("preview", "info", { available: false, reason: "no .weft/preview.json in this revision" });
      else await ev("preview", "pass", { url: p.url, trunk_url: p.trunk_url, routes: p.routes, provider: p.provider, sha: rebased, onto: r.onto ?? null }, p.url);
      return p;
    } catch (e) {
      await ev("preview", "fail", { error: safeError(e), sha: rebased });
      return null;
    }
  });

  // 2. Screenshots of key routes, candidate vs trunk, pixel diff.
  let captures: Capture[] = [];
  if (preview) {
    captures = await step.do("evidence: screenshots", async (): Promise<Capture[]> => {
      if (!caps.capture) {
        await ev("screenshot", "info", { available: false, reason: "Browser Rendering is not configured", preview: preview.url });
        return [];
      }
      try {
        const got = await caps.capture!({ repo: input.repo, change: input.change, sha: rebased, onto: r.onto ?? null, preview });
        for (const c of got) {
          if (!c.candidate?.uri) {
            await ev("screenshot", "fail", { route: c.route, error: c.error ?? "no screenshot" });
            continue;
          }
          await ev(
            "screenshot",
            "pass",
            { route: c.route, width: c.candidate.width, height: c.candidate.height, key: c.candidate.key, trunk_uri: c.trunk?.uri ?? null, diff_uri: c.diff?.uri ?? null, diff_ratio: c.diff?.ratio ?? null, preview: preview.url, ...(c.error ? { error: c.error } : {}) },
            c.candidate.uri,
          );
        }
        const routes = got.map((c) => ({ route: c.route, ratio: c.diff?.ratio ?? null, pixels: c.diff?.pixels ?? null, uri: c.diff?.uri ?? null }));
        const max = Math.max(0, ...routes.map((x) => x.ratio ?? 0));
        await ev("visual_diff", "info", { routes, max_ratio: max, changed: max > 0.001, baseline: r.onto ?? null });
        return got;
      } catch (e) {
        await ev("screenshot", "fail", { error: safeError(e), preview: preview.url });
        return [];
      }
    });
  }

  // 3. Risk classification (heuristic floor + Workers AI).
  const patch = r.patch ?? "";
  const files = r.files ?? [];
  const risk = await step.do("evidence: risk", async (): Promise<RiskResult> => {
    const h = heuristicRisk(files, r.diffstat ?? null);
    let classified: { risk: Risk; reasons: string[]; model: string } | null = null;
    let error: string | undefined;
    if (caps.classify && (patch || files.length)) {
      try {
        classified = await caps.classify({ repo: input.repo, change: input.change, title: input.title, patch, files, diffstat: r.diffstat ?? null });
      } catch (e) {
        error = safeError(e);
      }
    }
    const out: RiskResult = { risk: maxRisk(h.risk, classified?.risk), reasons: [...(classified?.reasons ?? []), ...h.reasons].slice(0, 12), model: classified?.model ?? null, heuristic: h.risk, classified: classified?.risk ?? null };
    await ev("risk", "info", { ...out, ...(error ? { error } : {}), ...(caps.classify ? {} : { note: "Workers AI classifier not configured; heuristic only" }) });
    return out;
  });

  // 4. Review agent against the acceptance criteria.
  const review = await step.do("evidence: review", async (): Promise<Review | null> => {
    if (!caps.review) {
      await ev("review", "info", { available: false, reason: "review agent (AI Gateway) is not configured" });
      return null;
    }
    try {
      const first = captures.find((c) => c.candidate?.key);
      const shot = first && caps.screenshot ? await caps.screenshot(first.candidate.key).catch(() => null) : null;
      const rv = await caps.review({
        repo: input.repo,
        change: input.change,
        title: input.title,
        criteria: input.criteria,
        patch,
        files,
        tests: r.tests ?? null,
        visual: captures.map((c) => ({ route: c.route, ratio: c.diff?.ratio ?? null })),
        risk: risk.risk,
        screenshot_b64: shot,
      });
      await ev("review", reviewStatus(rv), { ...rv, criteria_source: input.criteria.length ? "task" : "title" });
      return rv;
    } catch (e) {
      await ev("review", "fail", { verdict: "needs_human", error: safeError(e) });
      return null;
    }
  });

  const x: XEvidence = {
    preview_url: preview?.url ?? null,
    trunk_preview_url: preview?.trunk_url ?? null,
    tests: testsSummary(r.tests),
    screenshots: captures.filter((c) => c.candidate?.uri).map((c) => c.candidate.uri),
    visual_diff: captures.map((c) => ({ route: c.route, ratio: c.diff?.ratio ?? null, uri: c.diff?.uri ?? null })),
    review: review ? { verdict: review.verdict, summary: review.summary, score: review.score } : null,
    risk: risk.risk,
    cost_usd: null,
  };
  return { x, risk: risk.risk, review };
}

export function testsSummary(t: JobResult["tests"] | null | undefined): XEvidence["tests"] {
  if (!t || t.status === "skipped") return null;
  const passed = t.summary?.pass ?? (t.status === "pass" ? 1 : 0);
  const failed = t.summary?.fail ?? (t.status === "fail" ? 1 : 0);
  return { passed, failed, total: passed + failed };
}

/** x_evidence for a revision from its stored evidence rows (land records, re-stamps). */
export function xEvidenceFromRows(rows: Array<{ kind: string; status: string; data: string | null; uri?: string | null }>): XEvidence {
  const last = (k: string) => [...rows].reverse().find((e) => e.kind === k);
  const data = (e?: { data: string | null }) => {
    try {
      return e?.data ? (JSON.parse(e.data) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const pv = last("preview");
  const test = last("presubmit") ?? last("test");
  const rv = last("review");
  const rd = data(rv) as { verdict?: string; summary?: string; score?: number };
  const rk = data(last("risk")) as { risk?: Risk };
  const shots = rows.filter((e) => e.kind === "screenshot" && e.status === "pass" && e.uri).map((e) => e.uri!);
  const cost = rows.filter((e) => e.kind === "cost").reduce((n, e) => n + (Number((data(e) as { usd?: number }).usd ?? 0) || 0), 0);
  return {
    preview_url: pv?.status === "pass" ? (pv.uri ?? null) : null,
    tests: test ? testsSummary(data(test) as JobResult["tests"]) : null,
    screenshots: [...new Set(shots)].slice(-8),
    review: rv && rd.verdict ? { verdict: rd.verdict, summary: rd.summary ?? "", ...(typeof rd.score === "number" ? { score: rd.score } : {}) } : null,
    risk: rk.risk ?? null,
    cost_usd: cost > 0 ? Math.round(cost * 10_000) / 10_000 : null,
  };
}
