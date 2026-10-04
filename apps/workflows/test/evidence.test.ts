import { describe, expect, it } from "vitest";
import { extractJson, heuristicRisk, parseReview, parseRisk, reviewPrompt, xEvidenceFromRows, type EvidenceCapabilities, type ReviewInput } from "../src/core/evidence";
import { FakeStep, world } from "./harness";

type Rec = { seq: number; kind: string; change?: string; payload: Record<string, unknown> };
const events = (w: Awaited<ReturnType<typeof world>>): Rec[] => {
  const head = (w.j.coord.summary() as { head_seq: number }).head_seq;
  return Array.from({ length: head }, (_, i) => w.j.coord.event(i + 1) as unknown as Rec).filter(Boolean);
};

/** Fake capabilities that record what the pipeline handed them. */
function fakeCaps(seen: Record<string, unknown>, opts: { review?: "pass" | "fail"; risk?: "low" | "high"; noPreview?: boolean } = {}): EvidenceCapabilities {
  return {
    preview: async (i) => {
      seen.preview = i;
      if (opts.noPreview) return null;
      return { url: `https://previews.test/p/${i.candidate.repo}/${i.candidate.sha}/sig/`, trunk_url: i.trunk ? `https://previews.test/p/${i.trunk.repo}/${i.trunk.sha}/sig/` : null, routes: ["/", "/cart.html"], provider: "test" };
    },
    capture: async (i) => {
      seen.capture = i;
      return i.preview.routes.map((route, k) => ({
        route,
        candidate: { uri: `https://previews.test/e/s/${i.change}/${k}.png`, key: `screens/${k}.png`, width: 1280, height: 800 },
        trunk: { uri: `https://previews.test/e/s/trunk/${k}.png`, key: `trunk/${k}.png`, width: 1280, height: 800 },
        diff: { ratio: k === 0 ? 0.0125 : 0, pixels: k === 0 ? 12800 : 0, total: 1024000, uri: k === 0 ? `https://previews.test/e/s/${i.change}/${k}.diff.png` : null },
      }));
    },
    classify: async (i) => {
      seen.classify = i;
      return { risk: opts.risk ?? "low", reasons: ["cart contents only"], model: "@cf/test/risk" };
    },
    review: async (i: ReviewInput) => {
      seen.review = i;
      const v = opts.review ?? "pass";
      return { verdict: v, score: v === "pass" ? 90 : 20, summary: v === "pass" ? "Meets the criteria." : "Cart is wrong.", criteria: i.criteria.map((c) => ({ criterion: c, met: v === "pass", note: "" })), model: "@cf/test/review" };
    },
  };
}

describe("evidence: pure policy", () => {
  it("heuristic risk flags migrations/auth/deploy as high, deps/size as medium", () => {
    expect(heuristicRisk([{ status: "M", path: "src/cart.ts" }], { files: 1, insertions: 3, deletions: 1 }).risk).toBe("low");
    expect(heuristicRisk([{ status: "M", path: "package.json" }], null)).toMatchObject({ risk: "medium", reasons: ["dependencies: package.json"] });
    expect(heuristicRisk([{ status: "A", path: "apps/gateway/migrations/0003_x.sql" }], null).risk).toBe("high");
    expect(heuristicRisk([{ status: "M", path: "src/auth/session.ts" }], null).risk).toBe("high");
    expect(heuristicRisk([{ status: "M", path: "src/a.ts" }], { files: 1, insertions: 900, deletions: 0 }).risk).toBe("medium");
  });

  it("extracts JSON from chatty model output and validates verdicts", () => {
    expect(extractJson('Sure! ```json\n{"risk":"medium","reasons":["touches {config}"]}\n```')).toEqual({ risk: "medium", reasons: ["touches {config}"] });
    expect(parseRisk('{"risk":"HIGH","reasons":["drops a table"]}')).toEqual({ risk: "high", reasons: ["drops a table"] });
    expect(parseRisk('{"risk":"catastrophic"}')).toBeNull();
    expect(parseRisk("no json here")).toBeNull();
  });

  it("review parsing fails closed: a pass with an unmet or unknown criterion is downgraded", () => {
    const crit = ["Cart starts with an apple", "Tests pass"];
    expect(parseReview('{"verdict":"pass","score":95,"summary":"ok","criteria":[{"met":true},{"met":true}]}', crit, "m")).toMatchObject({ verdict: "pass", score: 95, criteria: [{ criterion: crit[0], met: true }, { criterion: crit[1], met: true }] });
    expect(parseReview('{"verdict":"pass","score":95,"criteria":[{"met":true},{"met":false}]}', crit, "m")!.verdict).toBe("fail");
    expect(parseReview('{"verdict":"pass","criteria":[{"met":true},{"met":null}]}', crit, "m")).toMatchObject({ verdict: "needs_human", score: 50 });
    expect(parseReview('{"verdict":"lgtm"}', crit, "m")).toBeNull();
  });

  it("the review prompt carries criteria, tests, visual diff and the diff", () => {
    const [sys, user] = reviewPrompt({ title: "Apple first", criteria: ["Cart starts with an apple"], patch: "+['apple']", files: [{ status: "M", path: "src/cart.ts" }], tests: { status: "pass", summary: { pass: 3, fail: 0 } }, visual: [{ route: "/", ratio: 0.0125 }], risk: "low" });
    expect(sys!.content).toContain('"verdict"');
    expect(user!.content).toContain("1. Cart starts with an apple");
    expect(user!.content).toContain("pass (3 passed, 0 failed)");
    expect(user!.content).toContain("/: 1.25% of pixels differ from trunk");
    expect(user!.content).toContain("+['apple']");
  });

  it("x_evidence from stored rows (land records)", () => {
    const x = xEvidenceFromRows([
      { kind: "test", status: "pass", data: JSON.stringify({ status: "pass", summary: { pass: 4, fail: 0 } }) },
      { kind: "preview", status: "pass", data: "{}", uri: "https://p/1/" },
      { kind: "screenshot", status: "pass", data: "{}", uri: "https://p/e/1.png" },
      { kind: "review", status: "pass", data: JSON.stringify({ verdict: "pass", summary: "fine", score: 88 }) },
      { kind: "risk", status: "info", data: JSON.stringify({ risk: "medium" }) },
      { kind: "cost", status: "info", data: JSON.stringify({ usd: 0.0123 }) },
    ]);
    expect(x).toEqual({ preview_url: "https://p/1/", tests: { passed: 4, failed: 0, total: 4 }, screenshots: ["https://p/e/1.png"], review: { verdict: "pass", summary: "fine", score: 88 }, risk: "medium", cost_usd: 0.0123 });
  });
});

describe("evidence: ProcessRevision → LandChange → BestOfN", () => {
  it("records preview, screenshots + visual diff, risk and review per revision, and stamps x_evidence on a checkpoint", async () => {
    const w = await world();
    const a = await w.candidate("t1", "claude-a", { title: "Pear first" });
    w.db.prepare(`UPDATE tasks SET acceptance = ? WHERE id = ?`).run(JSON.stringify(["Cart starts with a pear"]), "t1");
    const sha = await a.push({ "src/cart.ts": "export const cart: string[] = ['pear'];\n" }, "cart: start with a pear");
    const onto = await w.trunkCommit({ "README.md": "# shop\n" }, "readme");
    const seen: Record<string, unknown> = {};
    w.deps.evidence = fakeCaps(seen);
    const step = new FakeStep();
    const r = await w.wf.process(a, sha, step);
    expect(r).toMatchObject({ status: "processed", tests: "pass" });

    // preview of the rebased revision in the fork, baseline = trunk at the rebase base
    const rebased = r.rebased!;
    expect(seen.preview).toEqual({ repo: w.repo, change: a.change, candidate: { repo: a.fork, sha: rebased }, trunk: { repo: w.repo, sha: onto } });
    // risk + review saw the real diff from weft-job (patch + files), the criteria and the tests
    const rv = seen.review as ReviewInput;
    expect(rv.patch).toContain("+export const cart: string[] = ['pear'];");
    expect(rv.files).toEqual([{ status: "M", path: "src/cart.ts" }]);
    expect(rv.criteria).toEqual(["Cart starts with a pear"]);
    expect(rv.tests?.status).toBe("pass");
    expect(rv.visual).toEqual([
      { route: "/", ratio: 0.0125 },
      { route: "/cart.html", ratio: 0 },
    ]);
    expect((seen.classify as { patch: string }).patch).toContain("['pear']");

    const ev = w.q<{ kind: string; status: string; uri: string | null; data: string }>(`SELECT kind, status, uri, data FROM evidence WHERE change_id = ? ORDER BY id`, a.change);
    expect(ev.map((e) => [e.kind, e.status])).toEqual([
      ["rebase", "pass"],
      ["test", "pass"],
      ["preview", "pass"],
      ["screenshot", "pass"],
      ["screenshot", "pass"],
      ["visual_diff", "info"],
      ["risk", "info"],
      ["review", "pass"],
    ]);
    expect(ev[3]!.uri).toMatch(/\/0\.png$/);
    expect(JSON.parse(ev[3]!.data)).toMatchObject({ route: "/", diff_ratio: 0.0125, trunk_uri: "https://previews.test/e/s/trunk/0.png" });
    expect(JSON.parse(ev[5]!.data)).toMatchObject({ max_ratio: 0.0125, changed: true, baseline: onto });
    expect(JSON.parse(ev[6]!.data)).toMatchObject({ risk: "low", heuristic: "low", classified: "low", model: "@cf/test/risk" });
    expect(JSON.parse(ev[7]!.data)).toMatchObject({ verdict: "pass", score: 90, criteria_source: "task" });
    // one durable step per stage (a replay re-uses each stage's result)
    expect([...step.cache.keys()].filter((k) => k.startsWith("evidence:"))).toEqual(["evidence: preview", "evidence: screenshots", "evidence: risk", "evidence: review"]);

    // checkpoint with vendor fields inside payload (Hérmes reads payload.x_evidence / x_task_title)
    const cp = events(w).filter((e) => e.kind === "checkpoint" && e.payload.ref === "refs/weft/evidence");
    expect(cp).toHaveLength(1);
    expect(cp[0]!.change).toBe(a.change);
    expect(cp[0]!.payload).toMatchObject({
      sha,
      x_task_title: "Pear first",
      x_evidence: { preview_url: `https://previews.test/p/${a.fork}/${rebased}/sig/`, tests: { passed: 1, failed: 0, total: 1 }, screenshots: [expect.stringMatching(/0\.png$/), expect.stringMatching(/1\.png$/)], review: { verdict: "pass", summary: "Meets the criteria.", score: 90 }, risk: "low" },
    });

    // the land record carries the same evidence
    const landed = await w.wf.land(a);
    expect(landed.status).toBe("landed");
    const land = events(w).find((e) => e.kind === "land")!;
    expect(land.payload).toMatchObject({ x_task_title: "Pear first", x_evidence: { preview_url: expect.stringContaining("/p/"), review: { verdict: "pass" }, tests: { failed: 0 } } });
  });

  it("missing preview config and failing capabilities are explicit evidence, never silent", async () => {
    const w = await world();
    const a = await w.candidate("t1", "claude-a");
    const sha = await a.push({ "src/cart.ts": "export const cart: string[] = ['kiwi'];\n" }, "kiwi");
    const seen: Record<string, unknown> = {};
    w.deps.evidence = { ...fakeCaps(seen, { noPreview: true }), classify: async () => Promise.reject(new Error("AI down")), review: async () => Promise.reject(new Error("gateway 502")) };
    await w.wf.process(a, sha);
    const ev = w.q<{ kind: string; status: string; data: string }>(`SELECT kind, status, data FROM evidence WHERE change_id = ? ORDER BY id`, a.change);
    expect(ev.map((e) => [e.kind, e.status])).toEqual([
      ["rebase", "pass"],
      ["test", "pass"],
      ["preview", "info"],
      ["risk", "info"],
      ["review", "fail"],
    ]);
    expect(JSON.parse(ev[2]!.data)).toMatchObject({ available: false, reason: "no .weft/preview.json in this revision" });
    expect(JSON.parse(ev[3]!.data)).toMatchObject({ risk: "low", classified: null, error: "AI down" });
    expect(JSON.parse(ev[4]!.data)).toMatchObject({ verdict: "needs_human", error: "gateway 502" });
  });

  it("without capabilities the checkpoint still carries test counts", async () => {
    const w = await world();
    const a = await w.candidate("t1", "claude-a", { title: "Kiwi" });
    const sha = await a.push({ "src/cart.ts": "export const cart: string[] = ['kiwi'];\n" }, "kiwi");
    await w.wf.process(a, sha);
    const cp = events(w).find((e) => e.kind === "checkpoint" && e.payload.ref === "refs/weft/evidence")!;
    expect(cp.payload).toMatchObject({ x_task_title: "Kiwi", x_evidence: { tests: { passed: 1, failed: 0, total: 1 }, preview_url: null, review: null } });
  });

  it("BestOfN: a failed review sinks a candidate; a classified high risk asks a human even on a low-risk task", async () => {
    const w = await world();
    const c1 = await w.candidate("t9", "claude-a", { risk: "low" });
    const c2 = await w.candidate("t9", "codex-b", { risk: "low" });
    const s1 = await c1.push({ "src/cart.ts": "export const cart: string[] = ['apple'];\n" }, "c1 small");
    const s2 = await c2.push({ "src/cart.ts": "export const cart: string[] = ['apple', 'pear'];\n// more\n" }, "c2 bigger");
    w.deps.evidence = fakeCaps({}, { review: "fail" });
    await w.wf.process(c1, s1);
    w.deps.evidence = fakeCaps({}, { review: "pass", risk: "high" });
    await w.wf.process(c2, s2);
    const step = new FakeStep();
    step.events.push({ type: "approve", payload: { by: "john" } });
    const r = await w.bestOfN({ repo: w.repo, task: "t9", n: 2 }, step, w.deps, "bon-t9");
    expect(r.ranking!.map((x) => x.change)).toEqual([c2.change, c1.change]);
    expect(r.ranking![1]!.reasons).toContain("review fail 20");
    expect(r.ranking![0]!.reasons).toEqual(expect.arrayContaining(["review pass 90", "risk high"]));
    expect(step.waits).toEqual(["approval"]);
    expect(r).toMatchObject({ status: "landing", winner: c2.change, approved_by: "john" });
  });
});
