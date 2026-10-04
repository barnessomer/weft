import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/api/routes.ts";
import { createUser, resetUsers } from "../src/auth/users.ts";
import { resetSessions } from "../src/auth/session.ts";

const call = (method: string, path: string, body?: unknown, token?: string) =>
  app({ method, path, body, headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeEach(() => {
  resetUsers();
  resetSessions();
  createUser("ada@example.com", "Ada", "correct horse");
});

test("login with valid credentials returns a token that works for /api/me", async () => {
  const res = await call("POST", "/api/login", { email: "ADA@example.com", password: "correct horse" });
  assert.equal(res.status, 200);
  const { token } = res.body as { token: string };
  const me = await call("GET", "/api/me", undefined, token);
  assert.deepEqual(me.body, { id: (me.body as { id: string }).id, email: "ada@example.com", name: "Ada" });
});

test("login rejects a wrong password and missing fields", async () => {
  assert.equal((await call("POST", "/api/login", { email: "ada@example.com", password: "nope nope" })).status, 401);
  assert.equal((await call("POST", "/api/login", { email: "ada@example.com" })).status, 400);
});

test("logout revokes the token", async () => {
  const { token } = (await call("POST", "/api/login", { email: "ada@example.com", password: "correct horse" })).body as { token: string };
  assert.equal((await call("POST", "/api/logout", {}, token)).status, 200);
  assert.equal((await call("GET", "/api/me", undefined, token)).status, 401);
});

test("pages render and unknown routes 404", async () => {
  const home = await call("GET", "/");
  assert.match(String(home.body), /<h1>Sign in<\/h1>/);
  assert.equal((await call("GET", "/nope")).status, 404);
});
