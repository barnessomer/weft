#!/usr/bin/env python3
"""Live check of the Hermes adapter against a deployed weft-gateway (throwaway repo).

Two adapters stand in for two concurrent Hermes kanban workers (agents hermes-a / hermes-b, one
card each) editing two git worktrees of the same repo. Every step goes through the real hook
entry points (pre_tool_call -> tool -> post_tool_call -> transform_tool_result) and the real
analyzer bundle, against the real gateway. Asserts:

  1. same symbol, same file: the second card's edit result carries a claim_wait diagnostic
  2. signature change vs. call site in another file: the stale card's edit is BLOCKED
     (stale_assumption), the retry after the injected diagnostic is accepted
  3. the feed (observer API) shows both agents' records with human summaries

    python3 packages/adapters/hermes/scripts/verify_live.py [--url URL] [--admin-token-file F]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PKG / "plugin"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from weft.adapter import Config, Root, WeftAdapter  # noqa: E402
from install import DEFAULT_ADMIN, DEFAULT_URL, admin_call, build, node_bin  # noqa: E402


def git(cwd, *args):
    subprocess.run(["git", "-c", "user.email=v@weft", "-c", "user.name=verify", *args], cwd=cwd,
                   check=True, capture_output=True)


def edit(adapter: WeftAdapter, path: Path, old: str, new: str, call_id: str):
    args = {"path": str(path), "old_string": old, "new_string": new}
    block = adapter.pre_tool_call(tool_name="patch", args=args, tool_call_id=call_id)
    if block:
        return "blocked", block["message"]
    path.write_text(path.read_text().replace(old, new, 1))
    adapter.post_tool_call(tool_name="patch", args=args, tool_call_id=call_id, result='{"success": true}')
    out = adapter.transform_tool_result(tool_name="patch", args=args, result='{"success": true}',
                                        tool_call_id=call_id)
    return "applied", (json.loads(out).get("weft_diagnostics") if out else None)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--admin-token-file", default=DEFAULT_ADMIN)
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    admin = Path(a.admin_token_file).expanduser().read_text().strip()
    repo = f"smoke-hermes-{int(time.time())}"
    status, body = admin_call(a.url, admin, "POST", "/v1/admin/repos", {"repo": repo})
    assert status in (200, 201), (status, body)
    tokens = {}
    for agent in ("hermes-a", "hermes-b"):
        status, body = admin_call(a.url, admin, "POST", "/v1/admin/tokens",
                                  {"principal": agent, "scopes": ["agent"], "repos": [repo], "agent": agent})
        assert status == 201, (status, body)
        tokens[agent] = (body["token"], body["info"]["id"])
    status, body = admin_call(a.url, admin, "POST", "/v1/admin/tokens",
                              {"principal": "verify-observer", "scopes": ["observe"], "repos": [repo]})
    observer, observer_id = body["token"], body["info"]["id"]
    bundle = build()

    tmp = Path(tempfile.mkdtemp(prefix="weft-hermes-live-")).resolve()
    main_wt = tmp / "weft"
    (main_wt / "src" / "auth").mkdir(parents=True)
    (main_wt / "src" / "api").mkdir(parents=True)
    (main_wt / "src" / "auth" / "session.ts").write_text(
        "export function refreshToken(token: string): string {\n  return token;\n}\n")
    (main_wt / "src" / "api" / "client.ts").write_text(
        'import { refreshToken } from "../auth/session";\n\n'
        "export function fetchWithAuth(url: string): string {\n  return url + refreshToken(\"t\");\n}\n")
    (main_wt / "src" / "util.ts").write_text("export function helper(n: number): number {\n  return n;\n}\n")
    git(main_wt, "init", "-q")
    git(main_wt, "add", "-A")
    git(main_wt, "commit", "-qm", "init")
    for card in ("card-a", "card-b"):
        git(main_wt, "worktree", "add", "-q", "-b", f"wt/{card}", str(main_wt / ".worktrees" / card))

    adapters = {}
    for agent, card in (("hermes-a", "card-a"), ("hermes-b", "card-b")):
        os.environ["HERMES_KANBAN_TASK"] = card
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(main_wt / ".worktrees" / card)
        os.environ.pop("HERMES_KANBAN_DB", None)
        cfg = Config(url=a.url, repo=repo, token=tokens[agent][0], agent=agent, profile=agent,
                     roots=[Root(str(main_wt), "")], node=node_bin(), analyzer=str(bundle), log_path=None)
        adapters[agent] = WeftAdapter(cfg, heartbeat=False)
    A, B = adapters["hermes-a"], adapters["hermes-b"]
    wa, wb = main_wt / ".worktrees" / "card-a", main_wt / ".worktrees" / "card-b"
    results = []

    def step(name, ok, detail):
        results.append((name, ok))
        print(f"{'PASS' if ok else 'FAIL'} {name}\n     {detail}")

    # B opens its session first (its base predates A's work), with a harmless body edit.
    r = edit(B, wb / "src" / "api" / "client.ts", 'url + refreshToken("t")', 'url + "?" + refreshToken("t")', "b1")
    step("B edits fetchWithAuth body (reads refreshToken via import)", r[0] == "applied", r)

    # 1. same symbol, same file. B is senior (its change was born first, seq #2), so under the
    #    default wound-wait policy B takes the area: B gets an info, A gets the error (asymmetric).
    r = edit(A, wa / "src" / "util.ts", "return n;", "return n + 1;", "a1")
    step("A edits util.ts#helper", r[0] == "applied" and not r[1], r)
    r = edit(B, wb / "src" / "util.ts", "return n;", "return n * 2;", "b2")
    step("B (senior) edits the same symbol -> info claim_contended in B's tool result",
         r[0] == "applied" and r[1] is not None and "claim_contended" in r[1], r)

    # 2. A changes refreshToken's signature; its tool result also carries the claim_wounded push
    r = edit(A, wa / "src" / "auth" / "session.ts", "refreshToken(token: string)",
             "refreshToken(token: string, retries: number)", "a2")
    step("A changes signature of refreshToken; A's result carries claim_wounded (error) for helper",
         r[0] == "applied" and r[1] is not None and "claim_wounded" in r[1], r)
    gate = A.pre_tool_call(tool_name="kanban_complete", args={}, tool_call_id="a3")
    step("A's kanban_complete is refused while claim_wounded is open (L3)",
         gate is not None and gate["action"] == "block" and "util.ts#helper" in gate["message"],
         (gate or {}).get("message", "")[:300])
    r = edit(A, wa / "src" / "util.ts", "return n + 1;", "return n + 2;", "a4")
    step("A reworks helper -> accepted with claim_wait warning (B keeps precedence)",
         r[0] == "applied" and r[1] is not None and "claim_wait" in r[1], r)
    gate = A.pre_tool_call(tool_name="kanban_complete", args={}, tool_call_id="a5")
    step("A's completion gate opens after the rework", gate is None, gate)
    r = edit(B, wb / "src" / "api" / "client.ts", 'url + "?" + refreshToken("t")',
             'url + "?q=" + refreshToken("t")', "b3")
    step("B edits a caller on a stale base -> blocked with stale_assumption",
         r[0] == "blocked" and "stale_assumption" in r[1], r[1][:400] if r[1] else r)
    r = edit(B, wb / "src" / "api" / "client.ts", 'url + "?" + refreshToken("t")',
             'url + "?" + refreshToken("t", 1)', "b4")
    step("B adapts the call and retries -> accepted (base advanced past the diagnostic)", r[0] == "applied", r)
    gate = B.pre_tool_call(tool_name="kanban_complete", args={}, tool_call_id="b5")
    step("B's completion gate is open after the fix", gate is None, gate)

    # 3. the feed
    import urllib.request
    req = urllib.request.Request(f"{a.url}/v1/repos/{repo}/events?limit=100",
                                 headers={"Authorization": f"Bearer {observer}", "WCP-Version": "0.1",
                                          "User-Agent": "weft-hermes-verify/0.1"})
    events = json.loads(urllib.request.urlopen(req, timeout=15).read())["events"]
    lines = [f"#{e['seq']} {e['status']:8} {e['kind']:10} {e['summary']}" for e in events]
    step("feed shows both cards' records with summaries",
         {"hermes-a", "hermes-b"} <= {e.get("agent") for e in events} and all(e.get("summary") for e in events),
         "\n     ".join(lines))

    for ad in adapters.values():
        ad.close()
    for _, tid in tokens.values():
        admin_call(a.url, admin, "DELETE", f"/v1/admin/tokens/{tid}")
    admin_call(a.url, admin, "DELETE", f"/v1/admin/tokens/{observer_id}")
    if not a.keep:
        shutil.rmtree(tmp, ignore_errors=True)
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed (repo {repo})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
