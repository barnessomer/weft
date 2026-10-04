import { authenticate } from "../auth/users.ts";
import { createSession } from "../auth/session.ts";
import { accountRoutes } from "./account.ts";
import { createRouter, field, html, json, type Route } from "./router.ts";
import { loginPage } from "../ui/pages.ts";

/** POST /api/login {email, password} -> {token} */
export function login(email: string, password: string): { token: string } | undefined {
  const user = authenticate(email, password);
  if (!user) return undefined;
  const session = createSession(user.id);
  return { token: session.token };
}

export const routes: Route[] = [
  { method: "GET", path: "/", handler: () => html(200, loginPage()) },
  { method: "GET", path: "/api/health", handler: () => json(200, { ok: true }) },
  {
    method: "POST",
    path: "/api/login",
    handler: (req) => {
      const email = field(req.body, "email");
      const password = field(req.body, "password");
      if (!email || !password) return json(400, { error: "email and password are required" });
      const result = login(email, password);
      return result ? json(200, result) : json(401, { error: "invalid credentials" });
    },
  },
  ...accountRoutes,
];

export const app = createRouter(routes);
