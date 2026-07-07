from __future__ import annotations

import json

import pytest

from iterm_snapshot.common import load_snapshot, summarize_snapshot


def test_load_snapshot_accepts_valid_snapshot(tmp_path):
    path = tmp_path / "snapshot.json"
    path.write_text(
        json.dumps(
            {
                "schema": "toolbelt.iterm2-snapshot.v1",
                "windows": [
                    {
                        "tabs": [
                            {
                                "sessions": [
                                    {"id": "one"},
                                    {"id": "two"},
                                ],
                            },
                        ],
                    },
                    {
                        "tabs": [
                            {"sessions": [{"id": "three"}]},
                            {"sessions": []},
                        ],
                    },
                ],
            },
        ),
        encoding="utf8",
    )

    snapshot = load_snapshot(path)

    assert summarize_snapshot(snapshot) == "2 window(s), 3 tab(s), 3 pane(s)"


def test_load_snapshot_rejects_unknown_schema(tmp_path):
    path = tmp_path / "snapshot.json"
    path.write_text(json.dumps({"schema": "unknown", "windows": []}), encoding="utf8")

    with pytest.raises(SystemExit) as error:
        load_snapshot(path)

    assert error.value.code == 1
