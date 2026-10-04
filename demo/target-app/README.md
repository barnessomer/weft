# target-app

Weft's M1 demo target: a small but real TypeScript auth service with no runtime
dependencies. Node ≥ 22.18 runs the `.ts` sources directly (type stripping).

```
src/auth/users.ts     user store, scrypt password hashing
src/auth/session.ts   session tokens: createSession / getSession / revokeSession
src/api/router.ts     tiny method+path router, JSON bodies, bearer auth helper
src/api/routes.ts     POST /api/login, GET /api/health; mounts the account routes
src/api/account.ts    GET /api/me, POST /api/logout
src/ui/pages.ts       server-rendered HTML: login page, account page
src/server.ts         node:http wiring (npm start)
test/*.test.ts        node:test suites
```

Checks: `node --test "test/**/*.test.ts"` (tests) and `tsc -p .` (types). The M1 scenario
(`demo/scenarios/m1.md`) has two agents change this app at the same time; both must
merge cleanly with tests green.
