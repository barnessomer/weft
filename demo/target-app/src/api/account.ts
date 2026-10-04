import { getUser, publicUser } from "../auth/users.ts";
import { revokeSession } from "../auth/session.ts";
import { field, html, json, sessionOf, type Route } from "./router.ts";
import { accountPage } from "../ui/pages.ts";

export const accountRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/me",
    handler: (req) => {
      const session = sessionOf(req);
      const user = session && getUser(session.userId);
      return user ? json(200, publicUser(user)) : json(401, { error: "not signed in" });
    },
  },
  {
    method: "GET",
    path: "/account",
    handler: (req) => {
      const session = sessionOf(req);
      const user = session && getUser(session.userId);
      return user ? html(200, accountPage(publicUser(user))) : html(401, "<p>Please sign in.</p>");
    },
  },
  {
    method: "POST",
    path: "/api/logout",
    handler: (req) => {
      const session = sessionOf(req);
      if (!session) return json(401, { error: "not signed in" });
      revokeSession(session.token);
      return json(200, { ok: field(req.body, "reason") ?? true });
    },
  },
];
