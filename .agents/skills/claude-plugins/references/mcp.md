# Model Context Protocol (MCP)

MCP connects Claude Code to external tools and context providers. Use it when a workflow needs live systems, private data, or external actions. Use a skill to describe the repeatable workflow around those tools; use a plugin to distribute skills together with MCP configuration, hooks, or presentation metadata.

MCP servers may expose tools, resources, and prompts. Treat each server as a trust and capability boundary. Prefer narrowly scoped tools and approvals, especially for servers that fetch external content (prompt-injection risk) or mutate external systems.

## Supported transports and features

Claude Code supports:

- stdio servers: local processes launched by a `command`, with `args` and `env`. Ideal for tools that need direct system access.
- HTTP servers (`streamable-http`): remote endpoints, the recommended remote transport. Supports OAuth, bearer tokens, and dynamic headers.
- SSE servers: remote endpoints, but deprecated — prefer HTTP where available.
- Resources: reference with `@server:protocol://resource/path` (e.g. `@github:issue://123`); appear in the `@` autocomplete.
- Prompts: exposed as slash commands in the form `/mcp__<server>__<prompt>`, with space-separated arguments.

Servers can also send `list_changed` notifications to refresh tools, prompts, and resources without reconnecting. A JSON entry with a `url` but no `type` is a configuration error; add `"type": "http"` (or `"sse"` / `"ws"`).

## Configure a server

```bash
# Remote HTTP (recommended for cloud services)
claude mcp add --transport http notion https://mcp.notion.com/mcp

# HTTP with a bearer header (use an env-var reference, not a literal token)
claude mcp add --transport http github https://api.githubcopilot.com/mcp/ \
  --header "Authorization: Bearer $GITHUB_PAT"

# Local stdio: everything after -- is passed to the server untouched
claude mcp add --env AIRTABLE_API_KEY=$AIRTABLE_API_KEY airtable \
  -- npx -y airtable-mcp-server

# Or add from a JSON blob
claude mcp add-json weather '{"type":"http","url":"https://api.weather.com/mcp"}'
```

Manage servers with `claude mcp list`, `claude mcp get <name>`, and `claude mcp remove <name>`. In-session, `/mcp` shows status and tool counts and drives OAuth sign-in; `claude mcp login <name>` / `logout <name>` run the OAuth flow from the shell.

## Scopes

Choose a scope with `-s` / `--scope`:

- `local` (default): current project only, private to you. Stored in `~/.claude.json` under the project path.
- `project`: shared with the team via a committed `.mcp.json` in the project root. Requires per-user approval before first use (prompt-injection safety); reset with `claude mcp reset-project-choices`.
- `user`: available across all your projects, private to you. Stored in `~/.claude.json`.

When the same server name is defined in multiple scopes, the highest-precedence source wins (local > project > user > plugin > claude.ai connectors); entries are not merged.

`.mcp.json` uses a standard shape and supports `${VAR}` and `${VAR:-default}` expansion in `command`, `args`, `env`, `url`, and `headers`:

```json
{
  "mcpServers": {
    "api-server": {
      "type": "http",
      "url": "${API_BASE_URL:-https://api.example.com}/mcp",
      "headers": { "Authorization": "Bearer ${API_KEY}" }
    },
    "local-tool": {
      "command": "npx",
      "args": ["-y", "@example/docs-mcp"],
      "env": { "DOCS_TOKEN": "${DOCS_TOKEN}" }
    }
  }
}
```

## Tool naming and permissioning

MCP tools are callable as `mcp__<server>__<tool>`. Use this full name in [permission rules](https://code.claude.com/docs/en/permissions), a skill's `allowed-tools`, a subagent's `tools` field, or a hook matcher. Authenticate OAuth servers via `/mcp`; static tokens go through `headers` or a `headersHelper` command (env-var references, never literals).

## Plugin-provided MCP

A plugin bundles MCP servers via a `.mcp.json` at the plugin root or an inline `mcpServers` object in `plugin.json`. When the plugin is enabled, its servers start automatically (run `/reload-plugins` after enabling mid-session). Plugin configs substitute `${CLAUDE_PLUGIN_ROOT}` (install dir), `${CLAUDE_PLUGIN_DATA}` (persistent state), and `${CLAUDE_PROJECT_DIR}` (project root):

```json
{
  "mcpServers": {
    "database-tools": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
      "env": { "DB_URL": "${DB_URL}" }
    }
  }
}
```

Plugin-bundled tools are callable as `mcp__plugin_<plugin-name>_<server-name>__<tool-name>` (non-alphanumeric characters become `_`); the server itself registers as `plugin:<plugin-name>:<server-name>`. Set `"alwaysLoad": true` on a server to exempt its tools from on-demand tool search.

## Source

- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)
- [Managed MCP configuration](https://code.claude.com/docs/en/managed-mcp)
- [Plugins reference: MCP servers](https://code.claude.com/docs/en/plugins-reference#mcp-servers)
