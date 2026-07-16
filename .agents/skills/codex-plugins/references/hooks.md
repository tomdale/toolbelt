# Hooks

Hooks run commands at Codex lifecycle events. Use them for mechanical
enforcement, validation, logging, or context injection—not for guidance that an
agent should merely consider. Commands can receive session and tool metadata on
standard input and may return structured control or context output.

## Configuration and discovery

Configure hooks in either `hooks.json` next to an active configuration layer or
an inline `[hooks]` table in `config.toml`.

Codex combines matching hooks from all active layers. A higher-precedence layer
does not replace lower-layer hooks. In one layer, choose either `hooks.json` or
inline TOML; using both is merged with a warning.

Project hooks load only if the project `.codex/` layer is trusted. Plugin hooks
load from `hooks/hooks.json` by default, or from the manifest's `hooks` entry.
Manifest paths must be `./`-prefixed, resolve relative to the plugin root, and
stay inside it.

## Safety and behavior

- Non-managed command hooks must be reviewed and trusted before execution.
  Trust is tied to the hook definition hash; edits require review again.
- Use `/hooks` to inspect, trust, or disable non-managed hooks.
- Matching command hooks run concurrently; do not rely on one hook blocking
  another from beginning.
- Commands execute with the session working directory. For repo hooks, resolve
  paths from the git root rather than assuming Codex started at the root.
- Only `type: "command"` executes today. `prompt` and `agent` handlers are
  parsed but skipped.
- The default command timeout is 600 seconds; set a smaller explicit `timeout`
  where appropriate.

## Basic shape

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/check-command-policy.py",
            "timeout": 30,
            "statusMessage": "Checking command"
          }
        ]
      }
    ]
  }
}
```

A matcher is a regular expression. Use `"*"`, `""`, or omit it to match all
occurrences where the event supports matching. Tool events can match `Bash`,
`apply_patch` (also `Edit` and `Write`), or MCP tool names such as
`mcp__server__tool`.

## Events

Turn-scoped events: `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, and `Stop`.

Thread or subagent-start events: `SessionStart` and `SubagentStart`.

Useful matcher targets:

- Tool events: tool name.
- `PreCompact` and `PostCompact`: `manual` or `auto`.
- `SessionStart`: `startup`, `resume`, `clear`, or `compact`.
- `SubagentStart` and `SubagentStop`: agent type.
- `UserPromptSubmit` and `Stop`: matcher is ignored.

Turn hooks can provide messages or stop behavior where supported. `SessionStart`
and `SubagentStart` can add developer context. A `SubagentStart` hook cannot
prevent a subagent from starting.

Disable hooks globally:

```toml
[features]
hooks = false
```

## Source

- [Hooks](https://learn.chatgpt.com/docs/hooks)
- [Plugin-bundled hooks](https://learn.chatgpt.com/docs/build-plugins#bundled-mcp-servers-and-lifecycle-hooks)
- [Advanced configuration: hooks](https://learn.chatgpt.com/docs/config-file/config-advanced#hooks)
