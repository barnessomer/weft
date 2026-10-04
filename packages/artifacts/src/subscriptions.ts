// Per-repo Queues event subscriptions for Artifacts `pushed` events.
//
// Verified live 2026-10-04: `pushed` is a repository-level event (source `artifacts.repo`)
// and the subscription API REQUIRES `source.repo_name`; `repo_name: "*"` is accepted by the
// API but matches nothing. So every candidate fork needs its own subscription. The event
// name in the subscriptions API is the short form (`pushed`), not `cf.artifacts.repo.pushed`.
//
// API: POST/DELETE https://api.cloudflare.com/client/v4/accounts/{acct}/event_subscriptions/subscriptions
// Auth: a Cloudflare API token with Queues edit permission (WEFT_CF_API_TOKEN secret).

export interface Subscription {
  id: string;
}

export interface EventSubscriber {
  /** Subscribe the events queue to `pushed` on one repo. Returns the subscription id. */
  subscribePushes(namespace: string, repo: string): Promise<Subscription>;
  unsubscribe(id: string): Promise<void>;
}

export class SubscriptionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface CloudflareSubscriberConfig {
  accountId: string;
  apiToken: string;
  queueId: string;
  /** Subscription name prefix (CF resource names are prefixed `weft-`). */
  prefix?: string;
  fetch?: typeof fetch;
  apiBase?: string;
}

export class CloudflareEventSubscriber implements EventSubscriber {
  constructor(private readonly c: CloudflareSubscriberConfig) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const f = this.c.fetch ?? fetch;
    const base = this.c.apiBase ?? "https://api.cloudflare.com/client/v4";
    const r = await f(`${base}/accounts/${this.c.accountId}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.c.apiToken}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const j = (await r.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: { message?: string }[] };
    if (!r.ok || j.success === false) throw new SubscriptionError(`event subscription ${method} failed: ${j.errors?.map((e) => e.message).join("; ") || r.status}`, r.status);
    return j.result;
  }

  async subscribePushes(namespace: string, repo: string): Promise<Subscription> {
    const name = `${this.c.prefix ?? "weft"}-${namespace}-${repo}`.slice(0, 100);
    const res = (await this.call("POST", "/event_subscriptions/subscriptions", {
      name,
      enabled: true,
      source: { type: "artifacts.repo", namespace, repo_name: repo },
      destination: { type: "queues.queue", queue_id: this.c.queueId },
      events: ["pushed"],
    })) as { id?: string };
    if (!res?.id) throw new SubscriptionError("event subscription create returned no id");
    return { id: res.id };
  }

  async unsubscribe(id: string): Promise<void> {
    await this.call("DELETE", `/event_subscriptions/subscriptions/${encodeURIComponent(id)}`);
  }
}
