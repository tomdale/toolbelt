# Plugins

Use a plugin when a workflow should be installed or shared beyond one repo, or
when it needs to bundle skills with commands, subagents, hooks, MCP servers, or
marketplace metadata. For a personal or single-project workflow, prefer a
standalone `.claude/` skill first, then convert to a plugin when you are ready
to share.

## Required structure

Components live at the plugin root; only the manifest sits in `.claude-plugin/`:

```text
my-plugin/
├── .claude-plugin/
│   └── plugin.json   # manifest (optional)
├── skills/           # <name>/SKILL.md dirs (auto-discovered)
├── commands/         # flat .md skills; prefer skills/ for new plugins
├── agents/           # subagent .md files
├── hooks/hooks.json  # hook config
└── .mcp.json         # MCP server config
```

Never put `commands/`, `agents/`, `skills/`, or `hooks/` inside
`.claude-plugin/`. The plugin root is the directory holding
`.claude-plugin/plugin.json`, never `~/.claude/`.

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Reusable workflow.",
  "author": { "name": "Your Name" }
}
```

The manifest is optional: with none, Claude Code auto-discovers components in the
default locations above and derives the name from the directory. `name` is the
only required field when a manifest is present — a stable kebab-case identifier
used to namespace every component (skills invoke as `/my-plugin:hello`, agents
appear as `my-plugin:reviewer`). Other metadata: `displayName`, `homepage`,
`repository`, `license`, `keywords`, `defaultEnabled`.

## Component paths and variables

Default directories auto-load by convention; manifest path fields override them.
Rules differ by field:

- `skills` **adds to** the default `skills/` scan (both load).
- `commands`, `agents`, `outputStyles` **replace** their default directory — to
  keep the default and add more, list it explicitly:
  `"commands": ["./commands/", "./extras/"]`.
- `hooks`, `mcpServers`, `lspServers` accept a path, array, or inline object and
  have their own merge rules.

All manifest paths are relative to the plugin root and must start with `./`. In
scripts, hook commands, and MCP/LSP config, reference bundled files with
`${CLAUDE_PLUGIN_ROOT}` (absolute path to the install dir) rather than
hardcoding paths; `${CLAUDE_PLUGIN_DATA}` is a persistent dir surviving updates,
and `${CLAUDE_PROJECT_DIR}` is the project root.

```json
{
  "mcpServers": {
    "db": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"]
    }
  }
}
```

## Create and test

Load a plugin directly during development with no install step:

```bash
claude --plugin-dir ./my-plugin      # repeat the flag for multiple plugins
claude plugin validate ./my-plugin --strict   # catch schema issues
```

Run `/reload-plugins` after edits to pick up changes without restarting; invoke
skills as `/my-plugin:skill-name` and check agents under `/context`. A local
`--plugin-dir` copy overrides an installed plugin of the same name for that
session.

## Distribute via a marketplace

Publish `.claude-plugin/marketplace.json` at a repo root listing your plugins:

```json
{
  "name": "company-tools",
  "owner": { "name": "DevTools Team" },
  "plugins": [
    { "name": "code-formatter", "source": "./plugins/formatter" },
    { "name": "deploy-tools",
      "source": { "source": "github", "repo": "company/deploy-plugin" } }
  ]
}
```

Each entry needs `name` and `source`. A `source` is a relative `./` path (same
repo, resolved from the marketplace root) or an object of type `github`
(`repo`), `url` (git `url`), `git-subdir` (`url` + `path`), or `npm`
(`package`). Push to any git host, then users run:

```bash
/plugin marketplace add owner/repo     # or ./local-path, or a git URL
/plugin install code-formatter@company-tools
/plugin                                # browse/enable interactively
```

Set an explicit `version` to pin releases; omit it and the git commit SHA is
used, so every commit counts as an update. Keep a marketplace in a private repo
to scope plugins to your team.

## Choosing a component

- Workflow instructions, references, scripts → a skill.
- Live external data or actions → MCP server (`.mcp.json`).
- Lifecycle enforcement or observability → hooks (`hooks/hooks.json`).
- A reusable package combining these, shared across projects → plugin.

Bundled MCP servers and hooks do not run merely because a plugin is installed:
the user enables the plugin and MCP/hook trust review still applies.

## Source

- [Create plugins](https://code.claude.com/docs/en/plugins)
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
