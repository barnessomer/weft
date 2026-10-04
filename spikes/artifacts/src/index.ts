interface RuntimeEnv extends Env {
  /** Set with `wrangler secret put ADMIN_SECRET`; never return this value. */
  ADMIN_SECRET: string;
}

type ArtifactEvent = {
  type?: string;
  source?: { namespace?: string; repoName?: string; type?: string };
  payload?: Record<string, unknown>;
  metadata?: { eventTimestamp?: string; eventSchemaVersion?: number };
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function requireAdmin(request: Request, env: RuntimeEnv): Response | null {
  return request.headers.get("authorization") === `Bearer ${env.ADMIN_SECRET}`
    ? null
    : json({ error: "unauthorized" }, 401);
}

function repoName(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(value)
    ? value
    : null;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const parsed: unknown = await request.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required");
  return parsed as Record<string, unknown>;
}

export default {
  async fetch(request, env): Promise<Response> {
    const runtime = env as RuntimeEnv;
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/repos") {
      const denied = requireAdmin(request, runtime);
      if (denied) return denied;
      const input = await body(request);
      const name = repoName(input.name);
      if (!name) return json({ error: "invalid repo name" }, 400);
      const created = await runtime.ARTIFACTS.create(name, {
        description: typeof input.description === "string" ? input.description : undefined,
        setDefaultBranch: typeof input.defaultBranch === "string" ? input.defaultBranch : "main",
      });
      // The initial write token is intentionally not returned: callers mint scoped tokens below.
      return json({ name: created.name, remote: created.remote, defaultBranch: created.defaultBranch }, 201);
    }

    const match = url.pathname.match(/^\/repos\/([^/]+)(?:\/(info|fork|file|tokens))?$/);
    if (!match) return json({ error: "not found" }, 404);
    const [, encodedName, operation = "info"] = match;
    const name = repoName(decodeURIComponent(encodedName));
    if (!name) return json({ error: "invalid repo name" }, 400);

    using repo = await runtime.ARTIFACTS.get(name);
    if (request.method === "GET" && operation === "info") return json(await repo.info());

    if (request.method === "POST" && operation === "fork") {
      const denied = requireAdmin(request, runtime);
      if (denied) return denied;
      const input = await body(request);
      const forkName = repoName(input.name);
      if (!forkName) return json({ error: "invalid fork name" }, 400);
      const forked = await repo.fork(forkName, { defaultBranchOnly: true });
      return json({ name: forked.name, remote: forked.remote, defaultBranch: forked.defaultBranch }, 201);
    }

    if (request.method === "GET" && operation === "file") {
      const ref = url.searchParams.get("ref") ?? "main";
      const path = url.searchParams.get("path");
      if (!path) return json({ error: "path is required" }, 400);
      const file = await repo.readFile({ ref, path });
      if (!file) return json({ error: "file not found" }, 404);
      return new Response(file.stream(), { headers: { "content-type": file.type || "application/octet-stream" } });
    }

    if (request.method === "POST" && operation === "tokens") {
      const denied = requireAdmin(request, runtime);
      if (denied) return denied;
      const input = await body(request);
      const scope = input.scope === "read" ? "read" : "write";
      const ttl = typeof input.ttl === "number" ? input.ttl : 3600;
      return json(await repo.createToken(scope, ttl));
    }
    return json({ error: "method not allowed" }, 405);
  },

  async queue(batch): Promise<void> {
    for (const message of batch.messages) {
      const event = message.body as ArtifactEvent;
      const timestamp = event.metadata?.eventTimestamp;
      const latencyMs = timestamp ? Date.now() - Date.parse(timestamp) : null;
      console.log(JSON.stringify({
        eventType: event.type ?? "unknown",
        namespace: event.source?.namespace,
        repoName: event.source?.repoName,
        payload: event.payload ?? {},
        latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
      }));
      message.ack();
    }
  },
} satisfies ExportedHandler<RuntimeEnv>;
