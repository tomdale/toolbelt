from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any


SUPPORTED_SCHEMA = "toolbelt.iterm2-snapshot.v1"


async def maybe_call(obj: Any, method_name: str, *args: Any, **kwargs: Any) -> Any:
    method = getattr(obj, method_name, None)
    if method is None:
        return None

    try:
        value = method(*args, **kwargs)
        if asyncio.iscoroutine(value):
            return await value
        return value
    except Exception:
        return None


def jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value

    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]

    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}

    return str(value)


def load_snapshot(path: Path) -> dict[str, Any]:
    try:
        snapshot = json.loads(path.read_text(encoding="utf8"))
    except FileNotFoundError:
        print(f"Snapshot file not found: {path}", file=sys.stderr)
        raise SystemExit(1)
    except json.JSONDecodeError as error:
        print(f"Invalid JSON in {path}: {error}", file=sys.stderr)
        raise SystemExit(1)

    schema = snapshot.get("schema")
    if schema != SUPPORTED_SCHEMA:
        print(
            f"Unsupported snapshot schema {schema!r}; expected {SUPPORTED_SCHEMA!r}.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    if not isinstance(snapshot.get("windows"), list):
        print("Snapshot is missing a windows array.", file=sys.stderr)
        raise SystemExit(1)

    return snapshot


def iter_snapshot_sessions(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    sessions: list[dict[str, Any]] = []

    for window in snapshot.get("windows", []):
        for tab in window.get("tabs", []):
            sessions.extend(tab.get("sessions", []))

    return sessions


def summarize_snapshot(snapshot: dict[str, Any]) -> str:
    windows = snapshot.get("windows", [])
    tab_count = sum(len(window.get("tabs", [])) for window in windows)
    pane_count = len(iter_snapshot_sessions(snapshot))
    return f"{len(windows)} window(s), {tab_count} tab(s), {pane_count} pane(s)"


def import_iterm2() -> Any:
    try:
        import iterm2
    except ImportError:
        print(
            "Unable to import the iTerm2 Python API. Run this command with "
            "`uv run` from the iterm-snapshot project, or install the `iterm2` "
            "package in the active Python environment.",
            file=sys.stderr,
        )
        raise SystemExit(2)

    return iterm2
