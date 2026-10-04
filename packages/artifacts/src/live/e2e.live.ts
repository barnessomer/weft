// LIVE end-to-end proof against Cloudflare (not part of the gate; needs network + wrangler
// OAuth + the preview admin token). Run:
//
//   pnpm --filter @weft/artifacts test:live
//
// Env: WEFT_URL (default: preview gateway), WEFT_ADMIN_TOKEN_FILE (default ~/.config/weft/preview-admin-token),
//      WEFT_KEEP=1 to keep the throwaway trunk/fork.
//
// Steps: create a Weft repo + Artifacts trunk -> push an initial commit with a trunk token
// from the gateway -> POST candidates (fork + token + Change-Id) -> (operator fallback for the
// per-fork event subscription if the gateway has no CF API token) -> clone the fork with the
// token, commit with Weft trailers, push -> wait until the queue consumer appends the WCP
// `checkpoint` -> race two landings with the same expected trunk (exactly one may win).
// Tokens are never printed.

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatTrailers } from "../naming";
import { git, landByPush, lsRemote } from "../git";

const URL_ = process.env.WEFT_URL ?? "https://weft-gateway-preview.elier.ai";
const ACCOUNT = "2d659dee148763a8d64c80135da7165d";
const log = (...a: unknown[]) => console.log("[e2e]", ...a);

async function adminToken(): Promise<string> {
  return (await readFile(process.env.WEFT_ADMIN_TOKEN_FILE ?? join(homedir(), ".config/weft/preview-admin-token"), "utf8")).trim();
}

async function api<T = Record<string, unknown>>(method: string, path: string, token: string, body?: unknown, expect?: number): Promise<T> {
  const r = await fetch(`${URL_}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "wcp-version": "0.1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (expect !== undefined && r.status !== expect) throw new Error(`${method} ${path} -> ${r.status}: ${text.replace(/art_v1_[0-9a-f]+(\?expires=\d+)?/g, "art_v1_***")}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Operator path to the Cloudflare API: wrangler's OAuth token (refreshed by running wrangler). */
async function cf<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  execFileSync("pnpm", ["exec", "wrangler", "whoami"], { stdio: "ignore", env: { ...process.env, CLOUDFLARE_API_TOKEN: "" } });
  const cfg = await readFile(join(homedir(), "Library/Preferences/.wrangler/config/default.toml"), "utf8");
  const tok = /oauth_token\s*=\s*"([^"]+)"/.exec(cfg)![1]!;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const j = (await r.json()) as { success: boolean; result: T; errors: unknown[] };
  if (!j.success) throw new Error(`CF ${method} ${path}: ${JSON.stringify(j.errors)}`);
  return j.result;
}

async function commitFile(dir: string, file: string, text: string, msg: string): Promise<string> {
  await writeFile(join(dir, file), text);
  await git(["add", "-A"], { cwd: dir });
  const r = await git(["-c", "user.name=weft-e2e", "-c", "user.email=e2e@elier.ai", "commit", "-qm", msg], { cwd: dir });
  if (r.code !== 0) throw new Error(r.stderr);
  return (await git(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
}

type Cand = { change: string; n: number; fork: { name: string; remote: string; namespace: string }; token: { plaintext: string; expires_at: string }; trailers: Record<string, string>; subscription: { status: string; id?: string } };

describe("LIVE: Artifacts fork -> push -> queue -> WCP checkpoint; landing CAS", () => {
  it("runs end to end", async () => {
    const admin = await adminToken();
    const stamp = Date.now().toString(36);
    const repo = `weft-e2e-${stamp}`;
    const task = `t_e2e${stamp}`;

    await api("POST", "/v1/admin/repos", admin, { repo }, 201);
    const bound = await api<{ trunk: string; remote: string; namespace: string }>("POST", "/v1/admin/artifacts/repos", admin, { repo, create: true }, 201);
    log("trunk", bound.namespace, bound.trunk, bound.remote);
    const sys = (await api<{ token: string }>("POST", "/v1/admin/tokens", admin, { principal: "e2e-dispatcher", scopes: ["system"], repos: [repo] }, 201)).token;
    const obs = (await api<{ token: string }>("POST", "/v1/admin/tokens", admin, { principal: "e2e-observer", scopes: ["observe"], repos: [repo] }, 201)).token;

    // Trunk: initial commit pushed with a short-lived trunk token from the gateway.
    const work = await mkdtemp(join(tmpdir(), "weft-e2e-"));
    await git(["init", "-q", "-b", "main", work]);
    const base = await commitFile(work, "greet.ts", "export function greet(n: string) {\n  return `hi ${n}`;\n}\n", "init trunk");
    const tt = await api<{ token: { plaintext: string } }>("POST", `/v1/repos/${repo}/system/trunk-token`, sys, { ttl: 600 }, 201);
    const init = await landByPush({ cwd: work, remote: bound.remote, token: tt.token.plaintext, sha: base, expected: "0".repeat(40) });
    expect(init.ok).toBe(true);
    log("trunk main =", base.slice(0, 7));

    // Candidate: fork + write token + Change-Id (+ event subscription).
    const t0 = Date.now();
    const created = await api<{ candidates: Cand[] }>("POST", `/v1/repos/${repo}/tasks/${task}/candidates`, sys, { agent: "e2e-agent", title: "live proof" }, 201);
    const c = created.candidates[0]!;
    log("candidate", c.n, c.fork.name, c.change, "subscription:", c.subscription.status, `(${Date.now() - t0} ms)`);
    expect(c.fork.name).toBe(`weft-${repo}-${task}-1`);
    let subId = c.subscription.id;
    if (c.subscription.status !== "active") {
      // Operator fallback (gateway has no WEFT_CF_API_TOKEN): create the per-fork subscription and record it.
      const q = (await cf<{ queue_id: string; queue_name: string }[]>("GET", "/queues?per_page=100")).find((x) => x.queue_name === "weft-artifacts-events-preview")!;
      const sub = await cf<{ id: string }>("POST", "/event_subscriptions/subscriptions", {
        name: `weft-${c.fork.namespace}-${c.fork.name}`.slice(0, 100),
        enabled: true,
        source: { type: "artifacts.repo", namespace: c.fork.namespace, repo_name: c.fork.name },
        destination: { type: "queues.queue", queue_id: q.queue_id },
        events: ["pushed"],
      });
      subId = sub.id;
      await api("POST", "/v1/admin/artifacts/subscriptions", admin, { change: c.change, subscription_id: sub.id }, 200);
      log("operator subscription", sub.id);
    }

    // Agent side: clone the fork with its token, commit with trailers, push.
    const agent = await mkdtemp(join(tmpdir(), "weft-e2e-agent-"));
    const cl = await git(["clone", "-q", c.fork.remote, agent], { token: c.token.plaintext });
    expect(cl.code, cl.stderr).toBe(0);
    expect((await git(["rev-parse", "HEAD"], { cwd: agent })).stdout.trim()).toBe(base);
    const sha = await commitFile(agent, "greet.ts", "export function greet(n: string, punct = \"!\") {\n  return `hi ${n}${punct}`;\n}\n", `feat: greet punctuation\n\n${formatTrailers(c.trailers)}`);
    const pushedAt = Date.now();
    const p = await git(["push", "-q", c.fork.remote, "HEAD:refs/heads/main"], { cwd: agent, token: c.token.plaintext });
    expect(p.code, p.stderr).toBe(0);
    log("pushed", sha.slice(0, 7), "to", c.fork.name);

    // Wait for: Artifacts pushed event -> queue -> consumer -> WCP checkpoint.
    type Rec = { seq: number; kind: string; change: string; payload: { sha: string }; summary: string; actor: unknown };
    let rec: Rec | undefined;
    while (!rec && Date.now() - pushedAt < 90_000) {
      const page = await api<{ events: Rec[] }>("GET", `/v1/repos/${repo}/events?kind=checkpoint`, obs, undefined, 200);
      rec = page.events.find((e) => e.payload.sha === sha);
      if (!rec) await new Promise((r) => setTimeout(r, 500));
    }
    expect(rec, "checkpoint did not arrive within 90s").toBeDefined();
    const latency = Date.now() - pushedAt;
    log(`checkpoint #${rec!.seq} visible ${latency} ms after git push returned:`, JSON.stringify({ kind: rec!.kind, change: rec!.change, actor: rec!.actor, summary: rec!.summary }));
    expect(rec).toMatchObject({ kind: "checkpoint", change: c.change, actor: { type: "system", id: "artifacts" } });
    const ch = await api<{ head_sha: string; base_sha: string; revisions: { sha: string; seq: number; status: string; trailer_change_id: string }[] }>("GET", `/v1/repos/${repo}/changes/${c.change}`, obs, undefined, 200);
    log("change", JSON.stringify({ head_sha: ch.head_sha, base_sha: ch.base_sha, revisions: ch.revisions }));
    expect(ch).toMatchObject({ head_sha: sha, base_sha: base });
    expect(ch.revisions[0]).toMatchObject({ sha, seq: rec!.seq, status: "queued", trailer_change_id: c.change });

    // Landing CAS, live: two landers validated against the same trunk; exactly one wins.
    const rival = await mkdtemp(join(tmpdir(), "weft-e2e-rival-"));
    expect((await git(["clone", "-q", bound.remote, rival], { token: tt.token.plaintext })).code).toBe(0);
    const rivalSha = await commitFile(rival, "other.ts", "export const other = 1;\n", "rival change");
    const tt2 = await api<{ token: { plaintext: string } }>("POST", `/v1/repos/${repo}/system/trunk-token`, sys, { ttl: 300 }, 201);
    const [a, b] = await Promise.all([
      landByPush({ cwd: agent, remote: bound.remote, token: tt2.token.plaintext, sha, expected: base }),
      landByPush({ cwd: rival, remote: bound.remote, token: tt2.token.plaintext, sha: rivalSha, expected: base }),
    ]);
    log("race:", JSON.stringify({ candidate: a.ok ? "landed" : a.reason, rival: b.ok ? "landed" : b.reason }), "loser detail:", (a.ok ? b : a).ok ? "" : ((a.ok ? b : a) as { detail: string }).detail);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect((a.ok ? b : a) as { reason: string }).toMatchObject({ reason: "stale_trunk" });
    const head = await lsRemote(bound.remote, "refs/heads/main", tt2.token.plaintext);
    expect(head).toBe(a.ok ? sha : rivalSha);
    // Retrying the loser with its stale expectation is refused deterministically.
    const late = a.ok
      ? await landByPush({ cwd: rival, remote: bound.remote, token: tt2.token.plaintext, sha: rivalSha, expected: base })
      : await landByPush({ cwd: agent, remote: bound.remote, token: tt2.token.plaintext, sha, expected: base });
    log("loser retried with stale lease:", late.ok ? "landed?!" : late.reason);
    expect(late).toMatchObject({ ok: false, reason: "stale_trunk" });

    if (process.env.WEFT_KEEP !== "1") {
      await api("DELETE", `/v1/repos/${repo}/changes/${c.change}`, sys, undefined, 200);
      if (subId) await cf("DELETE", `/event_subscriptions/subscriptions/${subId}`).catch(() => undefined);
      await cf("DELETE", `/artifacts/namespaces/${bound.namespace}/repos/${bound.trunk}`).catch(() => undefined);
      log("cleaned up fork, subscription, trunk");
    }
  }, 180_000);
});
