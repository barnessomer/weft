// Workflow instance ids (shared with the gateway, which creates/signals instances).
// Cloudflare Workflows ids: [a-zA-Z0-9_-], at most 100 characters, unique per workflow.

export function instanceId(prefix: string, ...parts: string[]): string {
  const body = parts.map((p) => p.replace(/[^a-zA-Z0-9_-]/g, "_")).join("-");
  return `${prefix}-${body}`.slice(0, 100);
}

export const ids = {
  /** One ProcessRevision per pushed revision (a redelivered push event is a no-op). */
  process: (change: string, sha: string) => instanceId("rev", change.slice(0, 13), sha.slice(0, 12)),
  /** LandChange: one per request (a retry after a failure is a new instance). */
  land: (change: string, at: number) => instanceId("land", change.slice(0, 13), String(at)),
  revert: (repo: string, op: string, at: number) => instanceId("revert", repo, op, String(at)),
  /** BestOfN: one per task, so `approve` and `candidate` events can find it. */
  bestOfN: (repo: string, task: string) => instanceId("bon", repo, task),
};
