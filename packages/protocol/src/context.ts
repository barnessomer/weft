import type { Diagnostic, InboxItem } from "./types";

/**
 * Render diagnostics + inbox items as the model-visible text an adapter injects (L1),
 * returns as a deny reason (L2) or a stop-refusal reason (L3). Spec §8.3.
 * Deterministic so adapters across harnesses show identical squiggles.
 */
export function renderDiagnostic(d: Diagnostic): string {
  const where = d.range ? `${d.file}:${d.range.start.line + 1}:${d.range.start.character + 1}` : d.symbol || d.file;
  const cause = `caused by ${d.caused_by_agent}${d.caused_by_task ? ` · task ${d.caused_by_task}` : ""} · event #${d.caused_by_seq}`;
  const fix = d.suggestion ? ` Suggestion: ${d.suggestion}` : "";
  const options = d.arbitration?.options.length ? ` Options: ${d.arbitration.options.join(" | ")}.` : "";
  return `[weft ${d.severity}] ${d.code} ${where}: ${d.message} (${cause}).${fix}${options}`;
}

export function renderInboxItem(i: InboxItem): string {
  if (i.diagnostic) return renderDiagnostic(i.diagnostic);
  const r = i.record;
  if (!r) return `[weft ${i.kind}] event #${i.seq}`;
  const text = typeof r.payload?.text === "string" ? `: ${r.payload.text}` : "";
  const terms = (r.payload?.terms as { kind?: string; text?: string } | undefined) ?? undefined;
  const termText = terms ? `: ${terms.kind} — ${terms.text}` : "";
  return `[weft ${i.kind}] #${r.seq} ${r.summary}${text && !r.summary.includes(String(r.payload?.text)) ? text : ""}${termText}${
    i.kind === "negotiation" ? ` (reply with negotiate.accept|reject|counter, reply_to: ${r.seq})` : ""
  }`;
}

export function renderContext(diagnostics: Diagnostic[], inbox: InboxItem[] = []): string | undefined {
  const lines = [...diagnostics.map(renderDiagnostic), ...inbox.map(renderInboxItem)];
  return lines.length ? lines.join("\n") : undefined;
}
