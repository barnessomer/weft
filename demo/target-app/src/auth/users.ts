import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export type User = { id: string; email: string; name: string; passwordHash: string };

const users = new Map<string, User>();

function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
}

function checkPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  const candidate = scryptSync(password, salt, 32);
  return timingSafeEqual(candidate, Buffer.from(hash, "hex"));
}

export class UserError extends Error {}

/** Register a user. Emails are unique (case-insensitive). */
export function createUser(email: string, name: string, password: string): User {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(normalized)) throw new UserError("invalid email");
  if (password.length < 8) throw new UserError("password must be at least 8 characters");
  if (findUserByEmail(normalized)) throw new UserError("email already registered");
  const user: User = { id: `u_${randomBytes(6).toString("hex")}`, email: normalized, name: name.trim() || normalized, passwordHash: hashPassword(password) };
  users.set(user.id, user);
  return user;
}

export function findUserByEmail(email: string): User | undefined {
  const normalized = email.trim().toLowerCase();
  for (const u of users.values()) if (u.email === normalized) return u;
  return undefined;
}

export function getUser(id: string): User | undefined {
  return users.get(id);
}

/** The user for an email/password pair, or undefined. */
export function authenticate(email: string, password: string): User | undefined {
  const user = findUserByEmail(email);
  return user && checkPassword(password, user.passwordHash) ? user : undefined;
}

/** Public view of a user (never the password hash). */
export function publicUser(user: User): { id: string; email: string; name: string } {
  return { id: user.id, email: user.email, name: user.name };
}

/** Test helper: forget every user. */
export function resetUsers(): void {
  users.clear();
}
