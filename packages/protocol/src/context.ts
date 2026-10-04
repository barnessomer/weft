import type { Diagnostic, EventRecord, InboxItem, NegotiationDue } from "./types";

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

const quote = (s: unknown) => (typeof s === "string" && s ? ` "${s.replace(/\s+/g, " ").trim()}"` : "");

function from(r: EventRecord): string {
  const who = r.agent ?? r.actor.id;
  const bits = [r.change ? `change ${r.change}` : "", r.task ? `task ${r.task}` : ""].filter(Boolean).join(", ");
  return bits ? `${who} (${bits})` : who;
}

/** One negotiation record as its addressee reads it (spec §7.4, §7.6). */
export function renderNegotiation(r: EventRecord): string {
  const p = r.payload ?? {};
  const terms = p.terms as { kind?: string; text?: string } | undefined;
  const keys = (p.keys as string[] | undefined) ?? [];
  const answer = ` Answer it: accept #${r.seq} | reject #${r.seq} | counter #${r.seq} with other terms.`;
  switch (r.kind) {
    case "negotiate.propose":
      return `[weft negotiation] #${r.seq} ${from(r)} proposes to you: ${terms?.kind ?? "terms"}${keys.length ? ` on ${keys.join(", ")}` : ""} —${quote(terms?.text)}.${answer}`;
    case "negotiate.counter":
      return `[weft negotiation] #${r.seq} ${from(r)} counters #${String(p.reply_to)}: ${terms?.kind ?? "terms"} —${quote(terms?.text)}.${answer}`;
    case "negotiate.accept":
      return `[weft negotiation] #${r.seq} ${from(r)} ACCEPTED #${String(p.reply_to)}. The agreement is binding and recorded in the log for both sides.`;
    case "negotiate.reject":
      return `[weft negotiation] #${r.seq} ${from(r)} rejected #${String(p.reply_to)}${p.reason ? `:${quote(p.reason)}` : ""}. Pick another option: retreat, wait, a new proposal, or escalate.`;
    case "negotiate.escalate":
      return `[weft negotiation] #${r.seq} ${from(r)} escalated its conflict with you to the coordinator (merge tasks):${quote(p.reason)}.`;
    default:
      return `[weft negotiation] #${r.seq} ${r.summary}`;
  }
}

/** A `control merge` record (spec §7.6) as a member of the merged group reads it. */
export function renderMerge(r: EventRecord): string {
  const changes = (r.payload?.target as { changes?: string[] } | undefined)?.changes ?? [];
  const by = r.actor.type === "human" ? r.actor.id : "the coordinator";
  const cause = typeof r.payload?.cause === "number" ? ` after #${r.payload.cause}` : "";
  return (
    `[weft control] #${r.seq} tasks merged by ${by}${cause}: changes ${changes.join(" + ")} now form one group led by ${changes[0] ?? "?"}` +
    `${typeof r.payload?.reason === "string" && r.payload.reason ? ` —${quote(r.payload.reason)}` : ""}. ` +
    `You no longer block each other on shared symbols: work as one task (message each other about shared code) and land together.`
  );
}

export function renderInboxItem(i: InboxItem): string {
  if (i.diagnostic) return renderDiagnostic(i.diagnostic);
  const r = i.record;
  if (!r) return `[weft ${i.kind}] event #${i.seq}`;
  if (i.kind === "negotiation") return renderNegotiation(r);
  if (i.kind === "control" && r.payload?.action === "merge") return renderMerge(r);
  const text = typeof r.payload?.text === "string" ? `: ${r.payload.text}` : "";
  return `[weft ${i.kind}] #${r.seq} ${r.summary}${text && !r.summary.includes(String(r.payload?.text)) ? text : ""}`;
}

/** What a session still owes before it may stop (spec §8.4). */
export function renderDue(d: NegotiationDue): string {
  const r = d.record;
  if (d.due === "reply")
    return `[weft negotiation due] #${d.seq} from ${r.agent ?? r.actor.id} is unanswered: ${r.summary}. Reply (accept | reject | counter #${d.seq}) before you finish.`;
  return (
    `[weft negotiation due] agreement #${d.seq} (${r.summary}) obliges you to keep ${d.keys.join(", ")} usable the agreed way ` +
    `(e.g. keep the old signature as an overload). Make that edit before you finish.`
  );
}

export function renderContext(diagnostics: Diagnostic[], inbox: InboxItem[] = []): string | undefined {
  const lines = [...diagnostics.map(renderDiagnostic), ...inbox.map(renderInboxItem)];
  return lines.length ? lines.join("\n") : undefined;
}
