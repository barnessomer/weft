"""Minimal WCP v0.1 HTTP client (stdlib only; runs inside the Hermes Python process).

Spec: docs/protocol/wcp-v0.md (§2 transport, §8.2 session lifecycle, §11 errors).
Every call has a short timeout because Hermes bounds ``pre_tool_call`` hooks and fails
*closed* on timeout; the adapter itself fails *open* on any WcpError it gets from here.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

PROTOCOL = "wcp/0.1"
WCP_VERSION = "0.1"


class WcpError(Exception):
    """A protocol error (§11) or a transport failure (code ``transport``)."""

    def __init__(self, code: str, message: str, status: int = 0, details: Optional[dict] = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status = status
        self.details = details or {}


class WcpClient:
    def __init__(self, base_url: str, token: str, repo: str, timeout: float = 4.0):
        self.base = base_url.rstrip("/")
        if not self.base.endswith("/v1"):
            self.base += "/v1"
        self.token = token
        self.repo = repo
        self.timeout = timeout

    # -- transport -------------------------------------------------------------------------

    def _request(self, method: str, path: str, body: Any = None,
                 headers: Optional[Dict[str, str]] = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("WCP-Version", WCP_VERSION)
        req.add_header("User-Agent", "weft-hermes-adapter/0.1")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            try:
                payload = json.loads(err.read() or b"{}")
            except Exception:
                payload = {}
            e = payload.get("error") if isinstance(payload, dict) else None
            if isinstance(e, dict):
                raise WcpError(str(e.get("code", "http")), str(e.get("message", "")), err.code,
                               e.get("details") if isinstance(e.get("details"), dict) else None)
            raise WcpError("http", f"HTTP {err.code}", err.code)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as err:
            raise WcpError("transport", str(err))

    def _session_path(self, session: str, suffix: str = "") -> str:
        return f"/repos/{self.repo}/sessions/{session}{suffix}"

    # -- session lifecycle (§8.2) ---------------------------------------------------------

    def hello(self, agent: dict, capabilities: dict, task: Optional[dict] = None,
              change: Optional[str] = None, resume_session: Optional[str] = None) -> dict:
        body: Dict[str, Any] = {"type": "hello", "protocol": PROTOCOL, "agent": agent,
                                "capabilities": capabilities}
        if task:
            body["task"] = task
        if change:
            body["change"] = change
        if resume_session:
            body["resume_session"] = resume_session
        return self._request("POST", f"/repos/{self.repo}/sessions", body)

    def submit(self, session: str, mode: str, event: dict, inbox_ack: Optional[int] = None,
               idempotency_key: Optional[str] = None) -> dict:
        body: Dict[str, Any] = {"type": "submit", "mode": mode, "event": event}
        if inbox_ack:
            body["inbox_ack"] = inbox_ack
        headers = {"Idempotency-Key": idempotency_key[:128]} if idempotency_key else None
        return self._request("POST", self._session_path(session, "/events"), body, headers)

    def drain(self, session: str, ack: Optional[int] = None) -> dict:
        body: Dict[str, Any] = {"type": "inbox.drain"}
        if ack:
            body["ack"] = ack
        return self._request("POST", self._session_path(session, "/inbox"), body)

    def heartbeat(self, session: str) -> dict:
        return self._request("POST", self._session_path(session, "/heartbeat"), {"type": "heartbeat"})

    def gate(self, session: str, gate: str) -> dict:
        return self._request("POST", self._session_path(session, "/gate"), {"type": "gate", "gate": gate})

    def bye(self, session: str, reason: str = "") -> None:
        body = {"type": "bye", "reason": reason} if reason else {"type": "bye"}
        self._request("DELETE", self._session_path(session), body)
