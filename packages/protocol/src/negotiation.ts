// Negotiation helpers shared by the reference coordinator, the SQL coordinator and the
// adapters (spec §7.4 negotiation, §7.6 escalation, §8.4 negotiation dues). Pure functions
// over log records, so every coordinator derives threads, agreements and dues identically.

import type { AgentRef, EventRecord, NegotiationDue, NegotiationTerms, Seq, SymbolKey } from "./types";

export const NEGOTIATION_KINDS = ["negotiate.propose", "negotiate.counter", "negotiate.accept", "negotiate.reject", "negotiate.escalate"] as const;
export const TERMS_KINDS: NegotiationTerms["kind"][] = ["overload", "transfer", "share", "sequence", "merge_tasks", "other"];

type Lookup = (seq: Seq) => EventRecord | undefined;

/** Who a propose/counter/accept/reject/message/escalate record is addressed to. */
export function addresseeOf(r: EventRecord, record: Lookup): AgentRef {
  const p = r.payload ?? {};
  if (r.kind === "negotiate.propose" || r.kind === "message") return (p.to as AgentRef) ?? {};
  if (r.kind === "negotiate.escalate") return (p.with as AgentRef) ?? {};
  const parent = record(Number(p.reply_to));
  return parent ? { ...(parent.agent ? { agent: parent.agent } : {}), ...(parent.change ? { change: parent.change } : {}) } : {};
}

/** True when `to` designates the session (change preferred, else agent). */
export function isAddressedTo(to: AgentRef, me: { agent: string; change: string }): boolean {
  return Boolean((to.change && to.change === me.change) || (!to.change && to.agent === me.agent));
}

/** The original propose of a thread. */
export function threadRoot(r: EventRecord, record: Lookup): EventRecord {
  let root = r;
  for (let i = 0; i < 1000 && root.kind !== "negotiate.propose"; i++) {
    const parent = record(Number(root.payload?.reply_to));
    if (!parent) break;
    root = parent;
  }
  return root;
}

export type Agreement = {
  /** The propose/counter whose terms were accepted. */
  replied: EventRecord;
  root: EventRecord;
  terms: NegotiationTerms;
  keys: SymbolKey[];
  /** Author of the root proposal. */
  asker: string;
  askerAgent: string;
  /** The other party. */
  giver: string;
};

/** Terms and direction of an accepted `negotiate.accept` (spec §7.4). */
export function agreementOf(accept: EventRecord, record: Lookup): Agreement | undefined {
  const replied = record(Number(accept.payload?.reply_to));
  if (!replied) return undefined;
  const root = threadRoot(replied, record);
  const terms = (replied.payload?.terms as NegotiationTerms | undefined) ?? { kind: "other", text: "" };
  const keys = (root.payload?.keys as SymbolKey[] | undefined) ?? [];
  const asker = root.change!;
  const giver = accept.change === asker ? replied.change! : accept.change!;
  return { replied, root, terms, keys, asker, askerAgent: root.agent!, giver };
}

/**
 * What a session owes before it may stop (spec §8.4): unanswered proposals/counters
 * addressed to it, and `overload` agreements where its change is the giver and no accepted
 * edit of the agreed keys followed the accepted proposal/counter. `records` = accepted
 * negotiation records in seq order; `fulfilled(giver, afterSeq, keys)` = an accepted edit by
 * `giver` after `afterSeq` writes one of `keys`.
 */
export function negotiationDues(o: {
  records: EventRecord[];
  me: { agent: string; change: string };
  record: Lookup;
  fulfilled: (giver: string, after: Seq, keys: SymbolKey[]) => boolean;
}): NegotiationDue[] {
  const replied = new Set<number>();
  for (const r of o.records)
    if (r.kind === "negotiate.accept" || r.kind === "negotiate.reject" || r.kind === "negotiate.counter") replied.add(Number(r.payload?.reply_to));
  const out: NegotiationDue[] = [];
  for (const r of o.records) {
    if ((r.kind === "negotiate.propose" || r.kind === "negotiate.counter") && !replied.has(r.seq)) {
      if (isAddressedTo(addresseeOf(r, o.record), o.me))
        out.push({ seq: r.seq, due: "reply", record: r, keys: (threadRoot(r, o.record).payload?.keys as SymbolKey[] | undefined) ?? [] });
    } else if (r.kind === "negotiate.accept") {
      const a = agreementOf(r, o.record);
      if (!a || a.terms.kind !== "overload" || a.giver !== o.me.change || !a.keys.length) continue;
      // An edit made after the accepted terms were proposed counts: an owner may make the
      // overload first and accept afterwards.
      if (!o.fulfilled(a.giver, a.replied.seq, a.keys)) out.push({ seq: r.seq, due: "fulfil", record: r, keys: a.keys });
    }
  }
  return out;
}

// ------------------------------------------------------------------ adapter CLI drafts

export type NegotiateCommand =
  | { cmd: "propose"; terms: NegotiationTerms; to?: AgentRef; keys?: SymbolKey[]; wait?: number }
  | { cmd: "counter"; reply_to: Seq; terms: NegotiationTerms; wait?: number }
  | { cmd: "accept"; reply_to: Seq }
  | { cmd: "reject"; reply_to: Seq; reason?: string }
  | { cmd: "escalate"; reason: string; with?: AgentRef; keys?: SymbolKey[] };

export const NEGOTIATE_USAGE = [
  "weft negotiate propose <overload|transfer|share|sequence|merge_tasks|other> \"<terms>\" [--to AGENT|--change CHANGE] [--keys k1,k2] [--wait SECONDS]",
  "weft negotiate accept <seq>",
  "weft negotiate reject <seq> [\"<reason>\"]",
  "weft negotiate counter <seq> <kind> \"<terms>\" [--wait SECONDS]",
  "weft negotiate escalate \"<reason>\" [--to AGENT|--change CHANGE] [--keys k1,k2]",
  "weft inbox [--wait SECONDS]",
].join("\n");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--")) {
      i++;
      continue;
    }
    out.push(args[i]!);
  }
  return out;
}

const seqArg = (s: string | undefined): Seq => {
  const n = Number(String(s ?? "").replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) throw new Error(`expected an event number like 12 or #12, got ${JSON.stringify(s)}`);
  return n;
};

const termsArg = (kind: string | undefined, text: string | undefined): NegotiationTerms => {
  const k = (kind ?? "") as NegotiationTerms["kind"];
  if (!TERMS_KINDS.includes(k)) throw new Error(`terms kind must be one of ${TERMS_KINDS.join(", ")}`);
  if (!text?.trim()) throw new Error("terms text is required (what exactly you propose)");
  return { kind: k, text: text.trim() };
};

/** Parse `weft negotiate <cmd> …` arguments (shared by every adapter CLI). */
export function parseNegotiate(args: string[]): NegotiateCommand {
  const [cmd, ...rest] = args;
  const pos = positional(rest);
  const to: AgentRef | undefined = flag(rest, "change") ? { change: flag(rest, "change")! } : flag(rest, "to") ? { agent: flag(rest, "to")! } : undefined;
  const keys = flag(rest, "keys")?.split(",").map((k) => k.trim()).filter(Boolean);
  const wait = flag(rest, "wait") !== undefined ? Math.max(0, Number(flag(rest, "wait")) || 0) : undefined;
  switch (cmd) {
    case "propose":
      return { cmd, terms: termsArg(pos[0], pos.slice(1).join(" ")), ...(to ? { to } : {}), ...(keys?.length ? { keys } : {}), ...(wait !== undefined ? { wait } : {}) };
    case "counter":
      return { cmd, reply_to: seqArg(pos[0]), terms: termsArg(pos[1], pos.slice(2).join(" ")), ...(wait !== undefined ? { wait } : {}) };
    case "accept":
      return { cmd, reply_to: seqArg(pos[0]) };
    case "reject":
      return { cmd, reply_to: seqArg(pos[0]), ...(pos.length > 1 ? { reason: pos.slice(1).join(" ") } : {}) };
    case "escalate": {
      const reason = pos.join(" ").trim();
      if (!reason) throw new Error("escalate needs a reason");
      return { cmd, reason, ...(to ? { with: to } : {}), ...(keys?.length ? { keys } : {}) };
    }
    default:
      throw new Error(`unknown negotiate command ${JSON.stringify(cmd)}\n${NEGOTIATE_USAGE}`);
  }
}
