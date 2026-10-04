// The four Weft workflows (design §6.3–§6.6), written against StepLike + Deps so the same code
// runs as Cloudflare Workflows (src/index.ts) and under the Node tests (fake step, real git).
//
//   ProcessRevision  checkpoint push -> layered rebase onto trunk (git -> Mergiraf -> resolver
//                    agent -> bounce to the agent) -> tests in the sandbox -> evidence
//   LandChange       submit queue in the repo DO -> final rebase + presubmit -> CAS advance of
//                    trunk -> `land` (op log, claims released) -> close the task
//   RevertOperation  op log -> revert commit on trunk (CAS) -> `revert` -> task reopened with evidence
//   BestOfN          wait for N processed candidates -> rank -> approval when the risk tier requires
//                    it (waitForEvent) -> LandChange for the winner

import { bounceText, landOpId, needsApproval, rank, revertOpId, runJob, short, type Ranked } from "./common";
import { revisionStatus, Store } from "./store";
import type { BestOfNParams, ChangeRow, Deps, JobRequest, JobResult, LandChangeParams, ProcessRevisionParams, RepoConfig, RevertOperationParams, StepLike } from "./types";

type Ctx = {
  change: ChangeRow;
  trunk: { name: string; remote: string; branch: string };
  cfg: RepoConfig;
  title: string | null;
};

async function loadCtx(store: Store, repo: string, changeId: string): Promise<Ctx | { skip: string }> {
  const change = await store.change(repo, changeId);
  if (!change) return { skip: `unknown change ${changeId}` };
  const trunk = await store.trunk(repo);
  if (!trunk) return { skip: `repo ${repo} has no Artifacts trunk` };
  const task = await store.task(repo, change.task);
  return { change, trunk: { name: trunk.trunk, remote: trunk.remote, branch: trunk.default_branch }, cfg: trunk.cfg, title: task?.title ?? null };
}

function jobFor(ctx: Ctx, job: "rebase" | "land", sha: string, extra: Record<string, unknown>, access: { trunk: "read" | "write"; fork: "read" | "write" }): JobRequest {
  const c = ctx.change;
  return {
    repo: c.repo,
    task: c.task,
    change: c.id,
    config: ctx.cfg,
    trunk: { ...ctx.trunk, access: access.trunk },
    fork: { name: c.fork, remote: c.remote, branch: c.default_branch, access: access.fork },
    spec: {
      job,
      trunk: { remote: ctx.trunk.remote, branch: ctx.trunk.branch },
      fork: { remote: c.remote, branch: c.default_branch, sha },
      tests: ctx.cfg.tests ?? null,
      resolver: ctx.cfg.resolver ?? null,
      ...(ctx.cfg.layers ? { layers: ctx.cfg.layers } : {}),
      ...(ctx.title ? { intent: ctx.title } : {}),
      identity: { name: "weft-landing-queue", email: "landing@agents.weft.dev" },
      ...extra,
    },
  };
}

/** Evidence row for a rebase-ish job (rebase/land). */
function rebaseEvidence(r: JobResult) {
  return {
    status: r.status,
    layer: r.layer ?? null,
    onto: r.onto ?? null,
    head: r.head ?? null,
    rebased: r.rebased ?? null,
    commits: (r.commits ?? []).map((c) => ({ orig: c.orig, new: c.new, layer: c.layer })),
    ...(r.conflicts ? { conflicts: r.conflicts.map((c) => ({ file: c.file, commit: c.commit, hunks: c.hunks.length })) } : {}),
    ...(r.resolver ? { resolver: r.resolver } : {}),
    ...(r.diffstat ? { diffstat: r.diffstat } : {}),
    ...(r.pushed ? { pushed: r.pushed } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.timings ? { timings: r.timings } : {}),
    ...(r.run ? { run: r.run } : {}),
  };
}
function testEvidence(r: JobResult) {
  const t = r.tests!;
  return { status: t.status === "pass" ? ("pass" as const) : t.status === "fail" ? ("fail" as const) : ("info" as const), data: { ...t, onto: r.onto ?? null, sha: r.rebased ?? null } };
}

async function bounce(deps: Deps, ctx: Ctx, text: string, hint: string): Promise<number | null> {
  const coord = deps.coord(ctx.change.repo);
  const rec = await coord.system({
    kind: "message",
    base_seq: await coord.headSeq(),
    change: ctx.change.id,
    task: ctx.change.task,
    payload: { to: { change: ctx.change.id }, text, intent: "steer" },
    summary_hint: hint.slice(0, 140),
  });
  return rec.seq;
}

// =============================================================================== ProcessRevision

export type ProcessRevisionResult = { status: "skipped" | "processed" | "conflict" | "failed"; reason?: string; layer?: string; rebased?: string; onto?: string; tests?: string; bounced_seq?: number | null };

export async function processRevision(p: ProcessRevisionParams, step: StepLike, deps: Deps, instance: string): Promise<ProcessRevisionResult> {
  const store = new Store(deps.db, deps.now);
  const loaded = await step.do("load change", async () => {
    const ctx = await loadCtx(store, p.repo, p.change);
    if ("skip" in ctx) return ctx;
    if (ctx.change.status !== "open") return { skip: `change is ${ctx.change.status}` };
    // Coalesce bursts: only the newest head of a change is processed.
    if (ctx.change.head_sha && ctx.change.head_sha !== p.sha) {
      await store.setRevision(p.change, p.sha, { status: "superseded", workflow_id: instance });
      return { skip: `superseded by ${short(ctx.change.head_sha)}` };
    }
    await store.setRevision(p.change, p.sha, { status: "processing", workflow_id: instance });
    return ctx;
  });
  if ("skip" in loaded) return { status: "skipped", reason: loaded.skip };
  const ctx = loaded;

  const r = await runJob(step, deps, instance, "rebase", jobFor(ctx, "rebase", p.sha, { push_rebased: true }, { trunk: "read", fork: "write" }));
  const status = revisionStatus(r);

  await step.do("record evidence", async () => {
    await store.setRevision(p.change, p.sha, { status, onto_sha: r.onto ?? null, rebased_sha: r.rebased ?? null, layer: r.layer ?? null, processed: true });
    const ok = r.status === "up_to_date" || r.status === "clean" || r.status === "resolved";
    await store.evidence(p.change, p.sha, "rebase", ok ? "pass" : "fail", rebaseEvidence(r));
    if (r.tests) {
      const t = testEvidence(r);
      await store.evidence(p.change, p.sha, "test", t.status, t.data);
    }
    return null;
  });

  let bounced: number | null = null;
  if (r.status === "conflict")
    bounced = await step.do("bounce conflict to agent", () => bounce(deps, ctx, bounceText("conflict", r), `rebase conflict: ${(r.conflicts ?? []).map((c) => c.file).join(", ")}`));
  else if (r.tests?.status === "fail") bounced = await step.do("bounce failing tests to agent", () => bounce(deps, ctx, bounceText("tests", r), `tests fail after rebase onto ${short(r.onto)}`));

  await step.do("notify selection", async () => {
    await deps.launch.candidateReady(p.repo, ctx.change.task, { change: p.change, sha: p.sha, status }).catch(() => undefined);
    return null;
  });
  return {
    status,
    ...(r.layer ? { layer: r.layer } : {}),
    ...(r.rebased ? { rebased: r.rebased } : {}),
    ...(r.onto ? { onto: r.onto } : {}),
    ...(r.tests ? { tests: r.tests.status } : {}),
    ...(r.error ? { reason: r.error } : {}),
    bounced_seq: bounced,
  };
}

// =============================================================================== LandChange

export type LandChangeResult = { status: "landed" | "already_landed" | "failed" | "skipped"; reason?: string; op_id?: string; seq?: number | null; before?: string; after?: string; layer?: string; attempts?: number; queue_id?: number };

const MAX_LAND_ATTEMPTS = 3;

export async function landChange(p: LandChangeParams, step: StepLike, deps: Deps, instance: string): Promise<LandChangeResult> {
  const store = new Store(deps.db, deps.now);
  const loaded = await step.do("load change", async () => {
    const ctx = await loadCtx(store, p.repo, p.change);
    if ("skip" in ctx) return ctx;
    if (ctx.change.status === "landed") return { skip: "already_landed" };
    if (ctx.change.status !== "open") return { skip: `change is ${ctx.change.status}` };
    if (!ctx.change.head_sha) return { skip: "change has no pushed revision" };
    const rev = await store.revision(ctx.change.id, ctx.change.head_sha);
    return { ...ctx, rebased: rev?.rebased_sha && rev.onto_sha && rev.status === "processed" ? { sha: rev.rebased_sha, onto: rev.onto_sha, layer: rev.layer } : null };
  });
  if ("skip" in loaded) return loaded.skip === "already_landed" ? { status: "already_landed" } : { status: "skipped", reason: loaded.skip };
  const ctx = loaded;
  const coord = deps.coord(p.repo);

  // 1. Submit queue (the repo DO serializes landings): wait for our turn.
  const entry = await step.do("enqueue", () => coord.enqueue(p.change, p.requested_by, p.note ?? `workflow ${instance}`));
  const qp = deps.queuePoll ?? { interval: "10 seconds", max: 360 };
  for (let i = 0; ; i++) {
    const head = await step.do(`queue turn ${i}`, async () => {
      const q = await coord.queue(["queued", "landing"]);
      const mine = q.find((e) => e.id === entry.id);
      if (!mine) return { gone: true, first: null as number | null };
      return { gone: false, first: q[0]?.id ?? null };
    });
    if (head.gone) return { status: "failed", reason: "queue entry was cancelled", queue_id: entry.id };
    if (head.first === entry.id) break;
    if (i >= qp.max) {
      await step.do("queue timeout", () => coord.setQueueStatus(entry.id, "failed", "timed out waiting for the queue"));
      return { status: "failed", reason: "timed out waiting for the landing queue", queue_id: entry.id };
    }
    await step.sleep(`queue wait ${i}`, qp.interval);
  }
  await step.do("mark landing", () => coord.setQueueStatus(entry.id, "landing", `workflow ${instance}`));

  // 2. Final rebase + presubmit + CAS push (retry when another landing won the race).
  let r: JobResult = { status: "error", error: "not run" };
  let attempt = 0;
  for (attempt = 1; attempt <= MAX_LAND_ATTEMPTS; attempt++) {
    r = await runJob(step, deps, instance, `land ${attempt}`, jobFor(ctx, "land", ctx.change.head_sha!, attempt === 1 && ctx.rebased ? { rebased: ctx.rebased } : {}, { trunk: "write", fork: "read" }));
    if (r.status !== "stale_trunk") break;
  }
  const sha = ctx.change.head_sha!;

  if (r.status !== "landed") {
    const reason = r.status === "tests_failed" ? "presubmit failed" : r.status === "conflict" ? "rebase conflict" : r.status === "stale_trunk" ? `trunk kept moving (${MAX_LAND_ATTEMPTS} attempts)` : (r.error ?? r.detail ?? r.status);
    await step.do("record failure", async () => {
      await store.evidence(p.change, sha, "land", "fail", { ...rebaseEvidence(r), attempts: attempt, reason });
      if (r.tests) {
        const t = testEvidence(r);
        await store.evidence(p.change, sha, "presubmit", t.status, t.data);
      }
      await coord.setQueueStatus(entry.id, "failed", reason.slice(0, 300));
      return null;
    });
    if (r.status === "conflict") await step.do("bounce conflict to agent", () => bounce(deps, ctx, bounceText("conflict", r), "landing blocked: rebase conflict"));
    else if (r.status === "tests_failed") await step.do("bounce failing presubmit to agent", () => bounce(deps, ctx, bounceText("tests", r), "landing blocked: presubmit fails"));
    return { status: "failed", reason, attempts: attempt, queue_id: entry.id, ...(r.layer ? { layer: r.layer } : {}) };
  }

  // 3. Op log: `land` in the repo DO (releases claims, marks the queue entry, tells other agents).
  const logged = await step.do("append land", async () => {
    const opId = await landOpId(p.repo, p.change, r.after!);
    const existing = (await coord.ops()).find((o) => o.op_id === opId);
    if (existing) return { op_id: opId, seq: existing.seq, status: "accepted" };
    const rec = await coord.system({
      kind: "land",
      base_seq: await coord.headSeq(),
      change: p.change,
      task: ctx.change.task,
      payload: { sha: r.after!, op_id: opId, trunk_ref: `refs/heads/${ctx.trunk.branch}` },
      summary_hint: `landed ${ctx.change.agent ?? short(p.change)}: ${ctx.title ?? ctx.change.task} (${short(r.after)})`.slice(0, 140),
    });
    return { op_id: opId, seq: rec.seq, status: rec.status };
  });

  // 4. Close the card: change landed, task landed, sibling candidates closed, evidence.
  await step.do("close task", async () => {
    await store.recordLanding({ op_id: logged.op_id, repo: p.repo, kind: "land", change_id: p.change, task: ctx.change.task, before: r.before!, after: r.after!, seq: logged.seq, status: "landed", layer: r.layer ?? null, requested_by: p.requested_by, workflow_id: instance });
    await store.evidence(p.change, sha, "land", "pass", { ...rebaseEvidence(r), op_id: logged.op_id, seq: logged.seq, before: r.before, after: r.after, attempts: attempt });
    if (r.tests) {
      const t = testEvidence(r);
      await store.evidence(p.change, sha, "presubmit", t.status, t.data);
    }
    await store.setChangeStatus(p.change, "landed");
    await store.setTaskStatus(p.repo, ctx.change.task, "landed");
    await store.closeSiblings(p.repo, ctx.change.task, p.change);
    if (logged.status !== "accepted") await coord.setQueueStatus(entry.id, "landed", `git landed ${short(r.after)}; land record ${logged.status}`);
    return null;
  });
  return { status: "landed", op_id: logged.op_id, seq: logged.seq, before: r.before!, after: r.after!, ...(r.layer ? { layer: r.layer } : {}), attempts: attempt, queue_id: entry.id };
}

// =============================================================================== RevertOperation

export type RevertResult = { status: "reverted" | "already_reverted" | "failed"; reason?: string; op_id?: string; reverts_op_id?: string; seq?: number; sha?: string };

export async function revertOperation(p: RevertOperationParams, step: StepLike, deps: Deps, instance: string): Promise<RevertResult> {
  const store = new Store(deps.db, deps.now);
  const coord = deps.coord(p.repo);
  const target = await step.do("find op", async () => {
    const ops = await coord.ops();
    const op = ops.find((o) => o.kind === "land" && (p.op_id ? o.op_id === p.op_id : o.seq === p.seq));
    if (!op) return { missing: `no land op ${p.op_id ?? `#${p.seq}`} in the op log` };
    if (ops.some((o) => o.kind === "revert" && (o.reverts_op_id === op.op_id || o.reverts_seq === op.seq))) return { done: op.op_id };
    const landing = await store.landing(op.op_id);
    const trunk = await store.trunk(p.repo);
    if (!trunk) return { missing: `repo ${p.repo} has no Artifacts trunk` };
    const change = op.change_id ? await store.change(p.repo, op.change_id) : null;
    return { op, before: landing?.before_sha ?? null, after: landing?.after_sha ?? op.sha!, trunk: { name: trunk.trunk, remote: trunk.remote, branch: trunk.default_branch }, cfg: trunk.cfg, task: change?.task ?? landing?.task ?? null, agent: change?.agent ?? null };
  });
  if ("missing" in target) return { status: "failed", reason: target.missing };
  if ("done" in target) return { status: "already_reverted", reverts_op_id: target.done };

  let r: JobResult = { status: "error" };
  for (let attempt = 1; attempt <= MAX_LAND_ATTEMPTS; attempt++) {
    r = await runJob(step, deps, instance, `revert ${attempt}`, {
      repo: p.repo,
      task: target.task ?? "revert",
      change: target.op.change_id ?? "revert",
      config: target.cfg,
      trunk: { ...target.trunk, access: "write" },
      spec: {
        job: "revert",
        trunk: { remote: target.trunk.remote, branch: target.trunk.branch },
        revert: { before: target.before, after: target.after, op_id: target.op.op_id, change: target.op.change_id, reason: p.reason },
        layers: ["git", "mergiraf"],
        identity: { name: "weft-revert", email: "revert@agents.weft.dev" },
      },
    });
    if (r.status !== "stale_trunk") break;
  }
  if (r.status !== "reverted") {
    const reason = r.status === "conflict" ? `revert conflicts with later trunk changes in ${(r.conflicts ?? []).map((c) => c.file).join(", ")}` : (r.error ?? r.detail ?? r.status);
    await step.do("record failure", async () => {
      if (target.op.change_id) await store.evidence(target.op.change_id, target.after, "revert", "fail", { reason, requested: p.reason, op_id: target.op.op_id, ...rebaseEvidence(r) });
      return null;
    });
    return { status: "failed", reason };
  }

  const logged = await step.do("append revert", async () => {
    const opId = await revertOpId(p.repo, target.op.op_id, r.after!);
    const existing = (await coord.ops()).find((o) => o.op_id === opId);
    if (existing) return { op_id: opId, seq: existing.seq };
    const rec = await coord.system({
      kind: "revert",
      base_seq: await coord.headSeq(),
      ...(target.op.change_id ? { change: target.op.change_id } : {}),
      ...(target.task ? { task: target.task } : {}),
      payload: { op_id: opId, reverts_op_id: target.op.op_id, reverts_seq: target.op.seq, sha: r.after!, reason: p.reason, ...(p.requested_by ? { requested_by: p.requested_by } : {}) },
      summary_hint: `reverted #${target.op.seq}: ${p.reason}`.slice(0, 140),
    });
    return { op_id: opId, seq: rec.seq };
  });

  await step.do("reopen task", async () => {
    await store.recordLanding({ op_id: logged.op_id, repo: p.repo, kind: "revert", change_id: target.op.change_id, task: target.task, before: r.before!, after: r.after!, seq: logged.seq, status: "done", requested_by: p.requested_by ?? null, workflow_id: instance, reverts_op_id: target.op.op_id, reason: p.reason });
    await store.setLandingStatus(target.op.op_id, "reverted");
    if (target.op.change_id) {
      await store.setChangeStatus(target.op.change_id, "reverted");
      await store.evidence(target.op.change_id, target.after, p.evidence?.kind ?? "revert", "fail", { reason: p.reason, op_id: logged.op_id, reverts_op_id: target.op.op_id, revert_sha: r.after, requested_by: p.requested_by ?? null, ...(p.evidence ? { evidence: p.evidence } : {}) }, p.evidence?.uri);
    }
    if (target.task) await store.setTaskStatus(p.repo, target.task, "open");
    return null;
  });
  if (target.op.change_id) {
    const change = await step.do("load reverted change", () => store.change(p.repo, target.op.change_id!));
    if (change)
      await step.do("tell the agent", () =>
        bounce(deps, { change, trunk: target.trunk, cfg: target.cfg, title: null }, bounceText("revert", { reason: p.reason, ...(p.evidence?.text ? { evidence: p.evidence.text } : {}) }), `reverted: ${p.reason}`),
      );
  }
  return { status: "reverted", op_id: logged.op_id, reverts_op_id: target.op.op_id, seq: logged.seq, sha: r.after! };
}

// =============================================================================== BestOfN

export type BestOfNResult = { status: "landing" | "approval_timeout" | "no_candidates" | "rejected"; winner?: string; ranking?: Ranked[]; approved_by?: string; land_instance?: string; waited?: number };

export async function bestOfN(p: BestOfNParams, step: StepLike, deps: Deps, instance: string): Promise<BestOfNResult> {
  const store = new Store(deps.db, deps.now);
  const t0 = await step.do("start", async () => ({ at: deps.now(), risk: p.risk ?? (await store.task(p.repo, p.task))?.risk ?? "low" }));
  const deadline = t0.at + (p.collect_timeout_s ?? 7200) * 1000;
  const poll = `${p.poll_s ?? 60} seconds` as const;

  // 1. Wait until N candidates are processed (or all open ones are, or the deadline passes).
  let snapshot = await step.do("collect 0", () => store.candidates(p.repo, p.task));
  let i = 0;
  const settled = (s: typeof snapshot) => s.filter((c) => c.revision && ["processed", "conflict", "failed"].includes(c.revision.status));
  while (settled(snapshot).filter((c) => c.revision!.status === "processed").length < p.n) {
    const now = await step.do(`clock ${i}`, async () => deps.now());
    if (now >= deadline) break;
    try {
      await step.waitForEvent(`candidate ${i}`, { type: "candidate", timeout: poll });
    } catch {
      /* timeout: re-check D1 (events may arrive before the instance waits) */
    }
    i++;
    snapshot = await step.do(`collect ${i}`, () => store.candidates(p.repo, p.task));
  }

  // 2. Rank.
  const ranking = rank(snapshot);
  await step.do("record ranking", async () => {
    let pos = 0;
    for (const r of ranking) {
      const c = snapshot.find((x) => x.change === r.change)!;
      if (c.head) await store.evidence(r.change, c.head, "rank", r.eligible ? "info" : "fail", { position: ++pos, of: ranking.length, score: r.score, reasons: r.reasons, eligible: r.eligible, risk: t0.risk, workflow: instance });
    }
    return null;
  });
  const eligible = ranking.filter((r) => r.eligible);
  if (!eligible.length) return { status: "no_candidates", ranking, waited: i };

  // 3. Risk tier: low lands the top candidate; medium/high wait for a human approve.
  let winner = eligible[0]!.change;
  let approvedBy: string | undefined;
  if (needsApproval(t0.risk)) {
    let ev: { payload: { change?: string; by?: string; reject?: boolean } };
    try {
      ev = await step.waitForEvent<{ change?: string; by?: string; reject?: boolean }>("approval", { type: "approval", timeout: `${p.approval_timeout_s ?? 86_400} seconds` });
    } catch {
      return { status: "approval_timeout", ranking, waited: i };
    }
    if (ev.payload.reject) return { status: "rejected", ranking, ...(ev.payload.by ? { approved_by: ev.payload.by } : {}), waited: i };
    if (ev.payload.change && ranking.some((r) => r.change === ev.payload.change)) winner = ev.payload.change;
    approvedBy = ev.payload.by ?? "human";
  }

  // 4. Land it.
  const land = await step.do("start landing", () => deps.launch.land({ repo: p.repo, change: winner, requested_by: approvedBy ? `human:${approvedBy}` : `workflow:${instance}`, note: `best-of-${p.n} winner` }));
  return { status: "landing", winner, ranking, ...(approvedBy ? { approved_by: approvedBy } : {}), land_instance: land, waited: i };
}

export { ids } from "./ids";
