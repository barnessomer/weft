#!/usr/bin/env python3
"""Live check of weft_land.py against a deployed weft-gateway (throwaway repo).

Plays the PM landing loop end to end with the real adapter, real git and the real gateway:

  1. card A (`wt/t_aaaaaaaa`, agent hermes-a) edits util.ts#helper and commits;
  2. control: card B (`wt/t_bbbbbbbb`, hermes-b) edits the same symbol -> claim_wait (A's soft claim);
  3. the PM merges wt/t_aaaaaaaa into main with `git merge --no-ff` (outside Weft);
  4. weft_land.py --dry-run says would_land; weft_land.py lands it (system `land {sha, op_id}`);
  5. the land is accepted and B's inbox carries trunk_advanced (requires_rebase);
  6. B rebases (`git merge main` through the terminal hook -> checkpoint) and edits helper again:
     accepted with no claim_wait and no stale_overwrite -> A's claims are gone;
  7. re-running weft_land.py is a no-op (already landed).

    python3 packages/adapters/hermes/scripts/verify_land_live.py [--url URL] [--admin-token-file F] [--keep]
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
import weft_land  # noqa: E402
from verify_live import edit, git  # noqa: E402

TA, TB = "t_aaaaaaaa", "t_bbbbbbbb"


def terminal(adapter: WeftAdapter, cwd: Path, command: str, call_id: str) -> str:
    args = {"command": command, "workdir": str(cwd)}
    block = adapter.pre_tool_call(tool_name="terminal", args=args, tool_call_id=call_id)
    assert not block, block
    p = subprocess.run(["git", "-c", "user.email=v@weft", "-c", "user.name=verify", *command.split()[1:]],
                       cwd=cwd, capture_output=True, text=True)
    result = json.dumps({"output": p.stdout + p.stderr, "exit_code": p.returncode})
    adapter.post_tool_call(tool_name="terminal", args=args, tool_call_id=call_id, result=result)
    out = adapter.transform_tool_result(tool_name="terminal", args=args, result=result, tool_call_id=call_id)
    return (json.loads(out).get("weft_diagnostics") or "") if out else ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--admin-token-file", default=DEFAULT_ADMIN)
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    admin = Path(a.admin_token_file).expanduser().read_text().strip()
    repo = f"smoke-land-{int(time.time())}"
    status, body = admin_call(a.url, admin, "POST", "/v1/admin/repos", {"repo": repo})
    assert status in (200, 201), (status, body)
    token_ids = []
    tokens = {}
    for agent in ("hermes-a", "hermes-b"):
        status, body = admin_call(a.url, admin, "POST", "/v1/admin/tokens",
                                  {"principal": agent, "scopes": ["agent"], "repos": [repo], "agent": agent})
        assert status == 201, (status, body)
        tokens[agent] = body["token"]
        token_ids.append(body["info"]["id"])
    status, body = admin_call(a.url, admin, "POST", "/v1/admin/tokens",
                              {"principal": "verify-land", "scopes": ["system", "observe"], "repos": [repo]})
    assert status == 201, (status, body)
    token_ids.append(body["info"]["id"])
    tmp = Path(tempfile.mkdtemp(prefix="weft-land-live-")).resolve()
    sys_token = tmp / "system-token"
    fd = os.open(sys_token, os.O_WRONLY | os.O_CREAT, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(body["token"])
    os.environ["WEFT_LAND_LOG"] = str(tmp / "land.log")
    weft_land.LOG = tmp / "land.log"
    bundle = build()

    main_wt = tmp / "weft"
    (main_wt / "src").mkdir(parents=True)
    (main_wt / "src" / "util.ts").write_text(
        "export function helper(n: number): number {\n  return n;\n}\n\n"
        "export function other(n: number): number {\n  return n;\n}\n")
    git(main_wt, "init", "-q", "-b", "main")
    git(main_wt, "add", "-A")
    git(main_wt, "commit", "-qm", "init")
    wa, wb = main_wt / ".worktrees" / "a", main_wt / ".worktrees" / "b"
    git(main_wt, "worktree", "add", "-q", "-b", f"wt/{TA}", str(wa))
    git(main_wt, "worktree", "add", "-q", "-b", f"wt/{TB}", str(wb))

    adapters = {}
    for agent, task, wt in (("hermes-a", TA, wa), ("hermes-b", TB, wb)):
        os.environ["HERMES_KANBAN_TASK"] = task
        os.environ["HERMES_KANBAN_WORKSPACE"] = str(wt)
        os.environ.pop("HERMES_KANBAN_DB", None)
        cfg = Config(url=a.url, repo=repo, token=tokens[agent], agent=agent, profile=agent,
                     roots=[Root(str(main_wt), "")], node=node_bin(), analyzer=str(bundle), log_path=None)
        adapters[agent] = WeftAdapter(cfg, heartbeat=False)
    A, B = adapters["hermes-a"], adapters["hermes-b"]
    results = []

    def step(name, ok, detail):
        results.append((name, ok))
        print(f"{'PASS' if ok else 'FAIL'} {name}\n     {detail}")

    land_args = ["--git-dir", str(main_wt), "--repo", repo, "--url", a.url, "--token-file", str(sys_token),
                 "--kanban-db", str(tmp / "no-kanban.db")]

    # 1. card A edits helper and commits on its branch
    r = edit(A, wa / "src" / "util.ts", "return n;\n}\n\nexport function other", "return n + 1;\n}\n\nexport function other", "a1")
    step("A edits util.ts#helper (soft claim, 30 min TTL)", r[0] == "applied" and not r[1], r)
    git(wa, "commit", "-qam", f"util: helper +1 [{TA}]")

    # 2. control: B edits the same symbol while A's claim is live -> claim_wait
    f = wb / "src" / "util.ts"
    r = edit(B, f, "return n;\n}\n\nexport function other", "return n * 2;\n}\n\nexport function other", "b1")
    step("control: B edits helper before the land -> claim_wait citing A", r[0] == "applied" and r[1] is not None
         and "claim_wait" in r[1] and TA in r[1], (r[1] or "")[:300])
    git(wb, "checkout", "--", "src/util.ts")  # B drops that edit (outside Weft; nothing recorded)

    # 3. the PM merges A's branch outside Weft
    git(main_wt, "merge", "--no-ff", "--no-edit", f"wt/{TA}")
    merge_sha = subprocess.run(["git", "-C", str(main_wt), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()

    # 4. weft_land.py: dry run, then land
    import contextlib
    import io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = weft_land.main(land_args + ["--dry-run"])
    out = buf.getvalue()
    step("weft_land.py --dry-run maps wt/t_aaaaaaaa -> hermes-a/t_aaaaaaaa: would_land", rc == 0
         and f"hermes-a/{TA}: would_land" in out and "hermes-b" not in out, out.strip())
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = weft_land.main(land_args)
    out = buf.getvalue()
    step("weft_land.py lands the merge", rc == 0 and f"hermes-a/{TA}: landed" in out, out.strip())

    gw = weft_land.Gateway(a.url, sys_token.read_text().strip(), repo)
    lands, _ = gw.events(kind="land")
    land = lands[-1] if lands else {}
    step("land record: accepted, change hermes-a/t_aaaaaaaa, payload sha = merge sha, op_id",
         land.get("status") == "accepted" and land.get("change") == f"hermes-a/{TA}"
         and (land.get("payload") or {}).get("sha") == merge_sha and (land.get("payload") or {}).get("op_id")
         == weft_land.op_id(repo, f"hermes-a/{TA}", merge_sha),
         f"#{land.get('seq')} {land.get('status')} {land.get('summary')} writes={[w.get('key') for w in land.get('writes', [])]}")

    # 5. B is told trunk advanced
    B._drain()
    pending = "\n".join(t for t, _, _ in B.outbox)
    step("B's inbox: trunk_advanced (requires_rebase) for the landing", "trunk_advanced" in pending, pending[:300])
    # Not acked yet: the rebase's checkpoint verdict repeats the trunk item (adapter must still lift
    # its rebase floor; it is injected + acked with the terminal tool result below).

    # 6. B rebases onto main, then edits helper again
    d = terminal(B, wb, "git merge --no-edit main", "b3")
    step("B merges main through the terminal hook (checkpoint)", "return n + 1" in f.read_text(), d[:200] or "no diagnostics")
    r = edit(B, f, "return n + 1;\n}\n\nexport function other", "return (n + 1) * 2;\n}\n\nexport function other", "b4")
    step("B edits helper after the land -> accepted, no claim_wait / stale_overwrite (A's claims are gone)",
         r[0] == "applied" and not any(c in (r[1] or "") for c in ("claim_wait", "stale_overwrite", "claim_contended")),
         r)

    # 7. idempotent rerun
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = weft_land.main(land_args)
    out = buf.getvalue()
    step("re-running weft_land.py is a no-op (already landed)", rc == 0 and "already landed" in out and "landed seq" not in out,
         out.strip())

    events, _ = gw.events()
    print("\n     " + "\n     ".join(f"#{e['seq']} {e['status']:8} {e['kind']:10} {e['summary']}" for e in events))
    for ad in adapters.values():
        ad.close()
    for tid in token_ids:
        admin_call(a.url, admin, "DELETE", f"/v1/admin/tokens/{tid}")
    if not a.keep:
        shutil.rmtree(tmp, ignore_errors=True)
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed (repo {repo})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
