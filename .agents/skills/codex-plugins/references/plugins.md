# Plugins

Use a plugin when a workflow should be installed or shared beyond one repo, or
when it needs to bundle skills with MCP servers, apps/connectors, hooks, assets,
or marketplace metadata. For a repo-local workflow, prefer a skill first.

## Required structure

Every plugin requires this manifest:

```text
my-plugin/
├── .codex-plugin/
│   └── plugin.json
├── skills/          # optional
├── hooks/           # optional
├── .mcp.json        # optional
├── .app.json        # optional
└── assets/          # optional
```

Only `plugin.json` belongs inside `.codex-plugin/`; the other components remain
at the plugin root.

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Reusable workflow.",
  "skills": "./skills/"
}
```

Use a stable kebab-case `name`; Codex uses it as the plugin identifier and
component namespace. Typical optional manifest entries are `mcpServers`,
`apps`, `hooks`, and `interface` metadata.

## Create and test

Use `$plugin-creator` when possible. It scaffolds the required manifest and can
create a personal marketplace entry.

For manual repo-local testing, place plugins under `plugins/` and create
`.agents/plugins/marketplace.json`:

```json
{
  "name": "local-repo",
  "plugins": [
    {
      "name": "my-plugin",
      "source": { "source": "local", "path": "./plugins/my-plugin" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

`source.path` is relative to the marketplace root, must begin with `./`, and
must remain inside that root. Restart the desktop app after marketplace or
plugin changes. Local installations are cached, so update the source plugin and
restart to pick up changes.

Manage marketplace sources from the CLI:

```bash
codex plugin marketplace add ./local-marketplace-root
codex plugin marketplace list
codex plugin marketplace upgrade
codex plugin marketplace remove marketplace-name
```

## Choosing a component

- Workflow instructions, references, scripts → a skill.
- Live external data or actions → MCP.
- Lifecycle enforcement or observability → hooks.
- A reusable package that combines one or more of these → plugin.

Bundled MCP transport is defined by the plugin; user configuration can still
enable or disable its server and set tool-approval policy. Bundled hooks use
the normal trust-review process and do not execute merely because the plugin is
installed.

## Source

- [Build plugins](https://learn.chatgpt.com/docs/build-plugins)
- [Plugin structure](https://learn.chatgpt.com/docs/build-plugins#plugin-structure)
- [Marketplace metadata](https://learn.chatgpt.com/docs/build-plugins#marketplace-metadata)
