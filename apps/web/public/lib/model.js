// @ts-check
// Pure state derivation for the Weft web UI. No DOM here: everything is a function of the
// WCP event log (spec §4.2 EventRecord) plus the gateway's D1 task/candidate index, so it
// can be unit-tested in the Workers test pool and reused by the live view, board, task
// detail and op log alike.

/**
 * @typedef {{ key: string, kind: string }} Write
 * @typedef {{ severity: "error"|"warning"|"info", code: string, file?: string, symbol?: string, message: string,
 *   caused_by_seq?: number, caused_by_agent?: string, caused_by_task?: string, suggestion?: string,
 *   arbitration?: { outcome?: string, winner?: { agent?: string, change?: string }, loser?: { agent?: string, change?: string } } }} Diagnostic
 * @typedef {{ seq: number, repo?: string, status: "accepted"|"rejected", kind: string, ts: string,
 *   actor?: { type: string, id: string, harness?: string }, agent?: string, task?: string, change?: string,
 *   session?: string, base_seq?: number, mode?: string, files: string[], reads: string[], writes: Write[],
 *   summary: string, diagnostics: Diagnostic[], intent?: string, payload?: any, has_diff?: boolean, diff?: string,
 *   x_task_title?: string }} WcpEvent
 * @typedef {{ change: string, n: number, agent?: string, status: string, head_sha?: string, evidence?: Record<string, number> }} D1Candidate
 * @typedef {{ task: string, title?: string, status: string, candidate_count: number, candidates: D1Candidate[], updated_at?: string }} D1Task
 */

/** Stable hue per agent id, so an agent keeps its color across views and reloads. */
export function agentHue(/** @type {string} */ id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}

/** Short display name of a symbol key: `src/a.ts#Foo.bar` -> `Foo.bar`, `path#*` -> file name. */
export function symbolName(/** @type {string|undefined} */ key) {
  if (!key) return "";
  const i = key.indexOf("#");
  if (i < 0) return key;
  const name = key.slice(i + 1);
  if (name === "*") return key.slice(0, i).split("/").pop() ?? key;
  return name;
}
export function symbolFile(/** @type {string|undefined} */ key) {
  if (!key) return "";
  const i = key.indexOf("#");
  return i < 0 ? key : key.slice(0, i);
}

export function shortSha(/** @type {string|undefined} */ sha) {
  return sha ? sha.slice(0, 7) : "";
}
export function shortChange(/** @type {string|undefined} */ c) {
  if (!c) return "";
  if (/^I[0-9a-f]{40}$/.test(c)) return c.slice(0, 9);
  return c.length > 28 ? `${c.slice(0, 27)}…` : c;
}

/** Relative time, compact: "now", "42s", "5m", "3h", "2d". */
export function ago(/** @type {string|number} */ ts, now = Date.now()) {
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Unified diff -> {add, del, files}. Header lines (---/+++/@@/diff) are not counted. */
export function diffStats(/** @type {string|undefined} */ diff) {
  const out = { add: 0, del: 0, files: /** @type {string[]} */ ([]) };
  if (!diff) return out;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const f = line.slice(4).replace(/^b\//, "").trim();
      if (f !== "/dev/null" && !out.files.includes(f)) out.files.push(f);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    if (line.startsWith("+")) out.add++;
    else if (line.startsWith("-")) out.del++;
  }
  return out;
}

/** Parse a unified diff into renderable lines with a type tag. */
export function diffLines(/** @type {string|undefined} */ diff) {
  if (!diff) return [];
  return diff.split("\n").map((text) => {
    /** @type {"file"|"hunk"|"add"|"del"|"ctx"} */
    let type = "ctx";
    if (text.startsWith("+++ ") || text.startsWith("--- ") || text.startsWith("diff ") || text.startsWith("index ")) type = "file";
    else if (text.startsWith("@@")) type = "hunk";
    else if (text.startsWith("+")) type = "add";
    else if (text.startsWith("-")) type = "del";
    return { type, text };
  });
}

const TITLE_FROM_INTENT = /^(?:\[?[A-Za-z0-9_.:-]+\]?)\s*[:—-]\s*(.+)$/;

/** Best human title for a task from its events: x_task_title, intent "t_x: title", summary "… — title". */
export function titleFromEvents(/** @type {WcpEvent[]} */ events) {
  for (const e of events) if (e.x_task_title) return e.x_task_title;
  for (const e of events) {
    const first = (e.intent ?? "").split("\n")[0]?.trim() ?? "";
    const m = TITLE_FROM_INTENT.exec(first);
    if (m && e.task && first.startsWith(e.task)) return m[1].trim();
  }
  for (const e of events) {
    const i = e.summary.lastIndexOf(" — ");
    if (i > 0) return e.summary.slice(i + 3).trim();
  }
  return undefined;
}

/** Is this record a squiggle carrier? (rejected, or any diagnostic). */
export function isSquiggly(/** @type {WcpEvent} */ e) {
  return e.status === "rejected" || e.diagnostics.length > 0;
}

/** Highest severity among an event's diagnostics ("error" for a rejected record without any). */
export function worstSeverity(/** @type {WcpEvent} */ e) {
  if (e.diagnostics.some((d) => d.severity === "error") || e.status === "rejected") return "error";
  if (e.diagnostics.some((d) => d.severity === "warning")) return "warning";
  if (e.diagnostics.length) return "info";
  return null;
}

/**
 * The op log (design §3 Operation): every land/revert with its current state.
 * A land is `live`, `undo_requested` (a human `control undo` targets it, no revert yet), or
 * `reverted` (a `revert` record names its seq or op_id).
 */
export function deriveOps(/** @type {WcpEvent[]} */ events) {
  /** @type {Map<number, any>} */
  const lands = new Map();
  /** @type {Map<string, number>} */
  const byOp = new Map();
  const ops = [];
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.status !== "accepted") continue;
    if (e.kind === "land") {
      const op = {
        type: "land",
        seq: e.seq,
        ts: e.ts,
        op_id: e.payload?.op_id ?? `seq-${e.seq}`,
        sha: e.payload?.sha,
        change: e.change,
        task: e.task,
        agent: e.agent,
        actor: e.actor?.id,
        summary: e.summary,
        symbols: e.writes.length,
        files: e.files,
        state: "live",
        /** @type {number|undefined} */ undo_seq: undefined,
        /** @type {number|undefined} */ revert_seq: undefined,
      };
      lands.set(e.seq, op);
      byOp.set(op.op_id, e.seq);
      ops.push(op);
    } else if (e.kind === "control" && e.payload?.action === "undo") {
      const t = e.payload.target ?? {};
      const seq = typeof t.seq === "number" ? t.seq : byOp.get(t.op_id);
      const land = seq !== undefined ? lands.get(seq) : undefined;
      if (land && land.state === "live") {
        land.state = "undo_requested";
        land.undo_seq = e.seq;
      }
    } else if (e.kind === "revert") {
      const p = e.payload ?? {};
      const seq = typeof p.reverts_seq === "number" ? p.reverts_seq : byOp.get(p.reverts_op_id);
      const land = seq !== undefined ? lands.get(seq) : undefined;
      if (land) {
        land.state = "reverted";
        land.revert_seq = e.seq;
      }
      ops.push({ type: "revert", seq: e.seq, ts: e.ts, op_id: p.op_id ?? `seq-${e.seq}`, sha: p.sha, change: e.change, task: e.task, agent: e.agent, actor: e.actor?.id, summary: e.summary, reason: p.reason, reverts_seq: seq, requested_by: p.requested_by, state: "done" });
    }
  }
  return ops.sort((a, b) => b.seq - a.seq);
}

/** Changes a human approved: change id -> approving control record seq. */
export function approvals(/** @type {WcpEvent[]} */ events) {
  /** @type {Map<string, number>} */
  const m = new Map();
  for (const e of events) if (e.kind === "control" && e.status === "accepted" && e.payload?.action === "approve" && e.payload?.target?.change) m.set(e.payload.target.change, e.seq);
  return m;
}

/** Per-change rollup from the log: edits, files, writes, squiggles, checkpoints, land state. */
export function changeStats(/** @type {WcpEvent[]} */ events, /** @type {string} */ change) {
  const s = {
    change,
    agent: /** @type {string|undefined} */ (undefined),
    harness: /** @type {string|undefined} */ (undefined),
    edits: 0,
    blocked: 0,
    files: /** @type {Set<string>} */ (new Set()),
    writes: /** @type {Map<string,string>} */ (new Map()),
    squiggles: { error: 0, warning: 0, info: 0 },
    diagnostics: /** @type {{ ev: WcpEvent, d: Diagnostic }[]} */ ([]),
    checkpoints: /** @type {{ seq: number, sha: string, ts: string }[]} */ ([]),
    add: 0,
    del: 0,
    landed: /** @type {number|undefined} */ (undefined),
    reverted: /** @type {number|undefined} */ (undefined),
    last_ts: /** @type {string|undefined} */ (undefined),
    first_ts: /** @type {string|undefined} */ (undefined),
  };
  const landSeqs = new Set();
  for (const e of events) {
    if (e.change !== change) continue;
    if (!s.first_ts) s.first_ts = e.ts;
    s.last_ts = e.ts;
    if (e.actor?.type === "agent") {
      s.agent = e.agent;
      s.harness = e.actor.harness ?? s.harness;
    } else if (!s.agent && e.agent) s.agent = e.agent;
    if (e.kind === "edit") {
      if (e.status === "accepted") {
        s.edits++;
        for (const f of e.files) s.files.add(f);
        for (const w of e.writes) s.writes.set(w.key, w.kind);
        if (e.diff) {
          const d = diffStats(e.diff);
          s.add += d.add;
          s.del += d.del;
        }
      } else s.blocked++;
    }
    if (e.kind === "checkpoint" && e.payload?.sha) s.checkpoints.push({ seq: e.seq, sha: e.payload.sha, ts: e.ts });
    if (e.kind === "land" && e.status === "accepted") {
      s.landed = e.seq;
      landSeqs.add(e.seq);
    }
    for (const d of e.diagnostics) {
      s.squiggles[d.severity] = (s.squiggles[d.severity] ?? 0) + 1;
      s.diagnostics.push({ ev: e, d });
    }
  }
  for (const e of events) if (e.kind === "revert" && landSeqs.has(e.payload?.reverts_seq)) s.reverted = e.seq;
  return s;
}

/**
 * Board model: one entry per task, merged from the gateway's D1 index (tasks created with
 * candidates) and the log (tasks agents worked on). Column:
 *   queued    — known task, no activity in the log yet
 *   working   — agents active, no open squiggle errors on the latest record per change
 *   conflict  — the latest record of some change was rejected / carries an error
 *   review    — no activity for 20 min, nothing landed: a human should approve or land
 *   landed    — a land is live
 *   reverted  — every land of the task was reverted
 */
export function deriveBoard(/** @type {WcpEvent[]} */ events, /** @type {D1Task[]} */ d1 = [], now = Date.now()) {
  /** @type {Map<string, WcpEvent[]>} */
  const byTask = new Map();
  for (const e of events) {
    if (!e.task) continue;
    const l = byTask.get(e.task) ?? [];
    l.push(e);
    byTask.set(e.task, l);
  }
  const ids = new Set([...byTask.keys(), ...d1.map((t) => t.task)]);
  const ops = deriveOps(events);
  const approved = approvals(events);
  const cards = [];
  for (const id of ids) {
    const evs = (byTask.get(id) ?? []).sort((a, b) => a.seq - b.seq);
    const meta = d1.find((t) => t.task === id);
    /** @type {Set<string>} */
    const changes = new Set();
    for (const e of evs) if (e.change) changes.add(e.change);
    for (const c of meta?.candidates ?? []) changes.add(c.change);
    /** @type {Set<string>} */
    const agents = new Set();
    for (const e of evs) if (e.actor?.type === "agent" && e.agent) agents.add(e.agent);
    for (const c of meta?.candidates ?? []) if (c.agent) agents.add(c.agent);
    const sq = { error: 0, warning: 0, info: 0 };
    let blocked = 0;
    let edits = 0;
    /** @type {Map<string, WcpEvent>} */
    const latestPerChange = new Map();
    for (const e of evs) {
      for (const d of e.diagnostics) sq[d.severity]++;
      if (e.kind === "edit") e.status === "rejected" ? blocked++ : edits++;
      if (e.change && (e.kind === "edit" || e.kind === "claim" || e.kind === "release" || e.kind === "land")) latestPerChange.set(e.change, e);
    }
    const lands = ops.filter((o) => o.type === "land" && o.task === id);
    const live = lands.filter((o) => o.state !== "reverted");
    const conflicted = [...latestPerChange.values()].some((e) => e.kind === "edit" && worstSeverity(e) === "error");
    const last = evs.at(-1);
    const lastTs = last?.ts ?? meta?.updated_at;
    const recent = lastTs ? now - Date.parse(lastTs) < 20 * 60_000 : false;
    /** @type {string} */
    let column;
    if (live.length) column = "landed";
    else if (lands.length) column = "reverted";
    else if (!evs.length) column = "queued";
    else if (conflicted) column = "conflict";
    else if (!recent) column = "review"; // work stopped: awaiting approval / landing
    else column = "working";
    cards.push({
      task: id,
      title: meta?.title ?? titleFromEvents(evs) ?? id,
      column,
      candidates: Math.max(meta?.candidate_count ?? 0, changes.size),
      changes: [...changes],
      agents: [...agents],
      squiggles: sq,
      blocked,
      edits,
      events: evs.length,
      approved: [...changes].filter((c) => approved.has(c)),
      lands: lands.length,
      last_ts: lastTs,
    });
  }
  return cards.sort((a, b) => (b.last_ts ?? "").localeCompare(a.last_ts ?? ""));
}

/** Agents seen in the log with presence: live between join and leave. */
export function deriveAgents(/** @type {WcpEvent[]} */ events) {
  /** @type {Map<string, {agent: string, harness?: string, level?: number, sessions: Set<string>, task?: string, change?: string, last_ts: string, last_summary: string, events: number, squiggles: number}>} */
  const m = new Map();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.actor?.type !== "agent" || !e.agent) continue;
    const a = m.get(e.agent) ?? { agent: e.agent, sessions: new Set(), last_ts: e.ts, last_summary: e.summary, events: 0, squiggles: 0 };
    a.events++;
    a.squiggles += e.diagnostics.length;
    a.last_ts = e.ts;
    a.last_summary = e.summary;
    a.task = e.task ?? a.task;
    a.change = e.change ?? a.change;
    if (e.actor.harness) a.harness = e.actor.harness;
    if (e.kind === "join") {
      if (e.session) a.sessions.add(e.session);
      if (typeof e.payload?.level === "number") a.level = e.payload.level;
    }
    if (e.kind === "leave" && e.session) a.sessions.delete(e.session);
    m.set(e.agent, a);
  }
  return [...m.values()].sort((x, y) => y.last_ts.localeCompare(x.last_ts));
}

/** Outcome metrics mirrored to the Analytics Engine dashboard. */
export function deriveMetrics(/** @type {WcpEvent[]} */ events) {
  /** @type {Map<string, {first:number,harness:string,model:string,landed:boolean,landMs?:number}>} */
  const changes = new Map();
  let conflictsCaught = 0;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.status === "rejected" || e.diagnostics.some((d) => d.severity === "error")) conflictsCaught++;
    if (!e.change) continue;
    const ts = Date.parse(e.ts);
    const prev = changes.get(e.change);
    const model = String(e.payload?.model ?? e.payload?.model_id ?? "unknown");
    const c = prev ?? { first: ts, harness: e.actor?.harness ?? "unknown", model, landed: false };
    if (e.actor?.harness) c.harness = e.actor.harness;
    if (model !== "unknown") c.model = model;
    if (e.kind === "land" && e.status === "accepted" && !c.landed) {
      c.landed = true;
      c.landMs = Math.max(0, ts - c.first);
    }
    changes.set(e.change, c);
  }
  const all = [...changes.values()];
  const landed = all.filter((c) => c.landed);
  const times = landed.map((c) => c.landMs).filter((n) => typeof n === "number");
  /** @type {Map<string, {harness:string,model:string,attempts:number,landed:number}>} */
  const groups = new Map();
  for (const c of all) {
    const key = `${c.harness}\u0000${c.model}`;
    const g = groups.get(key) ?? { harness: c.harness, model: c.model, attempts: 0, landed: 0 };
    g.attempts++;
    if (c.landed) g.landed++;
    groups.set(key, g);
  }
  return {
    attempts: all.length,
    landed: landed.length,
    landingRate: all.length ? landed.length / all.length : 0,
    conflictsCaught,
    averageTimeToLandMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
    byHarnessModel: [...groups.values()].map((g) => ({ ...g, successRate: g.attempts ? g.landed / g.attempts : 0 })).sort((a, b) => b.attempts - a.attempts),
  };
}

/** Insert/replace an event in a seq-keyed store; returns true when it is new. */
export function upsert(/** @type {Map<number, WcpEvent>} */ store, /** @type {WcpEvent} */ e) {
  const had = store.has(e.seq);
  const prev = store.get(e.seq);
  // keep a diff we already fetched (list views omit it)
  store.set(e.seq, prev?.diff && !e.diff ? { ...e, diff: prev.diff } : e);
  return !had;
}

export const KIND_LABEL = /** @type {Record<string,string>} */ ({
  edit: "edit",
  intent: "intent",
  checkpoint: "push",
  claim: "claim",
  release: "release",
  "negotiate.propose": "propose",
  "negotiate.counter": "counter",
  "negotiate.accept": "accept",
  "negotiate.reject": "reject",
  message: "message",
  control: "control",
  land: "land",
  revert: "revert",
  join: "join",
  leave: "leave",
});

export const WRITE_TAG = /** @type {Record<string,string>} */ ({ signature: "sig", deleted: "del", body: "body", new: "new" });
