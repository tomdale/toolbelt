# agentlog

CLI for inspecting coding agent session history from Codex and Claude Code.

## Usage

```sh
pnpm install
pnpm build
pnpm dev
```

After installing globally or linking the package, run:

```sh
agentlog
agentlog --agent codex,claude --limit 20
agentlog --query "routing bug"
agentlog --json
```

With no options, `agentlog` prints all Codex and Claude Code sessions whose recorded working directory is the current directory or one of its child directories, sorted newest first.

## Options

- `--agent`, `-a`: comma-separated providers to scan. Supported values are `codex` and `claude`.
- `--home`: home directory to inspect. Defaults to the current user's home directory.
- `--cwd`, `--path`: directory tree to match. Defaults to the current directory.
- `--limit`, `-n`: maximum sessions to print. Defaults to all matching sessions.
- `--query`, `-q`: filter by provider, id, title, preview, or path.
- `--json`: print machine-readable JSON instead of a table.

## Session Sources

`agentlog` scans common local history locations:

- Codex: `~/.codex/sessions` and `~/.codex/history`
- Claude Code: `~/.claude/projects`

The readers are intentionally tolerant of shape changes in agent log files. Files that cannot be parsed are skipped.
