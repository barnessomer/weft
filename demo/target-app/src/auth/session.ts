import { randomBytes } from "node:crypto";

export type Session = { token: string; userId: string; createdAt: number };

const sessions = new Map<string, Session>();

/** Start a session for a user and return it (the token is the bearer credential). */
export function createSession(userId: string): Session {
  const session: Session = { token: randomBytes(24).toString("base64url"), userId, createdAt: Date.now() };
  sessions.set(session.token, session);
  return session;
}

/** The live session for a token, or undefined. */
export function getSession(token: string): Session | undefined {
  return sessions.get(token);
}

export function revokeSession(token: string): boolean {
  return sessions.delete(token);
}

/** Test helper: forget every session. */
export function resetSessions(): void {
  sessions.clear();
}
