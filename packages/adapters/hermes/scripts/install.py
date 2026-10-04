#!/usr/bin/env python3
"""Install / uninstall the Weft Hermes adapter on Hermes profiles.

    python3 packages/adapters/hermes/scripts/install.py                       # default,backend,arq
    python3 packages/adapters/hermes/scripts/install.py --profiles backend
    python3 packages/adapters/hermes/scripts/install.py --uninstall           # undo everything
    python3 packages/adapters/hermes/scripts/install.py --status

What install does (idempotent):
  1. builds dist/analyze.mjs (bundled @weft/analyzer + typescript; node >= 22)
  2. registers the repo on the gateway (POST /v1/admin/repos, admin token from --admin-token-file)
  3. issues one agent token per profile, agent id ``hermes-<profile>``, bound to that repo
     (POST /v1/admin/tokens) unless the config already holds one
  4. writes ~/.config/weft/hermes-adapter.json (mode 600): url, repo, roots, per-profile tokens
  5. copies plugin/weft/* + analyze.mjs into <profile home>/plugins/weft/ and writes an
     INSTALLED.json manifest there (no secrets)
  6. enables the plugin: ``hermes [-p <profile>] plugins enable weft --no-allow-tool-override``

Uninstall reverses 6 -> 3 for the selected profiles (disables + removes the plugin dir, revokes the
profile's token on the gateway, drops it from the config; deletes the config when empty).
Secrets are never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
PLUGIN_SRC = PKG / "plugin" / "weft"
PLUGIN_FILES = ["plugin.yaml", "__init__.py", "adapter.py", "wcp.py"]
DEFAULT_URL = "https://weft-gateway-preview.redacted-subdomain.workers.dev"
DEFAULT_ADMIN = "~/.config/weft/preview-admin-token"
CONFIG = Path(os.environ.get("WEFT_HERMES_CONFIG", "~/.config/weft/hermes-adapter.json")).expanduser()
ROOTS = [
    {"path": "~/github/weft", "prefix": ""},
    {"path": "~/code/hermes-ios/.worktrees/weft-feed", "prefix": "ios/"},
]


def hermes_root() -> Path:
    return Path(os.environ.get("HERMES_REAL_HOME", str(Path.home()))) / ".hermes"


def profile_home(profile: str) -> Path:
    root = hermes_root()
    return root if profile == "default" else root / "profiles" / profile


def node_bin() -> str:
    for c in ("/opt/homebrew/opt/node@24/bin/node", shutil.which("node") or ""):
        if c and os.path.exists(c):
            return c
    sys.exit("node >= 22 not found")


def admin_call(url: str, admin: str, method: str, path: str, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url.rstrip("/") + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {admin}")
    req.add_header("Content-Type", "application/json")
    req.add_header("WCP-Version", "0.1")
    req.add_header("User-Agent", "weft-hermes-installer/0.1")  # Cloudflare 403s Python-urllib
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as err:
        try:
            return err.code, json.loads(err.read() or b"{}")
        except Exception:
            return err.code, None


def load_config() -> dict:
    try:
        return json.loads(CONFIG.read_text())
    except Exception:
        return {}


def save_config(cfg: dict) -> None:
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(CONFIG.parent, 0o700)
    tmp = CONFIG.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    os.replace(tmp, CONFIG)
    os.chmod(CONFIG, stat.S_IRUSR | stat.S_IWUSR)


def hermes(profile: str, *args: str) -> subprocess.CompletedProcess:
    cmd = ["hermes"] + ([] if profile == "default" else ["-p", profile]) + list(args)
    env = {k: v for k, v in os.environ.items() if not k.startswith("HERMES_KANBAN")}
    env.pop("HERMES_PROFILE", None)
    env["HERMES_HOME"] = str(profile_home(profile))
    return subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=120)


def enabled_in_config(profile: str) -> bool:
    text = (profile_home(profile) / "config.yaml").read_text()
    try:
        import yaml  # type: ignore
        cfg = yaml.safe_load(text) or {}
        return "weft" in ((cfg.get("plugins") or {}).get("enabled") or [])
    except ImportError:
        return "- weft" in text


def build() -> Path:
    out = PKG / "dist" / "analyze.mjs"
    env = dict(os.environ, PATH=f"{Path(node_bin()).parent}:{os.environ.get('PATH', '')}")
    subprocess.run([node_bin(), str(PKG / "scripts" / "build.mjs"), str(out)], check=True, env=env,
                   capture_output=True)
    probe = subprocess.run([node_bin(), str(out)], input='{"files":[{"path":"a.ts","before":"","after":"export const a = 1;"}]}',
                           capture_output=True, text=True, timeout=30)
    if '"ok":true' not in probe.stdout:
        sys.exit(f"analyzer bundle probe failed: {probe.stdout} {probe.stderr}")
    return out


def install(args) -> None:
    admin_path = Path(args.admin_token_file).expanduser()
    admin = admin_path.read_text().strip() if admin_path.exists() else ""
    cfg = load_config()
    if cfg.get("url") and cfg["url"] != args.url:
        print(f"note: switching gateway {cfg['url']} -> {args.url}; existing tokens are dropped")
        cfg["agents"] = {}
    cfg.update({"url": args.url, "repo": args.repo, "roots": cfg.get("roots") or ROOTS,
                "mode": args.mode, "node": node_bin()})
    cfg.setdefault("agents", {})

    bundle = build()
    print(f"built analyzer bundle ({bundle.stat().st_size // 1024} KiB)")

    if admin:
        status, body = admin_call(args.url, admin, "POST", "/v1/admin/repos", {"repo": args.repo})
        if status not in (200, 201):
            sys.exit(f"repo registration failed: HTTP {status} {body}")
        print(f"repo '{args.repo}' {'created' if body.get('created') else 'already registered'} on {args.url}")
    for profile in args.profiles:
        home = profile_home(profile)
        if not (home / "config.yaml").exists():
            sys.exit(f"profile '{profile}' not found at {home}")
        agent = f"hermes-{profile}"
        entry = cfg["agents"].get(profile)
        if not entry or not entry.get("token"):
            if not admin:
                sys.exit(f"no token for {profile} and no admin token at {admin_path}")
            status, body = admin_call(args.url, admin, "POST", "/v1/admin/tokens", {
                "principal": agent, "scopes": ["agent"], "repos": [args.repo], "agent": agent,
                "label": f"hermes adapter ({profile} profile)"})
            if status != 201:
                sys.exit(f"token issue failed for {profile}: HTTP {status} {body}")
            cfg["agents"][profile] = {"agent": agent, "token": body["token"], "token_id": body["info"]["id"]}
            print(f"issued agent token {body['info']['id']} for {agent}")
        save_config(cfg)

        dest = home / "plugins" / "weft"
        dest.mkdir(parents=True, exist_ok=True)
        for name in PLUGIN_FILES:
            shutil.copy2(PLUGIN_SRC / name, dest / name)
        shutil.copy2(bundle, dest / "analyze.mjs")
        manifest = {
            "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "source": str(PKG), "profile": profile, "agent": agent, "gateway": args.url,
            "repo": args.repo, "config": str(CONFIG), "files": PLUGIN_FILES + ["analyze.mjs"],
            "uninstall": f"python3 {PKG / 'scripts' / 'install.py'} --uninstall --profiles {profile}",
        }
        (dest / "INSTALLED.json").write_text(json.dumps(manifest, indent=2) + "\n")
        res = hermes(profile, "plugins", "enable", "weft", "--no-allow-tool-override")
        ok = enabled_in_config(profile)
        print(f"[{profile}] plugin -> {dest} ; enabled={ok}" + ("" if ok else f" ({res.stdout.strip()} {res.stderr.strip()})"))
    print(f"config: {CONFIG} (mode 600)")


def uninstall(args) -> None:
    cfg = load_config()
    admin_path = Path(args.admin_token_file).expanduser()
    admin = admin_path.read_text().strip() if admin_path.exists() else ""
    for profile in args.profiles:
        res = hermes(profile, "plugins", "disable", "weft")
        dest = profile_home(profile) / "plugins" / "weft"
        if dest.exists():
            shutil.rmtree(dest)
        entry = (cfg.get("agents") or {}).pop(profile, None)
        revoked = ""
        if entry and entry.get("token_id") and admin and cfg.get("url"):
            status, _ = admin_call(cfg["url"], admin, "DELETE", f"/v1/admin/tokens/{entry['token_id']}")
            revoked = f"; token {entry['token_id']} revoked (HTTP {status})"
        print(f"[{profile}] disabled ({res.returncode}), removed {dest}{revoked}")
    if cfg.get("agents"):
        save_config(cfg)
    elif CONFIG.exists():
        CONFIG.unlink()
        print(f"removed {CONFIG}")


def status(args) -> None:
    cfg = load_config()
    print(f"config {CONFIG}: {'present' if cfg else 'absent'}; gateway {cfg.get('url')}; repo {cfg.get('repo')}; mode {cfg.get('mode')}")
    for profile in args.profiles:
        dest = profile_home(profile) / "plugins" / "weft"
        entry = (cfg.get("agents") or {}).get(profile) or {}
        print(f"[{profile}] plugin dir {'present' if dest.exists() else 'absent'}; enabled={enabled_in_config(profile)}; "
              f"agent={entry.get('agent')} token_id={entry.get('token_id')}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--profiles", default="default,backend,arq")
    p.add_argument("--url", default=DEFAULT_URL)
    p.add_argument("--repo", default="weft")
    p.add_argument("--mode", default="enforce", choices=["enforce", "advise"])
    p.add_argument("--admin-token-file", default=DEFAULT_ADMIN)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--uninstall", action="store_true")
    g.add_argument("--status", action="store_true")
    args = p.parse_args()
    args.profiles = [x.strip() for x in args.profiles.split(",") if x.strip()]
    (uninstall if args.uninstall else status if args.status else install)(args)


if __name__ == "__main__":
    main()
