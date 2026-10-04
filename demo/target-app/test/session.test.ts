import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createSession, getSession, resetSessions, revokeSession } from "../src/auth/session.ts";

beforeEach(() => resetSessions());

test("createSession issues a unique token bound to the user", () => {
  const a = createSession("u_1");
  const b = createSession("u_1");
  assert.equal(a.userId, "u_1");
  assert.notEqual(a.token, b.token);
  assert.equal(getSession(a.token)?.userId, "u_1");
});

test("revokeSession ends the session", () => {
  const s = createSession("u_2");
  assert.equal(revokeSession(s.token), true);
  assert.equal(getSession(s.token), undefined);
});
