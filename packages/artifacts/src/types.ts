// Narrow, structural view of the Cloudflare Artifacts Workers binding
// (https://developers.cloudflare.com/artifacts/api/workers-binding/). The real binding
// (`env.ARTIFACTS: Artifacts`) satisfies these interfaces as-is; tests and local runs use
// an in-memory fake (Workers runtime) or a git-backed fake (Node, ./git).
//
// S1 finding (docs/research/artifacts.md): the binding manages repos, forks and tokens and
// reads git objects; it has NO commit/ref-update/CAS method. Writing to a repo always means
// `git push` with a repo-scoped write token (see ./git `landByPush`).

export type TokenScope = "read" | "write";

export interface ArtifactsRepoInfoLike {
  id: string;
  name: string;
  defaultBranch: string;
  remote: string;
  lastPushAt?: string | null;
  source?: string | null;
}

/** create()/fork()/import() result: metadata plus an initial token (write scope). */
export interface ArtifactsCreateResultLike {
  id: string;
  name: string;
  defaultBranch: string;
  remote: string;
  token: string;
  tokenExpiresAt?: string;
}

export interface ArtifactsTokenLike {
  id: string;
  plaintext: string;
  scope: TokenScope;
  expiresAt: string;
}

export interface ArtifactsRepoLike {
  info(): Promise<ArtifactsRepoInfoLike>;
  createToken(scope?: TokenScope, ttl?: number): Promise<ArtifactsTokenLike>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  fork(name: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }): Promise<ArtifactsCreateResultLike>;
}

export interface ArtifactsLike {
  create(name: string, opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string }): Promise<ArtifactsCreateResultLike>;
  get(name: string): Promise<ArtifactsRepoLike>;
  delete(name: string): Promise<boolean>;
}

/** Error codes thrown by the binding (`ArtifactsError.code`). */
export type ArtifactsErrorCode =
  | "ALREADY_EXISTS"
  | "NOT_FOUND"
  | "IMPORT_IN_PROGRESS"
  | "FORK_IN_PROGRESS"
  | "INVALID_INPUT"
  | "INVALID_REPO_NAME"
  | "INVALID_TTL"
  | "INTERNAL_ERROR"
  | (string & {});

export function artifactsErrorCode(e: unknown): ArtifactsErrorCode | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  if (typeof c === "string") return c;
  // RPC errors may lose the property; fall back to the message.
  const m = e instanceof Error ? /\b(ALREADY_EXISTS|NOT_FOUND|FORK_IN_PROGRESS|IMPORT_IN_PROGRESS|INVALID_REPO_NAME|INVALID_TTL|INVALID_INPUT)\b/.exec(e.message) : null;
  return m?.[1];
}

/** Get a repo handle, run `fn`, and release the RPC capability (the binding's handles are Disposable). */
export async function withRepo<T>(a: ArtifactsLike, name: string, fn: (r: ArtifactsRepoLike) => Promise<T>): Promise<T> {
  const repo = await a.get(name);
  try {
    return await fn(repo);
  } finally {
    const d = (repo as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose];
    if (typeof d === "function") {
      try {
        d.call(repo);
      } catch {
        /* already released */
      }
    }
  }
}
