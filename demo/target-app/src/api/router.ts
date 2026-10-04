import { getSession, type Session } from "../auth/session.ts";

export type Request = { method: string; path: string; headers: Record<string, string | undefined>; body?: unknown };
export type Response = { status: number; headers?: Record<string, string>; body: unknown };
export type Handler = (req: Request) => Response | Promise<Response>;
export type Route = { method: string; path: string; handler: Handler };

export const json = (status: number, body: unknown): Response => ({ status, headers: { "content-type": "application/json" }, body });
export const html = (status: number, body: string): Response => ({ status, headers: { "content-type": "text/html; charset=utf-8" }, body });

/** Bearer-token session of a request, or undefined. */
export function sessionOf(req: Request): Session | undefined {
  const auth = req.headers["authorization"] ?? "";
  const m = /^Bearer (\S+)$/.exec(auth);
  return m ? getSession(m[1]) : undefined;
}

/** A string field of a JSON body, or undefined. */
export function field(body: unknown, name: string): string | undefined {
  const v = body && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
  return typeof v === "string" ? v : undefined;
}

export function createRouter(routes: Route[]): Handler {
  return async (req) => {
    const route = routes.find((r) => r.method === req.method && r.path === req.path);
    if (!route) return json(404, { error: "not found" });
    try {
      return await route.handler(req);
    } catch (err) {
      return json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
