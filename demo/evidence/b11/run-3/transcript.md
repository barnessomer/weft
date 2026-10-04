# B11 negotiation run 3 — PASS

Coordinator: http://127.0.0.1:8799, repo `demo-b11-20261004-081018-r3`. Agents: claude-a (T-1, priority 1), claude-b (T-2, priority 0), both `claude -p` with the Weft Claude Code adapter.

## Criteria

- ✔ b_denied_at_edit_time_by_a
- ✔ b_proposed_overload
- ✔ proposal_injected_into_a
- ✔ a_accepted
- ✔ a_made_agreed_edit (re-scored: a_made_agreed_edit re-scored from coordinator-log.json with the fixed rule (accepted A edit of createSession after the proposal #10); value at run time: True)
- ✔ b_kept_old_call
- ✔ both_landed
- ✔ tests_green

## Coordinator log (every record)

| seq | status | kind | summary |
|---|---|---|---|
| 1 | accepted | join | claude-b joined (claude-code, L3) |
| 2 | accepted | join | claude-a joined (claude-code, L3) |
| 3 | accepted | edit | claude-a changed signature of createSession, createSession.session +1 more, edited getSession, added createSession.createdAt, getSession.se… |
| 4 | accepted | edit | claude-a changed signature of login.session, edited login in src/api/routes.ts — Session expiry |
| 5 | accepted | edit | claude-a changed signature of a, b +1 more, added opts in test/session.test.ts — Session expiry |
| 6 | accepted | leave | claude-a left — claude-code session end: other |
| 7 | accepted | leave | claude-b left — claude-code session end: other |
| 8 | accepted | join | claude-b joined (claude-code, L3) |
| 9 | rejected | edit | Blocked: claude-b changed signature of accountRoutes, accountRoutes.session +1 more, added accountRoutes.email, accountRoutes.err +1 more i… |
| 10 | accepted | negotiate.propose | claude-b → I06b0e85c7d63dece211244fd05fdb988127f8d9b: proposes overload on createSession |
| 11 | accepted | join | claude-a joined (claude-code, L3) |
| 12 | accepted | negotiate.accept | claude-a accepted #10 |
| 13 | accepted | edit | claude-a changed signature of createSession, added DEFAULT_SESSION_TTL_MS in src/auth/session.ts — Session expiry |
| 14 | rejected | edit | Blocked: claude-b changed signature of accountRoutes, accountRoutes.session +1 more, added accountRoutes.email, accountRoutes.err +1 more i… |
| 15 | accepted | leave | claude-a left — claude-code session end: other |
| 16 | accepted | edit | claude-b changed signature of accountRoutes, accountRoutes.session +1 more, added accountRoutes.email, accountRoutes.err +1 more in src/api… |
| 17 | accepted | edit | claude-b added bad, call +4 more in test/signup.test.ts — Signup endpoint |
| 18 | accepted | leave | claude-b left — claude-code session end: other |
| 19 | accepted | land | claude-a landed I06b0e85c7d63dece211244fd05fdb988127f8d9b (14 symbols) |
| 20 | accepted | land | claude-b landed I5f59768b58e533f9257596b082391fcdeade7281 (12 symbols) |

## What Weft injected into claude-b (verbatim, in order)

### 08:10:19 SessionStart

```text
[weft] This checkout is coordinated by Weft (repo demo-b11-20261004-081018-r3; you are agent claude-b, task T-2 "Signup endpoint", change I5f59768b58e533f9257596b082391fcdeade7281). Other agents edit the same codebase concurrently in their own checkouts. Every edit you make is checked against their work: lines like "[weft error] <code> <file>:<line>: …" are multi-agent compiler diagnostics. An edit with errors is blocked, and you cannot finish while errors are open — fix the cited code (or retreat from it) instead of retrying the same edit. When another agent's change is in your way you may also negotiate with it (`/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/.weft/bin/weft negotiate propose|accept|reject|counter|escalate …`, see `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/.weft/bin/weft negotiate --help`); proposals addressed to you arrive as "[weft negotiation]" lines and must be answered before you finish. `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/.weft/bin/weft inbox` shows what is waiting for you.
```

### 08:10:42 SessionStart

```text
[weft] This checkout is coordinated by Weft (repo demo-b11-20261004-081018-r3; you are agent claude-b, task T-2 "Signup endpoint", change I5f59768b58e533f9257596b082391fcdeade7281). Other agents edit the same codebase concurrently in their own checkouts. Every edit you make is checked against their work: lines like "[weft error] <code> <file>:<line>: …" are multi-agent compiler diagnostics. An edit with errors is blocked, and you cannot finish while errors are open — fix the cited code (or retreat from it) instead of retrying the same edit. When another agent's change is in your way you may also negotiate with it (`/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/.weft/bin/weft negotiate propose|accept|reject|counter|escalate …`, see `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/.weft/bin/weft negotiate --help`); proposals addressed to you arrive as "[weft negotiation]" lines and must be answered before you finish. `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/.weft/bin/weft inbox` shows what is waiting for you.
```

### 08:10:50 PreToolUse Edit → deny

```text
[weft] Edit to src/api/account.ts blocked: it conflicts with another agent's change (Weft edit-time coordination, log #9).
[weft error] stale_assumption src/api/account.ts:44:25: You use src/auth/session.ts#createSession, whose signature changed in #3 by claude-a after your base #1. (caused by claude-a · task T-1 · event #3). Suggestion: Read the new src/auth/session.ts#createSession (event #3) and update this call site, or negotiate with claude-a.
  ↳ event #3 by claude-a changed src/auth/session.ts (their change is not in your checkout yet):
    @@ -1,19 +1,33 @@
     import { randomBytes } from "node:crypto";
     
    -export type Session = { token: string; userId: string; createdAt: number };
    +export type Session = { token: string; userId: string; createdAt: number; expiresAt: number };
     
    +export type SessionOptions = { ttlMs: number };
    +
     const sessions = new Map<string, Session>();
     
     /** Start a session for a user and return it (the token is the bearer credential). */
    -export function createSession(userId: string): Session {
    -  const session: Session = { token: randomBytes(24).toString("base64url"), userId, createdAt: Date.now() };
    +export function createSession(userId: string, opts: SessionOptions): Session {
    +  const createdAt = Date.now();
    +  const session: Session = {
    +    token: randomBytes(24).toString("base64url"),
    +    userId,
    +    createdAt,
    +    expiresAt: createdAt + opts.ttlMs,
    +  };
       sessions.set(session.token, session);
       return session;
     }
     
    -/** The live session for a token, or undefined. */
    +/** The live session for a token, or undefined (expired sessions are forgotten). */
     export function getSession(token: string): Session | undefined {
    -  return sessions.get(token);
    +  const session = sessions.get(token);
    … (10 more lines)
  ↳ Your options: retreat (rework without that code) | wait (until claude-a lands or releases it) | negotiate: `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/.weft/bin/weft negotiate propose overload "<what claude-a should keep working for you>" --wait 240` (terms: overload | transfer | share | sequence | merge_tasks | other; it is delivered to claude-a and you get the reply) | escalate: `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/.weft/bin/weft negotiate escalate "<why>"` (the coordinator merges your two tasks).
Do not retry the same edit. Adapt your code to the change described above (or work around it), then edit again — your next attempt is checked against the current log.
```

### 08:11:09 PreToolUse Edit → deny

```text
[weft] Edit to src/api/account.ts blocked: it conflicts with another agent's change (Weft edit-time coordination, log #14).
[weft error] stale_assumption src/api/account.ts:44:25: You use src/auth/session.ts#createSession, whose signature changed in #13 by claude-a after your base #12. (caused by claude-a · task T-1 · event #13). Suggestion: Read the new src/auth/session.ts#createSession (event #13) and update this call site, or negotiate with claude-a.
  ↳ event #13 by claude-a changed src/auth/session.ts (their change is not in your checkout yet):
    @@ -4,10 +4,15 @@
     
     export type SessionOptions = { ttlMs: number };
     
    +/** Platform default session lifetime, used when no options are given. */
    +export const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
    +
     const sessions = new Map<string, Session>();
     
     /** Start a session for a user and return it (the token is the bearer credential). */
    -export function createSession(userId: string, opts: SessionOptions): Session {
    +export function createSession(userId: string): Session;
    +export function createSession(userId: string, opts: SessionOptions): Session;
    +export function createSession(userId: string, opts: SessionOptions = { ttlMs: DEFAULT_SESSION_TTL_MS }): Session {
       const createdAt = Date.now();
       const session: Session = {
         token: randomBytes(24).toString("base64url"),
    
  ↳ Your options: retreat (rework without that code) | wait (until claude-a lands or releases it) | negotiate: `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/.weft/bin/weft negotiate propose overload "<what claude-a should keep working for you>" --wait 240` (terms: overload | transfer | share | sequence | merge_tasks | other; it is delivered to claude-a and you get the reply) | escalate: `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/.weft/bin/weft negotiate escalate "<why>"` (the coordinator merges your two tasks).
Do not retry the same edit. Adapt your code to the change described above (or work around it), then edit again — your next attempt is checked against the current log.
```

## What Weft injected into claude-a (verbatim, in order)

### 08:10:19 SessionStart

```text
[weft] This checkout is coordinated by Weft (repo demo-b11-20261004-081018-r3; you are agent claude-a, task T-1 "Session expiry", change I06b0e85c7d63dece211244fd05fdb988127f8d9b). Other agents edit the same codebase concurrently in their own checkouts. Every edit you make is checked against their work: lines like "[weft error] <code> <file>:<line>: …" are multi-agent compiler diagnostics. An edit with errors is blocked, and you cannot finish while errors are open — fix the cited code (or retreat from it) instead of retrying the same edit. When another agent's change is in your way you may also negotiate with it (`/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-a/.weft/bin/weft negotiate propose|accept|reject|counter|escalate …`, see `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-a/.weft/bin/weft negotiate --help`); proposals addressed to you arrive as "[weft negotiation]" lines and must be answered before you finish. `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-a/.weft/bin/weft inbox` shows what is waiting for you.
```

### 08:10:57 SessionStart

```text
[weft] This checkout is coordinated by Weft (repo demo-b11-20261004-081018-r3; you are agent claude-a, task T-1 "Session expiry", change I06b0e85c7d63dece211244fd05fdb988127f8d9b). Other agents edit the same codebase concurrently in their own checkouts. Every edit you make is checked against their work: lines like "[weft error] <code> <file>:<line>: …" are multi-agent compiler diagnostics. An edit with errors is blocked, and you cannot finish while errors are open — fix the cited code (or retreat from it) instead of retrying the same edit. When another agent's change is in your way you may also negotiate with it (`/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-a/.weft/bin/weft negotiate propose|accept|reject|counter|escalate …`, see `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-a/.weft/bin/weft negotiate --help`); proposals addressed to you arrive as "[weft negotiation]" lines and must be answered before you finish. `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-a/.weft/bin/weft inbox` shows what is waiting for you.
[weft negotiation] #10 claude-b (change I5f59768b58e533f9257596b082391fcdeade7281, task T-2) proposes to you: overload on src/auth/session.ts#createSession — "Please keep createSession(userId) (no opts) working as an overload that uses the platform default session lifetime. T-2 signup (POST /api/signup in src/api/account.ts) must call createSession(user.id) exactly as login originally did and must not choose session options itself (product rule: signup sessions use the default lifetime).". Answer it: accept #10 | reject #10 | counter #10 with other terms.
  ↳ Answer from the shell: `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-a/.weft/bin/weft negotiate accept 10` | `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-a/.weft/bin/weft negotiate reject 10 "<why>"` | `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-a/.weft/bin/weft negotiate counter 10 <overload|transfer|share|sequence|merge_tasks|other> "<terms>"`.
```

## claude-b (turn 2): tool calls and final answer

- Read /Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/src/api/account.ts
- Edit /Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/src/api/account.ts
- Edit /Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/src/api/account.ts

  ```text
  PreToolUse:Edit hook error: [weft] Edit to src/api/account.ts blocked: it conflicts with another agent's change (Weft edit-time coordination, log #9).
  [weft error] stale_assumption src/api/account.ts:44:25: You use src/auth/session.ts#createSession, whose signature changed in #3 by claude-a after your base #1. (caused by claude-a · task T-1 · event #3). Suggestion: Read the new src/auth/session.ts#createSession (event #3) and update this call site, or negotiate with claude-a.
    ↳ event #3 by claude-a changed src/auth/session.ts (their change is not in your checkout yet):
      @@ -1,19 +1,33 @@
       import { randomBytes } from "node:crypto";
       
      -export type Session = { token: string; userId: string; createdAt: number };
      +export type Session = { token: string; userId: string; createdAt: number; expiresAt: number };
       
      +export type SessionOptions = { ttlMs: number };
      +
       const sessions = new Map<string, Session>();
       
       /** Start a session for a user and return it (the token is the bearer credential). */
      -export function createSession(userId: string): Session {
      -  const session: Session = { token: randomBytes(24).toString("base64url"), userId, createdAt: Date.now() };
      +export function createSession(userId: string, opts: SessionOptions): Session {
      +  const createdAt = Date.now();
      +  const session: Session = {
      +    token: randomBytes(24).toString("base64url"),
      +    userId,
      +    createdAt,
      +    expiresAt: createdAt + opts.ttlMs,
      +  };
         sessions.set(session.token, session);
         return session;
       }
       
      -/** The live session for a token, or undefined. */
      +/** The live session for a token, or undefined (expired sessions are forgotten). */
       export function getSession(token: string): Session | undefined {
      -  return sessions.get(token);
      +  const session = sessions.get(token);
      … (10 more lines)
    ↳ Your options: retreat (rework without that code) | wait (until claude-a lands or releases it) | negotiate: `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/.weft/bin/weft negotiate propose overload "<what claude-a should keep working for you>" --wait 240` (terms: overload | transfer | share | sequence | merge_tasks | other; it is delivered to claude-a and you get the reply) | escalate: `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/.weft/bin/weft negotiate escalate "<why>"` (the coordinator merges your two tasks).
  Do not retry the same edit. Adapt your code to the change described above (or work around it), then edit again — your next attempt is checked against the current log.
  ```

- Bash: `.weft/bin/weft negotiate propose overload "Please keep createSession(userId) (no opts) working as an overload that uses the platform default session lifetime. T-2 signup (POST /api/signup in src/api/account.ts) must call createSession(user.id) exactly as login originally did and must not choose session options itself (product rule: signup sessions use the default lifetime)." --wait 100`

  ```text
  [weft] sent #10: claude-b → I06b0e85c7d63dece211244fd05fdb988127f8d9b: proposes overload on createSession
  [weft negotiation] #12 claude-a (change I06b0e85c7d63dece211244fd05fdb988127f8d9b, task T-1) ACCEPTED #10. The agreement is binding and recorded in the log for both sides.
    ↳ claude-a agreed (#12, overload: "Please keep createSession(userId) (no opts) working as an overload that uses the platform default session lifetime. T-2 signup (POST /api/signup in src/api/account.ts) must call createSession(user.id) exactly as login originally did and must not choose session options itself (product rule: signup sessions use the default lifetime)." on src/auth/session.ts#createSession). Continue with your original plan; if one more edit is blocked by their follow-up change, read the quoted diff (it should be the agreed change) and retry the same edit.
  ```

- Edit /Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/src/api/account.ts

  ```text
  PreToolUse:Edit hook error: [weft] Edit to src/api/account.ts blocked: it conflicts with another agent's change (Weft edit-time coordination, log #14).
  [weft error] stale_assumption src/api/account.ts:44:25: You use src/auth/session.ts#createSession, whose signature changed in #13 by claude-a after your base #12. (caused by claude-a · task T-1 · event #13). Suggestion: Read the new src/auth/session.ts#createSession (event #13) and update this call site, or negotiate with claude-a.
    ↳ event #13 by claude-a changed src/auth/session.ts (their change is not in your checkout yet):
      @@ -4,10 +4,15 @@
       
       export type SessionOptions = { ttlMs: number };
       
      +/** Platform default session lifetime, used when no options are given. */
      +export const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
      +
       const sessions = new Map<string, Session>();
       
       /** Start a session for a user and return it (the token is the bearer credential). */
      -export function createSession(userId: string, opts: SessionOptions): Session {
      +export function createSession(userId: string): Session;
      +export function createSession(userId: string, opts: SessionOptions): Session;
      +export function createSession(userId: string, opts: SessionOptions = { ttlMs: DEFAULT_SESSION_TTL_MS }): Session {
         const createdAt = Date.now();
         const session: Session = {
           token: randomBytes(24).toString("base64url"),
      
    ↳ Your options: retreat (rework without that code) | wait (until claude-a lands or releases it) | negotiate: `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/.weft/bin/weft negotiate propose overload "<what claude-a should keep working for you>" --wait 240` (terms: overload | transfer | share | sequence | merge_tasks | other; it is delivered to claude-a and you get the reply) | escalate: `/Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/.weft/bin/weft negotiate escalate "<why>"` (the coordinator merges your two tasks).
  Do not retry the same edit. Adapt your code to the change described above (or work around it), then edit again — your next attempt is checked against the current log.
  ```

- Edit /Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/src/api/account.ts
- Write /Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-b/test/signup.test.ts
- Bash: `node --test "test/**/*.test.ts" 2>&1 | tail -15; .weft/bin/weft inbox`

Final answer:

> `POST /api/signup` is in, and `node --test "test/**/*.test.ts"` passes all 9 tests: the 6 existing ones and 3 new signup tests. Weft has no open errors and nothing waiting in the inbox.
> 
> **What I changed**
> - **`src/api/account.ts`**: added the `/api/signup` route to `accountRoutes`, as in the plan.
>   - It returns 400 if email or password is missing.
>   - It calls `createUser`, then `createSession(user.id)` with only the user id, as login originally did. It sets no session options.
>   - On success it responds 201 with `{token, user: publicUser(user)}`.
>   - A `UserError` becomes 400 `{error}`; any other error is rethrown and the router turns it into a 500.
> - **`test/signup.test.ts`** (new), with three tests:
>   - **Success path:** checks the 201 response and the lowercased email, that no password hash is returned, that the token works for `/api/me`, and that the new user can log in.
>   - **`UserError` cases:** a duplicate email (different case), a short password and an invalid email each return 400 with their message.
>   - **Missing fields:** no password returns 400.
> 
> **How the negotiation went**
> 1. My route edit was blocked because claude-a (T-1) had changed the signature to `createSession(userId, opts: SessionOptions)` so they could add session expiry.
> 2. Following your rule, I didn't switch to the new call. I sent claude-a an overload proposal asking them to keep `createSession(userId)` working with the platform's default lifetime, because signup must not choose session options.
> 3. claude-a accepted right away. Weft records the agreement as binding (#12).
> 4. My retry was blocked once more by their follow-up change. That change was the agreed overload: `createSession(userId)` now falls back to a new `DEFAULT_SESSION_TTL_MS` (one hour). As Weft instructed, I retried the same edit unchanged and it went through.
> 
> The tests ran against this checkout's `session.ts`, which doesn't have claude-a's change yet. Their version is reviewed but untested here: their overload keeps `createSession(user.id)` valid, so signup should work the same once their change is merged first. I haven't committed anything.

## claude-a: tool calls and final answer

- Bash: `cat src/auth/session.ts src/api/routes.ts test/session.test.ts`
- Write /Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-a/src/auth/session.ts
- Edit /Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-a/src/api/routes.ts
- Write /Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-a/test/session.test.ts
- Bash: `node --test "test/**/*.test.ts" 2>&1 | tail -15; .weft/bin/weft inbox`

Final answer:

> Sessions now expire after their TTL: `createSession` takes `{ ttlMs }`, the login route uses one hour, and a new expiry test passes; all 7 tests pass and Weft shows no open errors.

## claude-a (resumed): tool calls and final answer

- Bash: `.weft/bin/weft negotiate accept 10`

  ```text
  [weft] sent #12: claude-a accepted #10
  ```

- Edit /Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-a/src/auth/session.ts
- Edit /Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-a/test/session.test.ts
- Edit /Users/john/.hermes/cache/scratch/weft-b11-20261004-081018-r3/agent-a/test/session.test.ts
- Bash: `node --test "test/**/*.test.ts" 2>&1 | grep -E "^(✖|ℹ (pass|fail))"; .weft/bin/weft inbox`

Final answer:

> I accepted claude-b's request #10, so `createSession(userId)` without options still works and uses a new 1-hour `DEFAULT_SESSION_TTL_MS`; all 8 tests pass and Weft's inbox is empty.

## Landing

```text
agent-a commit: auth: sessions expire (T-1)

Change-Id: I06b0e85c7d63dece211244fd05fdb988127f8d9b
Task-Id: T-1
Agent-Id: claude-a
agent-b commit: api: POST /api/signup (T-2)

Change-Id: I5f59768b58e533f9257596b082391fcdeade7281
Task-Id: T-2
Agent-Id: claude-b
--- agent-a alone: tsc exit 0, tests exit 0
--- agent-b alone (A's change not merged yet): tsc exit 0, tests exit 0

--- land agent-a: {"ok":true,"sha":"4082f675faeb277de6c8e548cce8e41a993c9008","seq":19,"status":"accepted"}; land agent-b: {"ok":true,"sha":"dc705d0e8372f8cebb201b633f62dd042f155053","seq":20,"status":"accepted"}
*   dc705d0 Merge branch 'agent-b'
|\  
| * 9c4b687 api: POST /api/signup (T-2)
* |   4082f67 Merge branch 'agent-a'
|\ \  
| |/  
|/|   
| * 527b61b auth: sessions expire (T-1)
|/  
* 627abea target-app: initial
--- main after both landings: tsc exit 0

--- main: node --test exit 0
✔ login with valid credentials returns a token that works for /api/me (47.194792ms)
✔ login rejects a wrong password and missing fields (44.563042ms)
✔ logout revokes the token (47.728625ms)
✔ pages render and unknown routes 404 (30.41325ms)
✔ createSession issues a unique token bound to the user (0.521208ms)
✔ createSession without options uses the default lifetime (0.079541ms)
✔ revokeSession ends the session (0.071542ms)
✔ getSession forgets a session once it expires (0.247958ms)
✔ signup creates the user and returns a working session token (47.06875ms)
✔ signup maps UserError to 400 (22.340458ms)
✔ signup requires email and password (0.096375ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 232.889916
--- main:src/auth/session.ts
import { randomBytes } from "node:crypto";

export type Session = { token: string; userId: string; createdAt: number; expiresAt: number };

export type SessionOptions = { ttlMs: number };

/** Platform default session lifetime, used when no options are given. */
export const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

const sessions = new Map<string, Session>();

/** Start a session for a user and return it (the token is the bearer credential). */
export function createSession(userId: string): Session;
export function createSession(userId: string, opts: SessionOptions): Session;
export function createSession(userId: string, opts: SessionOptions = { ttlMs: DEFAULT_SESSION_TTL_MS }): Session {
  const createdAt = Date.now();
  const session: Session = {
    token: randomBytes(24).toString("base64url"),
    userId,
    createdAt,
    expiresAt: createdAt + opts.ttlMs,
  };
  sessions.set(session.token, session);
  return session;
}

/** The live session for a token, or undefined (expired sessions are forgotten). */
export function getSession(token: string): Session | undefined {
  const session = sessions.get(token);
  if (!session) return undefined;
  if (Date.now() >= session.expiresAt) {
    sessions.delete(token);
    return undefined;
  }
  return session;
}

export function revokeSession(token: string): boolean {
  return sessions.delete(token);
}

/** Test helper: forget every session. */
export function resetSessions(): void {
  sessions.clear();
}

--- main:src/api/account.ts
import { createUser, getUser, publicUser, UserError } from "../auth/users.ts";
import { createSession, revokeSession } from "../auth/session.ts";
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
  {
    method: "POST",
    path: "/api/signup",
    handler: (req) => {
      const email = field(req.body, "email");
      const password = field(req.body, "password");
      if (!email || !password) return json(400, { error: "email and password are required" });
      try {
        const user = createUser(email, field(req.body, "name") ?? "", password);
        const session = createSession(user.id);
        return json(201, { token: session.token, user: publicUser(user) });
      } catch (err) {
        if (err instanceof UserError) return json(400, { error: err.message });
        throw err;
      }
    },
  },
];
```
