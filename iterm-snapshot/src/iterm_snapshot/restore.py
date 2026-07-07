from __future__ import annotations

import argparse
import asyncio
import shlex
from pathlib import Path
from typing import Any

from .common import import_iterm2, load_snapshot, maybe_call, summarize_snapshot


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Restore iTerm2 windows, tabs, and panes from a snapshot JSON file.",
    )
    parser.add_argument("snapshot", help="Snapshot JSON file created by iterm-snapshot.")
    parser.add_argument(
        "--restart-commands",
        action="store_true",
        help="After restoring each pane's cwd, rerun captured session.currentCommandLine values.",
    )
    parser.add_argument(
        "--skip-cd",
        action="store_true",
        help="Do not send cd commands to restored panes.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate the snapshot and print what would be restored without touching iTerm2.",
    )
    parser.add_argument(
        "--pane-delay",
        type=float,
        default=0.05,
        help="Seconds to wait after sending setup text to each pane. Defaults to 0.05.",
    )
    return parser.parse_args()


def session_variables(session_snapshot: dict[str, Any]) -> dict[str, Any]:
    variables = session_snapshot.get("variables", {})
    return variables if isinstance(variables, dict) else {}


def session_profile_name(session_snapshot: dict[str, Any]) -> str | None:
    profile = session_snapshot.get("profile")
    if not isinstance(profile, dict):
        return None

    name = profile.get("name")
    return name if isinstance(name, str) and name else None


def session_cwd(session_snapshot: dict[str, Any]) -> str | None:
    value = session_variables(session_snapshot).get("session.path")
    return value if isinstance(value, str) and value else None


def session_name(session_snapshot: dict[str, Any]) -> str | None:
    variables = session_variables(session_snapshot)
    value = variables.get("session.name") or variables.get("session.autoName")
    return value if isinstance(value, str) and value else None


def session_command_line(session_snapshot: dict[str, Any]) -> str | None:
    value = session_variables(session_snapshot).get("session.currentCommandLine")
    return value if isinstance(value, str) and value.strip() else None


async def create_window(iterm2: Any, connection: Any, profile_name: str | None) -> Any:
    if profile_name:
        try:
            return await iterm2.Window.async_create(connection, profile=profile_name)
        except Exception:
            pass

    return await iterm2.Window.async_create(connection)


async def create_tab(window: Any, profile_name: str | None) -> Any:
    if profile_name:
        try:
            return await window.async_create_tab(profile=profile_name)
        except Exception:
            pass

    return await window.async_create_tab()


async def split_session(session: Any, profile_name: str | None, split_index: int) -> Any:
    vertical = split_index % 2 == 1

    if profile_name:
        try:
            return await session.async_split_pane(vertical=vertical, profile=profile_name)
        except Exception:
            pass

    return await session.async_split_pane(vertical=vertical)


async def setup_session(
    session: Any,
    session_snapshot: dict[str, Any],
    *,
    restart_commands: bool,
    skip_cd: bool,
    pane_delay: float,
) -> None:
    name = session_name(session_snapshot)
    if name:
        await maybe_call(session, "async_set_name", name)

    setup_text = ""
    cwd = session_cwd(session_snapshot)
    if cwd and not skip_cd:
        setup_text += f"cd -- {shlex.quote(cwd)}\n"

    command = session_command_line(session_snapshot)
    if command and restart_commands:
        setup_text += f"{command}\n"

    if setup_text:
        await session.async_send_text(setup_text)
        if pane_delay > 0:
            await asyncio.sleep(pane_delay)


async def restore_tab(
    tab: Any,
    tab_snapshot: dict[str, Any],
    *,
    restart_commands: bool,
    skip_cd: bool,
    pane_delay: float,
) -> int:
    session_snapshots = list(tab_snapshot.get("sessions", []) or [])
    if not session_snapshots:
        return 0

    current_session = getattr(tab, "current_session", None)
    if current_session is None:
        return 0

    sessions = [current_session]
    for index, session_snapshot in enumerate(session_snapshots[1:], start=1):
        new_session = await split_session(
            sessions[-1],
            session_profile_name(session_snapshot),
            index,
        )
        sessions.append(new_session)

    for session, session_snapshot in zip(sessions, session_snapshots, strict=False):
        await setup_session(
            session,
            session_snapshot,
            restart_commands=restart_commands,
            skip_cd=skip_cd,
            pane_delay=pane_delay,
        )

    current_snapshot = next(
        (item for item in session_snapshots if item.get("is_current")),
        session_snapshots[0],
    )
    current_index = session_snapshots.index(current_snapshot)
    await maybe_call(sessions[current_index], "async_activate")

    return len(sessions)


async def restore_window(
    iterm2: Any,
    connection: Any,
    window_snapshot: dict[str, Any],
    *,
    restart_commands: bool,
    skip_cd: bool,
    pane_delay: float,
) -> tuple[Any, int, int]:
    tabs_snapshot = list(window_snapshot.get("tabs", []) or [])
    first_session = None
    if tabs_snapshot and tabs_snapshot[0].get("sessions"):
        first_session = tabs_snapshot[0]["sessions"][0]

    window = await create_window(
        iterm2,
        connection,
        session_profile_name(first_session or {}),
    )

    tabs = []
    current_tab = getattr(window, "current_tab", None)
    if current_tab is not None:
        tabs.append(current_tab)

    for tab_snapshot in tabs_snapshot[len(tabs) :]:
        first_tab_session = None
        if tab_snapshot.get("sessions"):
            first_tab_session = tab_snapshot["sessions"][0]
        tabs.append(await create_tab(window, session_profile_name(first_tab_session or {})))

    pane_count = 0
    for tab, tab_snapshot in zip(tabs, tabs_snapshot, strict=False):
        pane_count += await restore_tab(
            tab,
            tab_snapshot,
            restart_commands=restart_commands,
            skip_cd=skip_cd,
            pane_delay=pane_delay,
        )

    current_snapshot = next((item for item in tabs_snapshot if item.get("is_current")), None)
    if current_snapshot is not None:
        current_index = tabs_snapshot.index(current_snapshot)
        if current_index < len(tabs):
            await maybe_call(tabs[current_index], "async_select")

    return window, len(tabs), pane_count


async def restore_snapshot(
    iterm2: Any,
    connection: Any,
    snapshot: dict[str, Any],
    *,
    restart_commands: bool,
    skip_cd: bool,
    pane_delay: float,
) -> dict[str, int]:
    restored = {"windows": 0, "tabs": 0, "panes": 0}

    for window_snapshot in snapshot.get("windows", []):
        window, tabs, panes = await restore_window(
            iterm2,
            connection,
            window_snapshot,
            restart_commands=restart_commands,
            skip_cd=skip_cd,
            pane_delay=pane_delay,
        )
        await maybe_call(window, "async_activate")
        restored["windows"] += 1
        restored["tabs"] += tabs
        restored["panes"] += panes

    return restored


def main() -> None:
    args = parse_args()
    snapshot_path = Path(args.snapshot).expanduser()
    snapshot = load_snapshot(snapshot_path)

    if args.dry_run:
        print(f"Would restore {summarize_snapshot(snapshot)} from {snapshot_path}")
        if args.restart_commands:
            print("Command replay is enabled.")
        return

    iterm2 = import_iterm2()

    async def run(connection: Any) -> None:
        restored = await restore_snapshot(
            iterm2,
            connection,
            snapshot,
            restart_commands=args.restart_commands,
            skip_cd=args.skip_cd,
            pane_delay=max(0, args.pane_delay),
        )
        print(
            "Restored "
            f"{restored['windows']} window(s), "
            f"{restored['tabs']} tab(s), "
            f"{restored['panes']} pane(s)."
        )

    iterm2.run_until_complete(run)
