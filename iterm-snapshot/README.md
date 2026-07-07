# iterm-snapshot

Snapshot and restore iTerm2 windows, tabs, and panes from JSON.

The restore command recreates iTerm2 structure and shell context. It cannot
resume already-running foreground processes. Command replay is available as an
explicit opt-in because it sends captured command lines back into new panes.

## Usage

```sh
uv run iterm-snapshot ~/iterm2-snapshot.json
uv run iterm-snapshot --lines 500 ~/iterm2-snapshot.json

uv run iterm-restore --dry-run ~/iterm2-snapshot.json
uv run iterm-restore ~/iterm2-snapshot.json
uv run iterm-restore --restart-commands ~/iterm2-snapshot.json
```

## Development

```sh
uv run pytest
```
