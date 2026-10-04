import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACTS_REPO_NAME,
  CHANGE_ID,
  CloudflareEventSubscriber,
  decodeEnvelope,
  forkName,
  formatTrailers,
  newChangeId,
  parsePush,
  parseTrailers,
  withRepo,
  ZERO_SHA,
} from "./index";
import { MemoryArtifacts } from "./memory";
import { git, GitArtifacts, landByPush, lsRemote } from "./git";

// A real `cf.artifacts.repo.pushed` message body captured from the live queue on 2026-10-04.
const LIVE_PUSH = JSON.stringify({
  type: "cf.artifacts.repo.pushed",
  source: { namespace: "weft-preview", repoName: "weft-demo", type: "artifacts.repo" },
  metadata: { accountId: "2d659dee148763a8d64c80135da7165d", eventSubscriptionId: "62afb05e91a941fc9ee825a4cf02770b", eventSchemaVersion: 1, eventTimestamp: "2026-10-04T03:32:45.913Z" },
  payload: {
    ref: "refs/heads/main",
    before: "44adef9150b653b2e0178acb2f98adb844ae92d2",
    after: "23d9a9dcca4e2c7c566836e17db48f69c21f8b98",
    commits: [
      {
        id: "23d9a9dcca4e2c7c566836e17db48f69c21f8b98",
        message: "second",
        messageTruncated: false,
        timestamp: "2026-10-04T03:32:43.000Z",
        author: { name: "weft", email: "weft@elier.ai" },
        committer: { name: "weft", email: "weft@elier.ai" },
        parents: ["44adef9150b653b2e0178acb2f98adb844ae92d2"],
      },
    ],
    totalCommitsCount: 1,
    commitsTruncated: false,
  },
});

describe("naming", () => {
  it("builds weft-<repo>-<task>-<n>", () => {
    expect(forkName("demo", "t_cefe064a", 1)).toBe("weft-demo-t_cefe064a-1");
    expect(forkName("Demo Repo", "Fix/Auth!", 3)).toBe("weft-demo-repo-fix-auth-3");
  });
  it("keeps long names valid, unique and deterministic", () => {
    const a = forkName("a-very-long-repository-name-for-testing-limits", "t_" + "x".repeat(60), 12);
    const b = forkName("a-very-long-repository-name-for-testing-limits", "t_" + "x".repeat(59) + "y", 12);
    expect(a.length).toBeLessThanOrEqual(63);
    expect(ARTIFACTS_REPO_NAME.test(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(a).toBe(forkName("a-very-long-repository-name-for-testing-limits", "t_" + "x".repeat(60), 12));
    expect(a.endsWith("-12")).toBe(true);
  });
  it("rejects bad candidate numbers", () => {
    expect(() => forkName("r", "t", 0)).toThrow();
  });
  it("mints Gerrit-style Change-Ids", () => {
    const ids = new Set(Array.from({ length: 50 }, newChangeId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(CHANGE_ID.test(id)).toBe(true);
  });
  it("parses and formats trailers", () => {
    const t = { "Change-Id": newChangeId(), "Task-Id": "t_1", "Agent-Id": "claude-a" };
    const msg = `fix: thing\n\nlonger body\n\n${formatTrailers(t)}\n`;
    expect(parseTrailers(msg)).toMatchObject(t);
    expect(parseTrailers("subject only")).toEqual({});
    expect(parseTrailers("subject\n\nnot: a trailer block\nbecause this line is prose")).toEqual({});
  });
});

describe("events", () => {
  it("decodes the live pushed envelope (string body) and derives a stable key", () => {
    const env = decodeEnvelope(LIVE_PUSH)!;
    const p = parsePush(env)!;
    expect(p).toMatchObject({ namespace: "weft-preview", repo: "weft-demo", ref: "refs/heads/main", after: "23d9a9dcca4e2c7c566836e17db48f69c21f8b98", totalCommits: 1, deleted: false });
    expect(p.key).toBe("pushed:weft-preview/weft-demo:refs/heads/main:44adef9150b653b2e0178acb2f98adb844ae92d2..23d9a9dcca4e2c7c566836e17db48f69c21f8b98");
    expect(parsePush(decodeEnvelope(JSON.parse(LIVE_PUSH))!)!.key).toBe(p.key);
  });
  it("ignores other event types and malformed payloads", () => {
    expect(parsePush(decodeEnvelope({ type: "cf.artifacts.repo.cloned", source: { type: "artifacts.repo", namespace: "n", repoName: "r" }, payload: {} })!)).toBeNull();
    expect(parsePush(decodeEnvelope({ type: "cf.artifacts.repo.pushed", source: { namespace: "n", repoName: "r" }, payload: { ref: "x", before: "zz", after: "yy" } })!)).toBeNull();
    expect(decodeEnvelope("not json")).toBeNull();
    expect(decodeEnvelope({ nope: 1 })).toBeNull();
  });
  it("flags ref deletions", () => {
    const env = decodeEnvelope(LIVE_PUSH)!;
    (env.payload as { after: string }).after = ZERO_SHA;
    expect(parsePush(env)!.deleted).toBe(true);
  });
});

describe("CloudflareEventSubscriber", () => {
  it("creates a per-repo `pushed` subscription to the queue and deletes it", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ success: true, result: init.method === "POST" ? { id: "sub123" } : {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const s = new CloudflareEventSubscriber({ accountId: "acct", apiToken: "tok", queueId: "q1", fetch: f });
    expect(await s.subscribePushes("weft-preview", "weft-demo-t1-1")).toEqual({ id: "sub123" });
    await s.unsubscribe("sub123");
    expect(seen[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/event_subscriptions/subscriptions");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      name: "weft-weft-preview-weft-demo-t1-1",
      enabled: true,
      source: { type: "artifacts.repo", namespace: "weft-preview", repo_name: "weft-demo-t1-1" },
      destination: { type: "queues.queue", queue_id: "q1" },
      events: ["pushed"],
    });
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(seen[1]!.init.method).toBe("DELETE");
    expect(seen[1]!.url.endsWith("/event_subscriptions/subscriptions/sub123")).toBe(true);
  });
  it("surfaces API errors", async () => {
    const f = (async () => new Response(JSON.stringify({ success: false, errors: [{ message: "Validation error" }] }), { status: 400 })) as unknown as typeof fetch;
    const s = new CloudflareEventSubscriber({ accountId: "a", apiToken: "t", queueId: "q", fetch: f });
    await expect(s.subscribePushes("n", "r")).rejects.toThrow(/Validation error/);
  });
});

describe("MemoryArtifacts", () => {
  it("forks the default branch, scopes tokens, and emits pushed events with CAS", async () => {
    const a = new MemoryArtifacts("ns");
    const trunk = await a.create("demo");
    a.push("demo", { token: trunk.token, after: "a".repeat(40) });
    const fork = await withRepo(a, "demo", (r) => r.fork("weft-demo-t1-1", { defaultBranchOnly: true }));
    expect(a.ref("weft-demo-t1-1")).toBe("a".repeat(40));
    expect(a.authorize("weft-demo-t1-1", fork.token, "write")).toBe(true);
    expect(a.authorize("demo", fork.token, "write")).toBe(false); // repo-scoped
    await expect(withRepo(a, "demo", (r) => r.fork("weft-demo-t1-1"))).rejects.toThrow(/ALREADY_EXISTS/);
    const ev = a.push("weft-demo-t1-1", { token: fork.token, after: "b".repeat(40), expected: "a".repeat(40) });
    expect(parsePush(decodeEnvelope(ev)!)!.before).toBe("a".repeat(40));
    expect(() => a.push("weft-demo-t1-1", { token: fork.token, after: "c".repeat(40), expected: "a".repeat(40) })).toThrow(/STALE/);
    const ro = await withRepo(a, "weft-demo-t1-1", (r) => r.createToken("read", 60));
    expect(() => a.push("weft-demo-t1-1", { token: ro.plaintext })).toThrow(/UNAUTHORIZED/);
  });
});

// ------------------------------------------------------------------ git-backed: landing CAS

async function commit(dir: string, file: string, text: string, msg: string): Promise<string> {
  await writeFile(join(dir, file), text);
  await git(["add", "-A"], { cwd: dir });
  const r = await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg], { cwd: dir });
  if (r.code !== 0) throw new Error(r.stderr);
  return (await git(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
}

async function setup() {
  const a = await GitArtifacts.create();
  const trunk = await a.create("demo");
  const work = await mkdtemp(join(tmpdir(), "weft-work-"));
  await git(["init", "-q", "-b", "main", work]);
  const base = await commit(work, "a.ts", "export const a = 1;\n", "init");
  await git(["push", "-q", trunk.remote, "HEAD:refs/heads/main"], { cwd: work });
  return { a, trunk, work, base };
}

describe("landByPush (git CAS)", () => {
  it("lands a fast-forward when trunk equals the expected value", async () => {
    const { a, trunk, work, base } = await setup();
    const fork = await withRepo(a, "demo", (r) => r.fork("weft-demo-t1-1", { defaultBranchOnly: true }));
    expect(await lsRemote(fork.remote, "refs/heads/main")).toBe(base);
    const c1 = await commit(work, "b.ts", "export const b = 2;\n", `feat: b\n\nChange-Id: ${newChangeId()}`);
    await git(["push", "-q", fork.remote, "HEAD:refs/heads/main"], { cwd: work });
    const r = await landByPush({ cwd: work, remote: trunk.remote, sha: c1, expected: base });
    expect(r).toEqual({ ok: true, ref: "refs/heads/main", before: base, after: c1 });
    expect(await lsRemote(trunk.remote, "refs/heads/main")).toBe(c1);
  });

  it("refuses with stale_trunk when trunk moved after validation", async () => {
    const { trunk, work, base } = await setup();
    const c1 = await commit(work, "b.ts", "1\n", "one");
    expect((await landByPush({ cwd: work, remote: trunk.remote, sha: c1, expected: base })).ok).toBe(true);
    const c2 = await commit(work, "c.ts", "2\n", "two"); // descends from c1, but we claim base
    const r = await landByPush({ cwd: work, remote: trunk.remote, sha: c2, expected: base });
    expect(r).toMatchObject({ ok: false, reason: "stale_trunk", expected: base, current: c1 });
    expect(await lsRemote(trunk.remote, "refs/heads/main")).toBe(c1);
  });

  it("refuses non-fast-forward landings even when the lease holds", async () => {
    const { trunk, work, base } = await setup();
    await git(["checkout", "-q", "--orphan", "other"], { cwd: work });
    const orphan = await commit(work, "z.ts", "z\n", "unrelated");
    const r = await landByPush({ cwd: work, remote: trunk.remote, sha: orphan, expected: base });
    expect(r).toMatchObject({ ok: false, reason: "not_fast_forward" });
    expect(await lsRemote(trunk.remote, "refs/heads/main")).toBe(base);
  });

  it("creates a branch only if absent (expected = ZERO_SHA)", async () => {
    const { trunk, work, base } = await setup();
    expect((await landByPush({ cwd: work, remote: trunk.remote, sha: base, expected: ZERO_SHA, branch: "release" })).ok).toBe(true);
    const c1 = await commit(work, "r.ts", "r\n", "r");
    expect(await landByPush({ cwd: work, remote: trunk.remote, sha: c1, expected: ZERO_SHA, branch: "release" })).toMatchObject({ ok: false, reason: "stale_trunk", current: base });
  });

  it("racing landings with the same expected trunk: exactly one wins", async () => {
    for (let round = 0; round < 5; round++) {
      const { trunk, work, base } = await setup();
      const w2 = await mkdtemp(join(tmpdir(), "weft-work2-"));
      await git(["clone", "-q", trunk.remote, w2]);
      const x = await commit(work, `x${round}.ts`, "x\n", "x");
      const y = await commit(w2, `y${round}.ts`, "y\n", "y");
      const [rx, ry] = await Promise.all([
        landByPush({ cwd: work, remote: trunk.remote, sha: x, expected: base }),
        landByPush({ cwd: w2, remote: trunk.remote, sha: y, expected: base }),
      ]);
      expect([rx.ok, ry.ok].filter(Boolean).length).toBe(1);
      const loser = rx.ok ? ry : rx;
      expect(loser).toMatchObject({ ok: false, reason: "stale_trunk" });
      expect(await lsRemote(trunk.remote, "refs/heads/main")).toBe(rx.ok ? x : y);
    }
  });
});
