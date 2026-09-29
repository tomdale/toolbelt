# Model Context Protocol (MCP)

MCP connects Codex to external tools and context providers. Use it when a workflow needs live systems, private data, or external actions. Use a skill to describe the repeatable workflow around those tools; use a plugin to distribute skills together with MCP configuration, hooks, or presentation metadata.

MCP servers may expose tools, resources, and prompts. Treat each server as a trust and capability boundary. Prefer narrowly scoped tools and approvals, especially for servers that can mutate external systems.

## Supported transports and features

Codex supports:

- STDIO servers: local processes launched by a command, with arguments and environment configuration.
- Streamable HTTP servers: remote endpoints, with bearer-token, OAuth, or supported ChatGPT-session authentication.
- Server instructions: initialization guidance supplied by the server. Keep the first 512 characters self-contained when authoring a server, because that is the most important decision-time guidance.

Codex shares local MCP configuration across the desktop app, CLI, and IDE extension on the same host. Project `.codex/config.toml` MCP configuration requires a trusted project.

## Configure a server

```bash
codex mcp add context7 -- npx -y @upstash/context7-mcp
codex mcp list
codex mcp login server-name
```

```toml
[mcp_servers.docs]
command = "npx"
args = ["-y", "@example/docs-mcp"]
env_vars = ["DOCS_TOKEN"]
startup_timeout_sec = 20
tool_timeout_sec = 45
```

```toml
[mcp_servers.service]
url = "https://example.com/mcp"
bearer_token_env_var = "SERVICE_TOKEN"
default_tools_approval_mode = "prompt"
enabled_tools = ["search", "read"]
```

Useful options include:

- `enabled`: retain config but disable a server.
- `required`: fail startup when an enabled server cannot initialize.
- `enabled_tools` and `disabled_tools`: tool allow/deny lists; the deny list applies after the allow list.
- `default_tools_approval_mode`: `auto`, `prompt`, `writes`, or `approve`.
- `tools.<tool>.approval_mode`: per-tool override.
- `startup_timeout_sec`, `tool_timeout_sec`: server and tool timeouts.
- HTTP credentials: `bearer_token_env_var`, `http_headers`, `env_http_headers`, and `auth`.

For OAuth, use `codex mcp login <name>`. Configure `mcp_oauth_callback_port` or `mcp_oauth_callback_url` only when the provider requires a fixed callback or an externally reachable callback URL.

## Plugin-provided MCP

A plugin may include `.mcp.json` and point to it with `mcpServers` in `.codex-plugin/plugin.json`. Plugin transport setup belongs to the plugin; user config can still control that plugin server's enabled state, tools, and approval policy:

```toml
[plugins."plugin-name@marketplace".mcp_servers.service]
enabled = true
default_tools_approval_mode = "prompt"
enabled_tools = ["read", "search"]
```

If a skill depends on MCP and should arrange installation or wiring automatically, declare the dependency in `agents/openai.yaml`.

## Source

- [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp)
- [MCP configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Plugins: bundled MCP servers](https://learn.chatgpt.com/docs/build-plugins#bundled-mcp-servers-and-lifecycle-hooks)
