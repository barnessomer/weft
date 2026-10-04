// The four workflows end to end against real git + Mergiraf, a journaled repo coordinator and D1.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { bounceText, instanceId, needsApproval, rank } from "../src/core/common";
import { ids } from "../src/core/ids";
import { BASE, FakeStep, sub, world } from "./harness";

const hasMergiraf = (() => {
  try {
    execFileSync("mergiraf", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();
const P = BASE["src/pricing.ts"]!;

describe("ProcessRevision", () => {
  it("rebases a checkpoint onto trunk, runs tests in the job, records evidence, pushes weft/rebased", async () => {
    const w = await world();
    const a = await w.candidate("t1", "claude-a");
    const sha = await a.push({ "src/cart.ts": "export const cart: string[] = ['pear'];\n" }, "cart: start with a pear");
    const onto = await w.trunkCommit({ "README.md": "# shop\n" }, "readme");
    const step = new FakeStep();
    const r = await w.wf.process(a, sha, step);
    expect(r).toMatchObject({ status: "processed", layer: "git", onto, tests: "pass", bounced_seq: null });
    const [rev] = w.q<{ status: string; onto_sha: string; rebased_sha: string; layer: string; workflow_id: string }>(`SELECT * FROM revisions WHERE change_id = ?`, a.change);
    expect(rev).toMatchObject({ status: "processed", onto_sha: onto, layer: "git", workflow_id: `rev-${sha.slice(0, 8)}` });
    expect(w.tip(a.remote, "refs/heads/weft/rebased")).toBe(rev!.rebased_sha);
    const ev = w.q<{ kind: string; status: string; data: string }>(`SELECT kind, status, data FROM evidence WHERE change_id = ? ORDER BY id`, a.change);
    expect(ev.map((e) => [e.kind, e.status])).toEqual([
      ["rebase", "pass"],
      ["test", "pass"],
    ]);
    expect(JSON.parse(ev[1]!.data).summary).toEqual({ pass: 1, fail: 0 });
    // the job polled at least once before finishing (durable sleep between polls)
    expect(step.sleeps).toContain("rebase: wait 0");
    expect(w.signals).toEqual([{ repo: "weft-demo", task: "t1", payload: { change: a.change, sha, status: "processed" } }]);
    // tokens never enter step output
    expect(JSON.stringify([...step.cache.values()])).not.toMatch(/art_v1_/);
  });

  it.skipIf(!hasMergiraf)("uses Mergiraf when git conflicts on adjacent lines", async () => {
    const w = await world();
    const a = await w.candidate("t1", "claude-a");
    const sha = await a.push({ "src/pricing.ts": sub(P, "pear: 2", "pear: 3") }, "pear 3");
    await w.trunkCommit({ "src/pricing.ts": sub(P, "apple: 1", "apple: 5") }, "apple 5");
    const r = await w.wf.process(a, sha);
    expect(r).toMatchObject({ status: "processed", layer: "mergiraf", tests: "pass" });
    const merged = await w.show(r.rebased!, "src/pricing.ts", a.remote);
    expect(merged).toContain("apple: 5");
    expect(merged).toContain("pear: 3");
  });

  it("bounces a real conflict to the agent as a WCP message (inbox) with the hunks", async () => {
    const w = await world();
    const a = await w.candidate("t1", "claude-a");
    const sha = await a.push({ "src/pricing.ts": sub(P, "apple: 1", "apple: 2") }, "apple 2");
    await w.trunkCommit({ "src/pricing.ts": sub(P, "apple: 1", "apple: 3") }, "apple 3");
    const r = await w.wf.process(a, sha);
    expect(r.status).toBe("conflict");
    expect(r.bounced_seq).toBeGreaterThan(0);
    const inbox = w.j.call<{ items: Array<{ kind: string; record?: { payload?: { text?: string }; actor: { type: string } } }> }>("drain", a.session);
    const msg = inbox.items.find((i) => i.kind === "message");
    expect(msg?.record?.actor.type).toBe("system");
    expect(msg?.record?.payload?.text).toContain("src/pricing.ts");
    expect(msg?.record?.payload?.text).toContain("<<<<<<<");
    expect(w.q(`SELECT status FROM revisions WHERE change_id = ?`, a.change)).toEqual([{ status: "conflict" }]);
    expect(w.q(`SELECT kind, status FROM evidence WHERE change_id = ?`, a.change)).toEqual([{ kind: "rebase", status: "fail" }]);
  });

  it("bounces failing tests (rebased result) and records the failure", async () => {
    const w = await world();
    const a = await w.candidate("t1", "claude-a");
    const sha = await a.push({ "src/pricing.ts": P.replace("s + (", "s - (") }, "pricing: subtract (bug)");
    const r = await w.wf.process(a, sha);
    expect(r).toMatchObject({ status: "processed", tests: "fail" });
    expect(r.bounced_seq).toBeGreaterThan(0);
    expect(w.q(`SELECT kind, status FROM evidence WHERE change_id = ? ORDER BY id`, a.change)).toEqual([
      { kind: "rebase", status: "pass" },
      { kind: "test", status: "fail" },
    ]);
  });

  it("coalesces: an older checkpoint is skipped when the change moved on", async () => {
    const w = await world();
    const a = await w.candidate("t1", "claude-a");
    const old = await a.push({ "src/cart.ts": "export const cart = [1];\n" }, "one");
    await a.push({ "src/cart.ts": "export const cart = [2];\n" }, "two");
    const r = await w.wf.process(a, old);
    expect(r).toEqual({ status: "skipped", reason: expect.stringMatching(/^superseded by/) });
    expect(w.jobs.started).toHaveLength(0);
  });

  it("replays deterministically: re-running with the persisted step state starts no new job", async () => {
    const w = await world();
    const a = await w.candidate("t1", "claude-a");
    const sha = await a.push({ "src/cart.ts": "export const cart = ['x'];\n" }, "x");
    const step = new FakeStep();
    const r1 = await w.wf.process(a, sha, step);
    const n = w.jobs.started.length;
    const r2 = await w.wf.process(a, sha, step);
    expect(r2).toEqual(r1);
    expect(w.jobs.started).toHaveLength(n);
    expect(w.q(`SELECT COUNT(*) AS n FROM evidence`)).toEqual([{ n: 2 }]);
  });
});

describe("LandChange", () => {
  it("lands two candidates in queue order: CAS trunk advance, land ops, claims released, card closed", async () => {
    const w = await world();
    const a = await w.candidate("t1", "claude-a");
    const b = await w.candidate("t2", "codex-b");
    const loser = await w.candidate("t1", "cursor-c");
    // A edits `pricing` (soft claim via an edit event), B edits the cart.
    w.j.call("submit", a.session, { type: "submit", mode: "commit", event: { kind: "edit", base_seq: 1, files: ["src/pricing.ts"], writes: [{ key: "src/pricing.ts#PRICES", kind: "body" }] } });
    await a.push({ "src/pricing.ts": sub(P, "apple: 1", "apple: 5") }, "apple 5");
    await b.push({ "src/cart.ts": "export const cart: string[] = ['pear'];\n" }, "cart pear");
    const t0 = w.tip();

    const ra = await w.wf.land(a);
    expect(ra).toMatchObject({ status: "landed", before: t0, attempts: 1 });
    expect(w.tip()).toBe(ra.after);
    const rb = await w.wf.land(b);
    expect(rb).toMatchObject({ status: "landed", before: ra.after, layer: "git" });
    expect(w.tip()).toBe(rb.after);
    // both changes are on trunk, with their trailers
    expect(await w.show(rb.after!, "src/pricing.ts")).toContain("apple: 5");
    expect(await w.show(rb.after!, "src/cart.ts")).toContain("pear");

    // op log + queue in the repo DO
    const ops = w.j.coord.ops() as Array<{ op_id: string; kind: string; change_id: string; sha: string }>;
    expect(ops.map((o) => [o.kind, o.change_id, o.sha])).toEqual([
      ["land", a.change, ra.after],
      ["land", b.change, rb.after],
    ]);
    expect(ops[0]!.op_id).toBe(ra.op_id);
    expect(w.j.coord.queue(["queued", "landing", "landed"]).map((e) => [e.change, e.status])).toEqual([
      [a.change, "landed"],
      [b.change, "landed"],
    ]);
    // A's soft claim from its edit is released by the land
    expect(w.sql.exec(`SELECT * FROM claims WHERE change_id = ?`, a.change).toArray()).toEqual([]);
    // D1: change/task landed, sibling candidate closed, landing rows + evidence
    expect(w.q(`SELECT id, status FROM changes ORDER BY n, task`).map((r) => r)).toEqual(
      expect.arrayContaining([
        { id: a.change, status: "landed" },
        { id: b.change, status: "landed" },
        { id: loser.change, status: "closed" },
      ]),
    );
    expect(w.q(`SELECT id, status FROM tasks ORDER BY id`)).toEqual([
      { id: "t1", status: "landed" },
      { id: "t2", status: "landed" },
    ]);
    expect(w.q(`SELECT op_id, kind, before_sha, after_sha, status FROM landings ORDER BY created_at`)).toEqual([
      { op_id: ra.op_id, kind: "land", before_sha: t0, after_sha: ra.after, status: "landed" },
      { op_id: rb.op_id, kind: "land", before_sha: ra.after, after_sha: rb.after, status: "landed" },
    ]);
    expect(w.q(`SELECT kind, status FROM evidence WHERE change_id = ? ORDER BY id`, b.change)).toEqual([
      { kind: "land", status: "pass" },
      { kind: "presubmit", status: "pass" },
    ]);
    // landing again is a no-op
    expect(await w.wf.land(a)).toEqual({ status: "already_landed" });
  });

  it("waits for its turn in the submit queue", async () => {
    const w = await world();
    const a = await w.candidate("t1", "claude-a");
    const b = await w.candidate("t2", "codex-b");
    await a.push({ "src/cart.ts": "export const cart = ['a'];\n" }, "a");
    await b.push({ "README.md": "b\n" }, "b");
    const first = w.j.call<{ id: number }>("enqueue", a.change, "human:john"); // A is ahead (another workflow)
    const step = new FakeStep();
    step.onSleep = (name) => {
      if (name === "queue wait 1") w.j.call("queue_status", first.id, "cancelled", "test: A gave up");
    };
    const r = await w.wf.land(b, step);
    expect(r.status).toBe("landed");
    expect(step.sleeps.filter((s) => s.startsWith("queue wait"))).toEqual(["queue wait 0", "queue wait 1"]);
  });

  it("retries the CAS when another landing wins the race during presubmit", async () => {
    const w = await world();
    const a = await w.candidate("t1", "claude-a");
    await a.push({ "src/cart.ts": "export const cart = ['a'];\n" }, "a");
    let raced = false;
    w.jobs.beforeJob = async (req) => {
      if (req.spec.job === "land" && !raced) {
        raced = true;
        // the job runs `git fetch` after this hook, so race inside the presubmit instead:
        (req.spec as Record<string, unknown>).tests = { command: ["sh", "-c", `git clone -q ${req.trunk.remote} /tmp/weft-race-$$ && cd /tmp/weft-race-$$ && echo x > race.txt && git add . && git -c user.name=r -c user.email=r@r commit -qm race && git push -q origin HEAD:main`] };
      } else if (req.spec.job === "land") (req.spec as Record<string, unknown>).tests = { command: ["node", "--test"] };
    };
    const r = await w.wf.land(a);
    expect(r).toMatchObject({ status: "landed", attempts: 2 });
    expect(await w.show(r.after!, "race.txt")).toBe("x");
    expect(await w.show(r.after!, "src/cart.ts")).toContain("'a'");
  });

  it("presubmit failure: trunk untouched, queue entry failed, agent told", async () => {
    const w = await world();
    const a = await w.candidate("t1", "claude-a");
    await a.push({ "src/pricing.ts": P.replace("s + (", "s - (") }, "bug");
    const t0 = w.tip();
    const r = await w.wf.land(a);
    expect(r).toMatchObject({ status: "failed", reason: "presubmit failed" });
    expect(w.tip()).toBe(t0);
    expect(w.j.coord.queue(["failed"]).map((e) => e.change)).toEqual([a.change]);
    const inbox = w.j.call<{ items: Array<{ kind: string }> }>("drain", a.session);
    expect(inbox.items.map((i) => i.kind)).toContain("message");
    expect(w.q(`SELECT status FROM changes WHERE id = ?`, a.change)).toEqual([{ status: "open" }]);
  });
});

describe("RevertOperation", () => {
  it("reverts a landing from the op log on a moved trunk, appends `revert`, reopens the task with evidence", async () => {
    const w = await world();
    const a = await w.candidate("t1", "claude-a");
    await a.push({ "src/pricing.ts": sub(P, "apple: 1", "apple: 7") }, "apple 7 (planted bug)");
    const landed = await w.wf.land(a);
    await w.trunkCommit({ "NOTES.md": "later\n" }, "later work");
    const stack = "TypeError: price is NaN\n    at calcTotal (src/pricing.ts:7:12)";
    const r = await w.revertOperation({ repo: w.repo, op_id: landed.op_id!, reason: "error spike after landing", requested_by: "tail-worker", requested_by_type: "system", evidence: { kind: "error_spike", text: stack, uri: "https://example.invalid/trace/1" } }, new FakeStep(), w.deps, "revert-1");
    expect(r).toMatchObject({ status: "reverted", reverts_op_id: landed.op_id });
    expect(w.tip()).toBe(r.sha);
    expect(await w.show(r.sha!, "src/pricing.ts")).toBe(P.trim());
    expect(await w.show(r.sha!, "NOTES.md")).toBe("later");
    const ops = w.j.coord.ops() as Array<{ kind: string; reverts_op_id: string | null; op_id: string }>;
    expect(ops.map((o) => [o.kind, o.reverts_op_id])).toEqual([
      ["land", null],
      ["revert", landed.op_id],
    ]);
    const rec = w.j.coord.event(r.seq!);
    expect(rec).toMatchObject({ kind: "revert", status: "accepted", payload: { reason: "error spike after landing", requested_by: { type: "system", id: "tail-worker" }, reverts_seq: landed.seq } });
    expect(w.q(`SELECT status FROM tasks WHERE id = 't1'`)).toEqual([{ status: "open" }]);
    expect(w.q(`SELECT status FROM changes WHERE id = ?`, a.change)).toEqual([{ status: "reverted" }]);
    const ev = w.q<{ kind: string; uri: string; data: string }>(`SELECT kind, uri, data FROM evidence WHERE change_id = ? AND kind = 'error_spike'`, a.change);
    expect(ev[0]!.uri).toBe("https://example.invalid/trace/1");
    expect(JSON.parse(ev[0]!.data).evidence.text).toContain("price is NaN");
    expect(w.q(`SELECT status FROM landings WHERE op_id = ?`, landed.op_id)).toEqual([{ status: "reverted" }]);
    // the agent hears about it
    const inbox = w.j.call<{ items: Array<{ kind: string; record?: { payload?: { text?: string } } }> }>("drain", a.session);
    expect(inbox.items.some((i) => i.kind === "message" && i.record?.payload?.text?.includes("price is NaN"))).toBe(true);
    // idempotent
    expect(await w.revertOperation({ repo: w.repo, op_id: landed.op_id!, reason: "again" }, new FakeStep(), w.deps, "revert-2")).toEqual({ status: "already_reverted", reverts_op_id: landed.op_id });
    // by seq works too / unknown op fails
    expect((await w.revertOperation({ repo: w.repo, seq: 9999, reason: "x" }, new FakeStep(), w.deps, "revert-3")).status).toBe("failed");
  });
});

describe("BestOfN", () => {
  async function three(risk: "low" | "high") {
    const w = await world();
    const c1 = await w.candidate("t9", "claude-a", { risk });
    const c2 = await w.candidate("t9", "codex-b", { risk });
    const c3 = await w.candidate("t9", "cursor-c", { risk });
    const s1 = await c1.push({ "src/pricing.ts": P.replace("s + (", "s - (") }, "c1: broken");
    const s2 = await c2.push({ "src/cart.ts": "export const cart: string[] = ['apple', 'pear', 'apple', 'pear'];\n// long\n// comment\n" }, "c2: bigger");
    const s3 = await c3.push({ "src/cart.ts": "export const cart: string[] = ['apple'];\n" }, "c3: small");
    return { w, c: [c1, c2, c3], s: [s1, s2, s3] };
  }

  it("low risk: waits for N processed candidates, ranks (tests, rebase layer, churn), lands the winner", async () => {
    const { w, c, s } = await three("low");
    const step = new FakeStep();
    let k = 0;
    // candidates finish processing one by one while the workflow waits
    step.onWait = async (_name, type) => {
      if (type !== "candidate" || k >= 3) return undefined;
      const i = k++;
      await w.wf.process(c[i]!, s[i]!);
      return { type: "candidate", payload: { change: c[i]!.change } };
    };
    const r = await w.bestOfN({ repo: w.repo, task: "t9", n: 3 }, step, w.deps, "bon-t9");
    expect(r.status).toBe("landing");
    expect(r.winner).toBe(c[2]!.change);
    expect(r.ranking!.map((x) => [x.change, x.eligible])).toEqual([
      [c[2]!.change, true],
      [c[1]!.change, true],
      [c[0]!.change, false],
    ]);
    expect(w.landed).toEqual([{ repo: w.repo, change: c[2]!.change, requested_by: "workflow:bon-t9", note: "best-of-3 winner" }]);
    expect(w.q(`SELECT COUNT(*) AS n FROM evidence WHERE kind = 'rank'`)).toEqual([{ n: 3 }]);
  });

  it("high risk: ranks, then waits for a human approval event and lands the approved candidate", async () => {
    const { w, c, s } = await three("high");
    for (let i = 0; i < 3; i++) await w.wf.process(c[i]!, s[i]!);
    const step = new FakeStep();
    step.events.push({ type: "approve", payload: { change: c[1]!.change, by: "john" } });
    const r = await w.bestOfN({ repo: w.repo, task: "t9", n: 3 }, step, w.deps, "bon-t9");
    expect(r).toMatchObject({ status: "landing", winner: c[1]!.change, approved_by: "john" });
    expect(step.waits).toEqual(["approval"]);
    expect(w.landed[0]!.requested_by).toBe("human:john");
  });

  it("high risk without an approval times out and lands nothing", async () => {
    const { w, c, s } = await three("high");
    for (let i = 0; i < 3; i++) await w.wf.process(c[i]!, s[i]!);
    const r = await w.bestOfN({ repo: w.repo, task: "t9", n: 2 }, new FakeStep(), w.deps, "bon-t9");
    expect(r.status).toBe("approval_timeout");
    expect(w.landed).toEqual([]);
  });
});

describe("helpers", () => {
  it("instance ids are Workflows-safe", () => {
    expect(instanceId("bon", "weft-demo", "t_1.2:x")).toBe("bon-weft-demo-t_1_2_x");
    expect(instanceId("x", "a".repeat(200)).length).toBe(100);
    // same convention as apps/web (bestOfNInstanceId), so either can signal the instance
    expect(ids.bestOfN("weft-demo", "t_1.2")).toBe("bestofn-weft-demo-t_1_2");
  });
  it("risk tiers", () => {
    expect(needsApproval("low")).toBe(false);
    expect(needsApproval(undefined)).toBe(false);
    expect(needsApproval("medium")).toBe(true);
  });
  it("rank never picks a candidate whose tests fail", () => {
    const r = rank([
      { change: "A", n: 1, agent: null, head: "a", revision: { status: "processed" } as never, rebase: { status: "pass", data: { layer: "git" } }, test: { status: "fail", data: {} }, cost: null },
      { change: "B", n: 2, agent: null, head: "b", revision: { status: "processed" } as never, rebase: { status: "pass", data: { layer: "resolver" } }, test: { status: "pass", data: {} }, cost: null },
    ]);
    expect(r[0]!.change).toBe("B");
    expect(r[0]!.layer).toBe("resolver");
    expect(r[1]!.eligible).toBe(false);
  });
  it("bounce text quotes the conflict", () => {
    const t = bounceText("conflict", { onto: "abcdef1234567890", layer: "mergiraf", conflicts: [{ file: "src/a.ts", commit: "c", hunks: [{ line: 3, text: "<<<<<<< x\n=======\n>>>>>>> y" }] }] });
    expect(t).toContain("src/a.ts");
    expect(t).toContain("abcdef123456");
  });
});
