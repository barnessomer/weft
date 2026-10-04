// Artifacts lifecycle events as delivered by Queues event subscriptions
// (https://developers.cloudflare.com/artifacts/guides/event-subscriptions/). Shapes below
// were verified live on 2026-10-04 (docs/research/artifacts.md, "Live verification").

export interface ArtifactsCommit {
  id: string;
  message: string;
  messageTruncated?: boolean;
  timestamp: string;
  author?: { name: string; email: string };
  committer?: { name: string; email: string };
  parents: string[];
}

export interface ArtifactsEventEnvelope<P = Record<string, unknown>> {
  type: string;
  source: { type: string; namespace?: string; repoName?: string };
  payload: P;
  metadata: { accountId?: string; eventSubscriptionId?: string; eventSchemaVersion?: number; eventTimestamp?: string };
}

export interface PushedPayload {
  ref: string;
  before: string;
  after: string;
  commits: ArtifactsCommit[];
  totalCommitsCount?: number;
  commitsTruncated?: boolean;
}

export const PUSHED = "cf.artifacts.repo.pushed";
export const ZERO_SHA = "0000000000000000000000000000000000000000";

export interface Push {
  namespace: string;
  repo: string;
  ref: string;
  before: string;
  after: string;
  commits: ArtifactsCommit[];
  totalCommits: number;
  truncated: boolean;
  eventTimestamp?: string;
  subscriptionId?: string;
  /** Ref deleted (after = 0…0). */
  deleted: boolean;
  /** Deterministic idempotency key: redeliveries and duplicate subscriptions map to the same key. */
  key: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Decode a queue message body (object, or JSON string from HTTP-pull consumers). */
export function decodeEnvelope(body: unknown): ArtifactsEventEnvelope | null {
  let v = body;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!isObj(v) || typeof v.type !== "string" || !isObj(v.source)) return null;
  return {
    type: v.type,
    source: v.source as ArtifactsEventEnvelope["source"],
    payload: isObj(v.payload) ? v.payload : {},
    metadata: isObj(v.metadata) ? (v.metadata as ArtifactsEventEnvelope["metadata"]) : {},
  };
}

/** Extract a push from an envelope; null if this is not a well-formed `pushed` event. */
export function parsePush(env: ArtifactsEventEnvelope): Push | null {
  if (env.type !== PUSHED) return null;
  const { namespace, repoName } = env.source;
  const p = env.payload as Partial<PushedPayload>;
  if (!namespace || !repoName || typeof p.ref !== "string" || typeof p.after !== "string" || typeof p.before !== "string") return null;
  if (!SHA.test(p.after) || !SHA.test(p.before)) return null;
  const commits = Array.isArray(p.commits) ? p.commits.filter((c) => isObj(c) && typeof c.id === "string") : [];
  return {
    namespace,
    repo: repoName,
    ref: p.ref,
    before: p.before,
    after: p.after,
    commits,
    totalCommits: typeof p.totalCommitsCount === "number" ? p.totalCommitsCount : commits.length,
    truncated: p.commitsTruncated === true,
    ...(env.metadata.eventTimestamp ? { eventTimestamp: env.metadata.eventTimestamp } : {}),
    ...(env.metadata.eventSubscriptionId ? { subscriptionId: env.metadata.eventSubscriptionId } : {}),
    deleted: p.after === ZERO_SHA,
    key: `pushed:${namespace}/${repoName}:${p.ref}:${p.before}..${p.after}`,
  };
}

/** `refs/heads/main` → `main`. */
export const branchOf = (ref: string) => ref.replace(/^refs\/heads\//, "");
