// Token grants and scope rules (spec §3). Shared by the gateway (HTTP) and the Durable
// Object (WebSocket auth frames).

import type { Scope } from "@weft/protocol";

export type Grant = {
  /** Token id (not the token). */
  id: string;
  /** Who the token acts as: agent id, human id, or service name. */
  principal: string;
  scopes: Scope[];
  /** Repos the token may access, or "*" for all. */
  repos: string[] | "*";
  /** Agent tokens: the bound agent id (required for scope `agent`). */
  agent?: string;
  /** Agent tokens: optional bound change id. */
  change?: string;
};

export function canAccessRepo(g: Grant, repo: string): boolean {
  return g.repos === "*" || g.repos.includes(repo);
}

/** `human` implies `observe` (spec §1). No other implication exists. */
export function hasScope(g: Grant, scope: Scope): boolean {
  if (g.scopes.includes(scope)) return true;
  return scope === "observe" && g.scopes.includes("human");
}

export function visibleRepos(g: Grant, all: string[]): string[] {
  return g.repos === "*" ? all : all.filter((r) => (g.repos as string[]).includes(r));
}

export interface TokenVerifier {
  verify(token: string): Promise<Grant | null>;
}
