from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .common import SUPPORTED_SCHEMA, import_iterm2, jsonable, maybe_call


DEFAULT_VARIABLES = (
    "session.name",
    "session.path",
    "session.tty",
    "session.jobName",
    "session.username",
    "session.hostname",
    "session.pid",
    "session.connectionState",
    "session.currentCommandLine",
    "session.autoName",
    "session.badge",
    "tab.title",
    "window.title",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Snapshot all open iTerm2 windows, tabs, and panes to JSON.",
    )
    parser.add_argument(
        "output",
        nargs="?",
        default=f"iterm2-snapshot-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json",
        help="Output JSON file path. Defaults to ./iterm2-snapshot-YYYYmmdd-HHMMSS.json.",
    )
    parser.add_argument(
        "--lines",
        type=int,
        default=200,
        help="Maximum visible screen lines to include per pane. Use 0 to omit screen text.",
    )
    parser.add_argument(
        "--pretty",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Pretty-print JSON output. Enabled by default.",
    )
    return parser.parse_args()


async def session_variables(session: Any) -> dict[str, Any]:
    variables: dict[str, Any] = {}

    for name in DEFAULT_VARIABLES:
        value = await maybe_call(session, "async_get_variable", name)
        if value is not None:
            variables[name] = jsonable(value)

    return variables


async def screen_lines(session: Any, limit: int) -> list[str]:
    if limit <= 0:
        return []

    contents = await maybe_call(session, "async_get_screen_contents")
    if contents is None:
        return []

    line_count = getattr(contents, "number_of_lines", 0)
    first_line = max(0, line_count - limit)
    lines: list[str] = []

    for index in range(first_line, line_count):
        line = contents.line(index)
        lines.append(getattr(line, "string", str(line)).rstrip())

    return lines


async def snapshot_session(session: Any, *, current: Any, lines: int) -> dict[str, Any]:
    profile = await maybe_call(session, "async_get_profile")
    grid_size = await maybe_call(session, "async_get_grid_size")

    return {
        "id": getattr(session, "session_id", None),
        "is_current": session is current,
        "frame": jsonable(getattr(session, "frame", None)),
        "grid_size": jsonable(grid_size),
        "profile": {
            "name": jsonable(getattr(profile, "name", None)),
            "guid": jsonable(getattr(profile, "guid", None)),
        }
        if profile is not None
        else None,
        "variables": await session_variables(session),
        "screen": {
            "captured_line_count": lines,
            "visible_lines": await screen_lines(session, lines),
        },
    }


async def snapshot_tab(tab: Any, *, current_window: Any, lines: int) -> dict[str, Any]:
    sessions = list(getattr(tab, "sessions", []) or [])
    current_session = getattr(tab, "current_session", None)

    return {
        "id": getattr(tab, "tab_id", None),
        "is_current": tab is getattr(current_window, "current_tab", None),
        "tmux_window_id": getattr(tab, "tmux_window_id", None),
        "sessions": [
            await snapshot_session(session, current=current_session, lines=lines)
            for session in sessions
        ],
    }


async def snapshot_window(window: Any, *, app: Any, index: int, lines: int) -> dict[str, Any]:
    tabs = list(getattr(window, "tabs", []) or [])

    return {
        "id": getattr(window, "window_id", None),
        "index": index,
        "is_current": window is getattr(app, "current_terminal_window", None),
        "frame": jsonable(getattr(window, "frame", None)),
        "tabs": [
            await snapshot_tab(tab, current_window=window, lines=lines)
            for tab in tabs
        ],
    }


async def build_snapshot(iterm2: Any, connection: Any, *, lines: int) -> dict[str, Any]:
    app = await iterm2.async_get_app(connection)
    windows = list(getattr(app, "terminal_windows", []) or [])

    return {
        "schema": SUPPORTED_SCHEMA,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "window_count": len(windows),
        "windows": [
            await snapshot_window(window, app=app, index=index, lines=lines)
            for index, window in enumerate(windows)
        ],
    }


def main() -> None:
    args = parse_args()
    output = Path(args.output).expanduser()
    iterm2 = import_iterm2()

    async def run(connection: Any) -> None:
        snapshot = await build_snapshot(iterm2, connection, lines=max(0, args.lines))
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(
            json.dumps(snapshot, indent=2 if args.pretty else None, sort_keys=True)
            + "\n",
            encoding="utf8",
        )
        print(f"Wrote {snapshot['window_count']} iTerm2 window(s) to {output}")

    iterm2.run_until_complete(run)
