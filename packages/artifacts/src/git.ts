// Node-only git helpers (sandbox / trusted git client): the landing primitive and a
// git-backed Artifacts fake built on local bare repositories.
//
// Landing primitive (S1): the Artifacts binding cannot move refs, so trunk advances by
// `git push` with a short-lived write token. Compare-and-swap comes from git itself:
// `--force-with-lease=<ref>:<expected>` makes the client send `<expected> <new> <ref>` and
// receive-pack refuses the update if the ref no longer equals <expected>. We additionally
// require fast-forward (expected must be an ancestor of the new sha) so landing never
// rewrites trunk history. Verified live against Artifacts (docs/research/artifacts.md).

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ZERO_SHA } from "./events";
import { ARTIFACTS_REPO_NAME } from "./naming";
import type { ArtifactsCreateResultLike, ArtifactsLike, ArtifactsRepoInfoLike, ArtifactsRepoLike, ArtifactsTokenLike, TokenScope } from "./types";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git without a shell. `token` is passed via GIT_CONFIG_* env (never argv) and redacted from output. */
export function git(args: string[], opts: { cwd?: string; token?: string; env?: Record<string, string> } = {}): Promise<GitResult> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: "0", ...opts.env };
  if (opts.token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${opts.token}`;
  }
  const scrub = (s: string) => (opts.token ? s.split(opts.token).join("***") : s);
  return new Promise((resolve) => {
    execFile("git", args, { cwd: opts.cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: scrub(String(stdout)), stderr: scrub(String(stderr)) });
    });
  });
}

async function gitOk(args: string[], opts: Parameters<typeof git>[1] = {}): Promise<string> {
  const r = await git(args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

export async function lsRemote(remote: string, ref: string, token?: string): Promise<string> {
  const out = await gitOk(["ls-remote", remote, ref], token ? { token } : {});
  const line = out.split("\n").find((l) => l.endsWith(`\t${ref}`));
  return line ? line.split("\t")[0]! : ZERO_SHA;
}

export type LandResult =
  | { ok: true; ref: string; before: string; after: string }
  | { ok: false; reason: "stale_trunk"; ref: string; expected: string; current: string; detail: string }
  | { ok: false; reason: "not_fast_forward"; ref: string; expected: string; detail: string }
  | { ok: false; reason: "rejected"; ref: string; expected: string; detail: string };

export interface LandOptions {
  /** Local repository that contains `sha` (and, for fast-forward checks, `expected`). */
  cwd: string;
  /** Trunk remote (Artifacts HTTPS remote or any git URL). */
  remote: string;
  /** Repo-scoped write token for the trunk (omit for local/file remotes). */
  token?: string;
  /** Commit to land. */
  sha: string;
  /** Trunk value the landing was validated against (the CAS "compare"). ZERO_SHA = branch must not exist. */
  expected: string;
  branch?: string;
}

/**
 * Advance `refs/heads/<branch>` on `remote` from `expected` to `sha`, atomically.
 * Fails with `stale_trunk` if trunk moved since validation (another landing won the race).
 */
export async function landByPush(o: LandOptions): Promise<LandResult> {
  const ref = `refs/heads/${o.branch ?? "main"}`;
  const tok = o.token ? { token: o.token } : {};
  if (o.expected !== ZERO_SHA) {
    const anc = await git(["merge-base", "--is-ancestor", o.expected, o.sha], { cwd: o.cwd });
    if (anc.code !== 0)
      return { ok: false, reason: "not_fast_forward", ref, expected: o.expected, detail: anc.code === 1 ? `${o.sha} does not descend from ${o.expected}` : anc.stderr.trim() };
  }
  const lease = `--force-with-lease=${ref}:${o.expected === ZERO_SHA ? "" : o.expected}`;
  const r = await git(["push", "--porcelain", lease, o.remote, `${o.sha}:${ref}`], { cwd: o.cwd, ...tok });
  const line = r.stdout.split("\n").find((l) => l.includes(`:${ref}\t`)) ?? "";
  const flag = line[0];
  if (r.code === 0 && flag !== undefined && flag !== "!") return { ok: true, ref, before: o.expected, after: o.sha };
  const detail = (line || r.stderr).trim();
  if (/stale info|incorrect old value|fetch first|cannot lock ref|failed to update ref|but expected|non-fast-forward/i.test(detail + r.stderr)) {
    const current = await lsRemote(o.remote, ref, o.token).catch(() => "unknown");
    if (current !== o.expected) return { ok: false, reason: "stale_trunk", ref, expected: o.expected, current, detail };
  }
  return { ok: false, reason: "rejected", ref, expected: o.expected, detail: detail || `git push exited ${r.code}` };
}

// ------------------------------------------------------------------ git-backed fake

class GitFakeError extends Error {
  readonly name = "ArtifactsError";
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

/**
 * ArtifactsLike over local bare repositories (`file://` remotes). Forks are `git clone
 * --bare`; tokens are minted and tracked but not enforced by the file transport.
 */
export class GitArtifacts implements ArtifactsLike {
  private readonly tokens = new Map<string, { repo: string; scope: TokenScope; exp: number }>();
  private constructor(readonly root: string) {}

  static async create(root?: string): Promise<GitArtifacts> {
    const dir = root ?? (await mkdtemp(join(tmpdir(), "weft-artifacts-")));
    await mkdir(dir, { recursive: true });
    return new GitArtifacts(dir);
  }

  path(name: string) {
    return join(this.root, `${name}.git`);
  }

  remote(name: string) {
    return pathToFileURL(this.path(name)).href;
  }

  private async exists(name: string) {
    return (await git(["rev-parse", "--git-dir"], { cwd: this.path(name) })).code === 0;
  }

  private mint(repo: string, scope: TokenScope, ttl = 86_400) {
    const plaintext = `art_v1_${Array.from(crypto.getRandomValues(new Uint8Array(20)), (x) => x.toString(16).padStart(2, "0")).join("")}`;
    const exp = Date.now() + ttl * 1000;
    this.tokens.set(plaintext, { repo, scope, exp });
    return { plaintext, exp };
  }

  private async result(name: string): Promise<ArtifactsCreateResultLike> {
    const t = this.mint(name, "write");
    const head = (await gitOk(["symbolic-ref", "--short", "HEAD"], { cwd: this.path(name) })).trim() || "main";
    return { id: name, name, defaultBranch: head, remote: this.remote(name), token: t.plaintext, tokenExpiresAt: new Date(t.exp).toISOString() };
  }

  async create(name: string, opts: { setDefaultBranch?: string } = {}): Promise<ArtifactsCreateResultLike> {
    if (!ARTIFACTS_REPO_NAME.test(name)) throw new GitFakeError("INVALID_REPO_NAME", name);
    if (await this.exists(name)) throw new GitFakeError("ALREADY_EXISTS", name);
    await gitOk(["init", "--bare", "-q", `--initial-branch=${opts.setDefaultBranch ?? "main"}`, this.path(name)]);
    return this.result(name);
  }

  async delete(name: string): Promise<boolean> {
    if (!(await this.exists(name))) return false;
    await rm(this.path(name), { recursive: true, force: true });
    return true;
  }

  async get(name: string): Promise<ArtifactsRepoLike> {
    if (!(await this.exists(name))) throw new GitFakeError("NOT_FOUND", name);
    const self = this;
    return {
      async info(): Promise<ArtifactsRepoInfoLike> {
        const head = (await gitOk(["symbolic-ref", "--short", "HEAD"], { cwd: self.path(name) })).trim();
        return { id: name, name, defaultBranch: head, remote: self.remote(name) };
      },
      async createToken(scope: TokenScope = "write", ttl = 86_400): Promise<ArtifactsTokenLike> {
        const t = self.mint(name, scope, ttl);
        return { id: t.plaintext.slice(7, 23), plaintext: t.plaintext, scope, expiresAt: new Date(t.exp).toISOString() };
      },
      async revokeToken(tokenOrId: string): Promise<boolean> {
        return self.tokens.delete(tokenOrId);
      },
      async fork(target: string, opts: { defaultBranchOnly?: boolean } = {}): Promise<ArtifactsCreateResultLike> {
        if (!ARTIFACTS_REPO_NAME.test(target)) throw new GitFakeError("INVALID_REPO_NAME", target);
        if (await self.exists(target)) throw new GitFakeError("ALREADY_EXISTS", target);
        const head = (await gitOk(["symbolic-ref", "--short", "HEAD"], { cwd: self.path(name) })).trim();
        const hasHead = (await git(["rev-parse", "--verify", "-q", `refs/heads/${head}`], { cwd: self.path(name) })).code === 0;
        if (hasHead) await gitOk(["clone", "--bare", "-q", ...(opts.defaultBranchOnly !== false ? ["--single-branch", "--branch", head] : []), self.path(name), self.path(target)]);
        else await gitOk(["init", "--bare", "-q", `--initial-branch=${head}`, self.path(target)]);
        return self.result(target);
      },
    };
  }
}
