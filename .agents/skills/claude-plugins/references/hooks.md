# Hooks

Hooks run commands at Claude Code lifecycle events. Use them for mechanical
enforcement, validation, logging, or context injection—not for guidance that the
model should merely consider. Commands receive session and tool metadata on
standard input and control behavior through exit codes and/or structured JSON on
standard output.

## Configuration and discovery

Configure hooks in the `hooks` block of a `settings.json` layer: user
`~/.claude/settings.json`, project `.claude/settings.json` (committable),
`.claude/settings.local.json` (gitignored), or managed policy settings
(organization-wide). Plugins ship hooks in `hooks/hooks.json`; they merge with
user and project hooks when the plugin is enabled.

Claude Code combines matching hooks from all active layers—a higher-precedence
layer does not replace lower-layer hooks. The structure nests three levels:
event → matcher group → array of hook handlers.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

A matcher is matched against the tool name. Bare identifiers with `|` or `,`
match exact names (`Edit|Write`); anything else is an unanchored JavaScript
regex (use `^Edit$` to anchor, `mcp__server__.*` for all of an MCP server's
tools). Use `"*"`, `""`, or omit it to match all. Only `type: "command"` is
covered here; `http`, `mcp_tool`, `prompt`, and `agent` handler types also exist.

## Events

- Tool events (support tool-name matchers): `PreToolUse` (before a call, can
  block), `PostToolUse` (after success).
- Session events: `SessionStart` (matchers `startup`, `resume`, `clear`,
  `compact`), `SessionEnd`.
- Turn events (no matcher): `UserPromptSubmit`, `Stop`, `SubagentStop` (matches
  agent type).
- Other: `Notification`, `PreCompact` (matchers `manual`, `auto`).

## Hook I/O

Every hook receives JSON on stdin: `session_id`, `transcript_path`, `cwd`,
`permission_mode`, `hook_event_name`, plus `tool_name` and `tool_input` for tool
events.

Control by exit code:

- **0** — success. stdout is parsed for JSON (below). For `UserPromptSubmit` and
  `SessionStart`, plain stdout is also injected as context Claude sees; for other
  events plain stdout goes to the debug log.
- **2** — blocking error. stdout/JSON ignored; **stderr** is fed back to Claude.
  Blocks the action for `PreToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`,
  and `PreCompact`; for `PostToolUse` it only surfaces stderr (the tool already
  ran).
- **any other code** — non-blocking error; execution continues, stderr goes to
  the debug log.

Or control by structured JSON on stdout (exit 0). Universal fields: `continue`
(`false` stops Claude entirely), `stopReason` (message shown when
`continue: false`), `suppressOutput`, `systemMessage`. A top-level `decision:
"block"` with `reason` blocks for the post/stop events.

Tool and context decisions go under `hookSpecificOutput` (requires
`hookEventName`):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Database writes are not allowed"
  }
}
```

`permissionDecision` is `allow`, `deny`, or `ask`. Use `additionalContext`
(valid for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`) to
inject text into Claude's context window.

## Safety and behavior

- Hooks run arbitrary shell with your credentials and environment. Review any
  hook—especially from plugins or shared settings—before trusting it.
- Claude Code captures a snapshot of hook configuration at startup. Editing hook
  settings mid-session (or an external change) does not take effect until you
  review and approve the change via the `/hooks` menu, preventing silent
  injection of malicious commands.
- Use absolute paths, or `${CLAUDE_PROJECT_DIR}` for the project root and
  `${CLAUDE_PLUGIN_ROOT}` for a plugin's install directory. Both are also
  exported as environment variables to the hook subprocess. Do not assume the
  working directory is the repo root.
- Default command timeout is 600 seconds; set a smaller `timeout` where
  appropriate.
- Managed policy can restrict hooks: `allowManagedHooksOnly` blocks
  user/project/plugin hooks, and `disableAllHooks` turns them off entirely.

## Source

- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Get started with hooks](https://code.claude.com/docs/en/hooks-guide)
