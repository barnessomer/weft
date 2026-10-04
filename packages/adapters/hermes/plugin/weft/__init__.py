"""Hermes plugin entry point for the Weft adapter (see adapter.py for the hook mapping).

Installed by ``packages/adapters/hermes/scripts/install.py`` into
``$HERMES_HOME/plugins/weft/`` of each profile and enabled via ``plugins.enabled``.
Configuration (gateway URL, repo, per-profile agent tokens) lives outside the plugin dir in
``~/.config/weft/hermes-adapter.json`` (mode 600). Without that file, or without an entry for
the running profile, every hook is a no-op.
"""

from __future__ import annotations

from typing import Any, Optional

from .adapter import get_adapter


def _pre_tool_call(**kwargs: Any) -> Optional[dict]:
    adapter = get_adapter()
    return adapter.pre_tool_call(**kwargs) if adapter else None


def _post_tool_call(**kwargs: Any) -> None:
    adapter = get_adapter()
    if adapter:
        adapter.post_tool_call(**kwargs)


def _transform_tool_result(**kwargs: Any) -> Optional[str]:
    adapter = get_adapter()
    return adapter.transform_tool_result(**kwargs) if adapter else None


def _pre_verify(**kwargs: Any) -> Optional[dict]:
    adapter = get_adapter()
    return adapter.pre_verify(**kwargs) if adapter else None


def register(ctx: Any) -> None:
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("post_tool_call", _post_tool_call)
    ctx.register_hook("transform_tool_result", _transform_tool_result)
    ctx.register_hook("pre_verify", _pre_verify)
