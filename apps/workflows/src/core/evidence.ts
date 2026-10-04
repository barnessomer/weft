// Post-revision quality evidence. This module is deliberately transport-neutral: preview
// deployment, browser capture, storage and model review are capabilities supplied by the
// Worker entry point, while the policy and persisted record shape are unit-testable here.

import type { JobResult, Risk } from "./types";

export type EvidenceStatus = "pass" | "fail" | "info" | "pending";
export type EvidenceWriter = {
  evidence(change: string, sha: string, kind: string, status: EvidenceStatus, data: unknown, uri?: string): Promise<void>;
};

export type Preview = { url: string; expires_at?: string; provider?: string };
export type Screenshot = { uri: string; width?: number; height?: number; sha256?: string };
export type VisualReview = {
  verdict: "pass" | "fail" | "needs_human";
  summary: string;
  findings?: Array<{ severity: "low" | "medium" | "high"; text: string; selector?: string }>;
  model?: string;
};
export type EvidenceCapabilities = {
  /** Deploy an isolated, expiring preview for this candidate. */
  preview?(input: { repo: string; change: string; sha: string; result: JobResult }): Promise<Preview>;
  /** Capture a rendered page. The implementation uses Browser Rendering in production. */
  screenshot?(input: { url: string; repo: string; change: string; sha: string }): Promise<Screenshot>;
  /** Review screenshot + change intent through the configured AI Gateway. */
  review?(input: { url: string; screenshot: Screenshot; intent: string | null; risk: Risk }): Promise<VisualReview>;
};

export function reviewStatus(review: VisualReview): EvidenceStatus {
  return review.verdict === "pass" ? "pass" : review.verdict === "fail" ? "fail" : "pending";
}

/**
 * Best-effort evidence collection: a missing optional deployment capability is recorded as
 * information, not silently treated as success. Operational failures become explicit failed
 * evidence so selection and operators can distinguish an unreviewed candidate from a clean one.
 */
export async function collectVisualEvidence(
  store: EvidenceWriter,
  caps: EvidenceCapabilities | undefined,
  input: { repo: string; change: string; sha: string; result: JobResult; intent: string | null; risk: Risk },
): Promise<void> {
  if (!caps?.preview) {
    await store.evidence(input.change, input.sha, "preview", "info", { available: false, reason: "preview capability is not configured" });
    return;
  }
  let preview: Preview;
  try {
    preview = await caps.preview(input);
    await store.evidence(input.change, input.sha, "preview", "pass", { url: preview.url, expires_at: preview.expires_at ?? null, provider: preview.provider ?? null }, preview.url);
  } catch (error) {
    await store.evidence(input.change, input.sha, "preview", "fail", { error: safeError(error) });
    return;
  }
  if (!caps.screenshot) {
    await store.evidence(input.change, input.sha, "screenshot", "info", { available: false, reason: "Browser Rendering is not configured", preview: preview.url });
    return;
  }
  let shot: Screenshot;
  try {
    shot = await caps.screenshot({ url: preview.url, repo: input.repo, change: input.change, sha: input.sha });
    await store.evidence(input.change, input.sha, "screenshot", "pass", { ...shot, preview: preview.url }, shot.uri);
  } catch (error) {
    await store.evidence(input.change, input.sha, "screenshot", "fail", { preview: preview.url, error: safeError(error) });
    return;
  }
  if (!caps.review) {
    await store.evidence(input.change, input.sha, "visual_review", "info", { available: false, reason: "AI Gateway review is not configured", screenshot: shot.uri });
    return;
  }
  try {
    const review = await caps.review({ url: preview.url, screenshot: shot, intent: input.intent, risk: input.risk });
    await store.evidence(input.change, input.sha, "visual_review", reviewStatus(review), { ...review, preview: preview.url, screenshot: shot.uri });
  } catch (error) {
    await store.evidence(input.change, input.sha, "visual_review", "fail", { screenshot: shot.uri, error: safeError(error) });
  }
}

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 2_000);
}
