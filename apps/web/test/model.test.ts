// Pure UI model (public/lib/model.js): op log states, board columns, per-change stats,
// diff stats, task titles, agent presence.

import { describe, expect, it } from "vitest";
import {
  agentHue, approvals, changeStats, deriveAgents, deriveBoard, deriveOps, diffLines, diffStats,
  symbolName, titleFromEvents, upsert, worstSeverity, type WcpEvent,
} from "../public/lib/model.js";

let seq = 0;
const T0 = Date.parse("2026-10-04T04:00:00Z");
function ev(p: Partial<WcpEvent> & { kind: string }): WcpEvent {
  seq++;
  return {
    seq,
    status: "accepted",
    ts: new Date(T0 + seq * 1000).toISOString(),
    actor: { type: "agent", id: p.agent ?? "claude-a", harness: "claude-code" },
    agent: "claude-a",
    files: [],
    reads: [],
    writes: [],
    summary: `${p.kind} #${seq}`,
    diagnostics: [],
    ...p,
  } as WcpEvent;
}

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 keep
-old
+new
+added
`;

describe("model", () => {
  it("diffStats/diffLines count only content lines", () => {
    expect(diffStats(DIFF)).toEqual({ add: 2, del: 1, files: ["src/a.ts"] });
    expect(diffStats(undefined)).toEqual({ add: 0, del: 0, files: [] });
    expect(diffLines(DIFF).map((l) => l.type)).toEqual(["file", "file", "file", "hunk", "ctx", "del", "add", "add", "ctx"]);
  });

  it("symbolName and agentHue are stable", () => {
    expect(symbolName("src/auth/session.ts#SessionStore.get")).toBe("SessionStore.get");
    expect(symbolName("packages/x/install.py#*")).toBe("install.py");
    expect(agentHue("claude-a")).toBe(agentHue("claude-a"));
    expect(agentHue("claude-a")).not.toBe(agentHue("codex-b"));
  });

  it("op log: land -> undo requested -> reverted; revert ops listed; approvals tracked", () => {
    seq = 0;
    const evs = [
      ev({ kind: "edit", task: "t1", change: "c1", writes: [{ key: "a#f", kind: "body" }] }),
      ev({ kind: "land", task: "t1", change: "c1", actor: { type: "system", id: "lander" }, payload: { sha: "abc1234def", op_id: "op-1" }, writes: [{ key: "a#f", kind: "body" }] }),
      ev({ kind: "land", task: "t2", change: "c2", actor: { type: "system", id: "lander" }, payload: { sha: "fff", op_id: "op-2" } }),
      ev({ kind: "control", actor: { type: "human", id: "john" }, payload: { action: "undo", target: { seq: 2, op_id: "op-1" } } }),
      ev({ kind: "control", actor: { type: "human", id: "john" }, payload: { action: "approve", target: { change: "c2" } } }),
    ];
    let ops = deriveOps(evs);
    expect(ops.map((o) => [o.seq, o.type, o.state])).toEqual([
      [3, "land", "live"],
      [2, "land", "undo_requested"],
    ]);
    evs.push(ev({ kind: "revert", actor: { type: "system", id: "reverter" }, payload: { op_id: "op-3", reverts_op_id: "op-1", reason: "error spike", requested_by: "john" } }));
    ops = deriveOps(evs);
    expect(ops.find((o) => o.seq === 2)).toMatchObject({ state: "reverted", revert_seq: 6, undo_seq: 4 });
    expect(ops[0]).toMatchObject({ type: "revert", reverts_seq: 2, reason: "error spike" });
    expect([...approvals(evs)]).toEqual([["c2", 5]]);
    // rejected lands are not ops
    expect(deriveOps([{ ...evs[1]!, status: "rejected" }])).toEqual([]);
  });

  it("changeStats rolls up edits, diff, squiggles, checkpoints and land state", () => {
    seq = 0;
    const diag = { severity: "error" as const, code: "stale_assumption", symbol: "a#f", message: "m", caused_by_seq: 1, caused_by_agent: "codex-b" };
    const evs = [
      ev({ kind: "edit", change: "c1", files: ["src/a.ts"], writes: [{ key: "a#f", kind: "signature" }], diff: DIFF }),
      ev({ kind: "edit", change: "c1", status: "rejected", diagnostics: [diag] }),
      ev({ kind: "checkpoint", change: "c1", payload: { sha: "1234567890" } }),
      ev({ kind: "edit", change: "c2", agent: "codex-b", files: ["src/b.ts"] }),
      ev({ kind: "land", change: "c1", actor: { type: "system", id: "l" }, payload: { sha: "x", op_id: "o" } }),
    ];
    const s = changeStats(evs, "c1");
    expect(s).toMatchObject({ edits: 1, blocked: 1, add: 2, del: 1, agent: "claude-a", harness: "claude-code", landed: 5 });
    expect([...s.files]).toEqual(["src/a.ts"]);
    expect(s.squiggles).toEqual({ error: 1, warning: 0, info: 0 });
    expect(s.checkpoints).toEqual([{ seq: 3, sha: "1234567890", ts: evs[2]!.ts }]);
    expect(worstSeverity(evs[1]!)).toBe("error");
    expect(worstSeverity(evs[0]!)).toBe(null);
  });

  it("board: merges D1 tasks with the log and assigns columns", () => {
    seq = 0;
    const err = { severity: "error" as const, code: "stale_overwrite", message: "m" };
    const evs = [
      ev({ kind: "edit", task: "t_work", change: "w1", intent: "t_work: Add retry budget" }),
      ev({ kind: "edit", task: "t_conf", change: "k1", status: "rejected", diagnostics: [err] }),
      ev({ kind: "edit", task: "t_land", change: "l1", summary: "claude-a changed f — Fix login" }),
      ev({ kind: "land", task: "t_land", change: "l1", actor: { type: "system", id: "l" }, payload: { sha: "s", op_id: "o1" } }),
      ev({ kind: "land", task: "t_rev", change: "r1", actor: { type: "system", id: "l" }, payload: { sha: "s", op_id: "o2" } }),
      ev({ kind: "revert", actor: { type: "system", id: "r" }, payload: { op_id: "o3", reverts_seq: 5 } }),
    ];
    const d1 = [
      { task: "t_queued", title: "Queued task", status: "open", candidate_count: 3, candidates: [] },
      { task: "t_work", title: "From D1", status: "open", candidate_count: 3, candidates: [{ change: "w1", n: 1, status: "open" }, { change: "w2", n: 2, status: "open", agent: "codex-b" }] },
    ];
    const now = T0 + 60_000;
    const board = Object.fromEntries(deriveBoard(evs, d1, now).map((c) => [c.task, c]));
    expect(board.t_queued).toMatchObject({ column: "queued", candidates: 3, title: "Queued task" });
    expect(board.t_work).toMatchObject({ column: "working", candidates: 3, title: "From D1" });
    expect(board.t_work!.agents.sort()).toEqual(["claude-a", "codex-b"]);
    expect(board.t_conf).toMatchObject({ column: "conflict", blocked: 1, squiggles: { error: 1, warning: 0, info: 0 } });
    expect(board.t_land).toMatchObject({ column: "landed", title: "Fix login", lands: 1 });
    expect(board.t_rev).toMatchObject({ column: "reverted" });
    // without D1, the title comes from the intent and stale multi-candidate work goes to review
    const later = Object.fromEntries(deriveBoard([...evs, ev({ kind: "edit", task: "t_work", change: "w2", agent: "codex-b" })], [], T0 + 3600_000).map((c) => [c.task, c]));
    expect(later.t_work).toMatchObject({ column: "review", title: "Add retry budget", candidates: 2 });
  });

  it("titleFromEvents prefers x_task_title, then intent, then summary", () => {
    expect(titleFromEvents([{ ...ev({ kind: "edit" }), x_task_title: "X" }])).toBe("X");
    expect(titleFromEvents([ev({ kind: "edit", task: "t_9", intent: "t_9: B9 web UI\nmore" })])).toBe("B9 web UI");
    expect(titleFromEvents([ev({ kind: "edit", summary: "a pushed checkpoint c — B7 sandbox runner" })])).toBe("B7 sandbox runner");
    expect(titleFromEvents([ev({ kind: "edit", summary: "plain" })])).toBeUndefined();
  });

  it("agents: presence between join and leave", () => {
    seq = 0;
    const evs = [
      ev({ kind: "join", agent: "a1", session: "s1", payload: { harness: "hermes", level: 3 }, actor: { type: "agent", id: "a1", harness: "hermes" } }),
      ev({ kind: "join", agent: "a2", session: "s2", actor: { type: "agent", id: "a2" } }),
      ev({ kind: "leave", agent: "a2", session: "s2", actor: { type: "agent", id: "a2" } }),
    ];
    const a = Object.fromEntries(deriveAgents(evs).map((x) => [x.agent, x]));
    expect(a.a1!.sessions.size).toBe(1);
    expect(a.a1!.level).toBe(3);
    expect(a.a2!.sessions.size).toBe(0);
  });

  it("upsert keeps a fetched diff when the list-view copy arrives", () => {
    const store = new Map<number, WcpEvent>();
    const full = { ...ev({ kind: "edit" }), diff: DIFF };
    expect(upsert(store, full)).toBe(true);
    const { diff: _d, ...list } = full;
    expect(upsert(store, list as WcpEvent)).toBe(false);
    expect(store.get(full.seq)!.diff).toBe(DIFF);
  });
});
