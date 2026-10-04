// In-memory Artifacts fake for the Workers runtime (gateway tests, local dev without the
// remote binding). Mirrors the binding's observable behaviour that Weft relies on:
// ALREADY_EXISTS / NOT_FOUND errors, fork copies refs, tokens are repo-scoped and expire.
// `push()` simulates a git push and returns the `pushed` event envelope Artifacts would emit.

import type { ArtifactsCommit, ArtifactsEventEnvelope, PushedPayload } from "./events";
import { ZERO_SHA } from "./events";
import type { ArtifactsCreateResultLike, ArtifactsLike, ArtifactsRepoInfoLike, ArtifactsRepoLike, ArtifactsTokenLike, TokenScope } from "./types";
import { ARTIFACTS_REPO_NAME } from "./naming";

class FakeArtifactsError extends Error {
  readonly name = "ArtifactsError";
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

interface Repo {
  id: string;
  name: string;
  defaultBranch: string;
  refs: Map<string, string>;
  source: string | null;
  readOnly: boolean;
  lastPushAt: string | null;
}

interface Token {
  id: string;
  repo: string;
  plaintext: string;
  scope: TokenScope;
  expiresAt: number;
  revoked: boolean;
}

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => x.toString(16).padStart(2, "0")).join("");

export class MemoryArtifacts implements ArtifactsLike {
  readonly repos = new Map<string, Repo>();
  readonly tokens: Token[] = [];
  /** Every call, for assertions. */
  readonly calls: string[] = [];

  constructor(
    readonly namespace = "weft-test",
    readonly accountId = "acct",
    private readonly now: () => number = () => Date.now(),
  ) {}

  remote(name: string): string {
    return `https://${this.accountId}.artifacts.cloudflare.net/git/${this.namespace}/${name}.git`;
  }

  private mint(repo: string, scope: TokenScope, ttl = 86_400): Token {
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 31_536_000) throw new FakeArtifactsError("INVALID_TTL", `ttl ${ttl}`);
    const exp = this.now() + ttl * 1000;
    const t: Token = { id: hex(8), repo, plaintext: `art_v1_${hex(20)}?expires=${Math.floor(exp / 1000)}`, scope, expiresAt: exp, revoked: false };
    this.tokens.push(t);
    return t;
  }

  private result(r: Repo, t: Token): ArtifactsCreateResultLike {
    return { id: r.id, name: r.name, defaultBranch: r.defaultBranch, remote: this.remote(r.name), token: t.plaintext, tokenExpiresAt: new Date(t.expiresAt).toISOString() };
  }

  private must(name: string): Repo {
    const r = this.repos.get(name);
    if (!r) throw new FakeArtifactsError("NOT_FOUND", `repo ${name}`);
    return r;
  }

  async create(name: string, opts: { readOnly?: boolean; description?: string; setDefaultBranch?: string } = {}): Promise<ArtifactsCreateResultLike> {
    this.calls.push(`create ${name}`);
    if (!ARTIFACTS_REPO_NAME.test(name)) throw new FakeArtifactsError("INVALID_REPO_NAME", name);
    if (this.repos.has(name)) throw new FakeArtifactsError("ALREADY_EXISTS", name);
    const r: Repo = { id: hex(8), name, defaultBranch: opts.setDefaultBranch ?? "main", refs: new Map(), source: null, readOnly: !!opts.readOnly, lastPushAt: null };
    this.repos.set(name, r);
    return this.result(r, this.mint(name, "write"));
  }

  async delete(name: string): Promise<boolean> {
    this.calls.push(`delete ${name}`);
    return this.repos.delete(name);
  }

  async get(name: string): Promise<ArtifactsRepoLike> {
    this.calls.push(`get ${name}`);
    const self = this;
    const r = this.must(name);
    return {
      async info(): Promise<ArtifactsRepoInfoLike> {
        const x = self.must(r.name);
        return { id: x.id, name: x.name, defaultBranch: x.defaultBranch, remote: self.remote(x.name), lastPushAt: x.lastPushAt, source: x.source };
      },
      async createToken(scope: TokenScope = "write", ttl?: number): Promise<ArtifactsTokenLike> {
        self.calls.push(`token ${r.name} ${scope}`);
        self.must(r.name);
        const t = self.mint(r.name, scope, ttl);
        return { id: t.id, plaintext: t.plaintext, scope, expiresAt: new Date(t.expiresAt).toISOString() };
      },
      async revokeToken(tokenOrId: string): Promise<boolean> {
        const t = self.tokens.find((x) => x.repo === r.name && (x.id === tokenOrId || x.plaintext === tokenOrId) && !x.revoked);
        if (t) t.revoked = true;
        return !!t;
      },
      async fork(name: string, opts: { defaultBranchOnly?: boolean; readOnly?: boolean } = {}): Promise<ArtifactsCreateResultLike> {
        self.calls.push(`fork ${r.name} ${name}`);
        if (!ARTIFACTS_REPO_NAME.test(name)) throw new FakeArtifactsError("INVALID_REPO_NAME", name);
        if (self.repos.has(name)) throw new FakeArtifactsError("ALREADY_EXISTS", name);
        const src = self.must(r.name);
        const refs = new Map<string, string>();
        for (const [k, v] of src.refs) if (opts.defaultBranchOnly === false || k === `refs/heads/${src.defaultBranch}`) refs.set(k, v);
        const f: Repo = { id: hex(8), name, defaultBranch: src.defaultBranch, refs, source: `artifacts:${self.namespace}/${src.name}`, readOnly: !!opts.readOnly, lastPushAt: null };
        self.repos.set(name, f);
        return self.result(f, self.mint(name, "write"));
      },
    };
  }

  /** Is `plaintext` a live token for `repo` with at least `scope`? */
  authorize(repo: string, plaintext: string, scope: TokenScope): boolean {
    const t = this.tokens.find((x) => x.plaintext === plaintext);
    return !!t && !t.revoked && t.repo === repo && t.expiresAt > this.now() && (scope === "read" || t.scope === "write");
  }

  ref(repo: string, ref = "refs/heads/main"): string | undefined {
    return this.must(repo).refs.get(ref);
  }

  /**
   * Simulate `git push` of `after` to `ref` with compare-and-swap on the old value
   * (`expected`, default = current). Returns the `pushed` event Artifacts would emit.
   */
  push(repo: string, opts: { token: string; ref?: string; after?: string; expected?: string; message?: string; trailers?: Record<string, string> }): ArtifactsEventEnvelope<PushedPayload> {
    const r = this.must(repo);
    if (!this.authorize(repo, opts.token, "write")) throw new FakeArtifactsError("UNAUTHORIZED", "write token required");
    const ref = opts.ref ?? `refs/heads/${r.defaultBranch}`;
    const before = r.refs.get(ref) ?? ZERO_SHA;
    if (opts.expected !== undefined && opts.expected !== before) throw new FakeArtifactsError("STALE", `${ref} is ${before}, expected ${opts.expected}`);
    const after = opts.after ?? hex(20);
    r.refs.set(ref, after);
    r.lastPushAt = new Date(this.now()).toISOString();
    const trailers = opts.trailers ? "\n\n" + Object.entries(opts.trailers).map(([k, v]) => `${k}: ${v}`).join("\n") : "";
    const commit: ArtifactsCommit = {
      id: after,
      message: (opts.message ?? "checkpoint") + trailers,
      timestamp: new Date(this.now()).toISOString(),
      author: { name: "agent", email: "agent@weft.test" },
      committer: { name: "agent", email: "agent@weft.test" },
      parents: before === ZERO_SHA ? [] : [before],
    };
    return {
      type: "cf.artifacts.repo.pushed",
      source: { type: "artifacts.repo", namespace: this.namespace, repoName: repo },
      payload: { ref, before, after, commits: [commit], totalCommitsCount: 1, commitsTruncated: false },
      metadata: { accountId: this.accountId, eventSubscriptionId: "sub-fake", eventSchemaVersion: 1, eventTimestamp: new Date(this.now()).toISOString() },
    };
  }
}

/** EventSubscriber fake: records subscriptions. */
export class MemorySubscriber {
  readonly subs = new Map<string, { namespace: string; repo: string }>();
  failNext = false;
  async subscribePushes(namespace: string, repo: string) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("subscription API unavailable");
    }
    const id = `sub-${hex(6)}`;
    this.subs.set(id, { namespace, repo });
    return { id };
  }
  async unsubscribe(id: string) {
    this.subs.delete(id);
  }
}
