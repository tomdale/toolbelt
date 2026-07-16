---
name: claude-plugins
description: Build, configure, package, or troubleshoot Claude Code plugins, agent skills, lifecycle hooks, subagents, or MCP servers. Use when choosing among these Claude Code customization surfaces or when a task mentions plugin.json, marketplace.json, SKILL.md, settings.json hooks, agents, or .mcp.json.
---

# Claude Code plugin development

Use the smallest customization surface that matches the task:

- **Skill** for a reusable workflow, instructions, references, or scripts.
- **Plugin** to distribute one or more skills with MCP servers, hooks, commands, subagents, or assets.
- **Hook** for deterministic lifecycle enforcement around turns or tool calls.
- **Subagent** for a focused role that works in its own context window.
- **MCP server** for live external data or actions exposed as tools.

For a repo-specific workflow, prefer a skill in `.claude/skills/<name>/` (or this
repo's portable `.agents/skills/<name>/`) over a plugin unless it needs
distribution or bundled integrations. Keep `SKILL.md` concise and place detailed
material in `references/`.

Read exactly the reference relevant to the task before changing files:

- [Plugins](references/plugins.md) — manifest, component paths, local testing, and marketplace distribution.
- [Skills](references/skills.md) — frontmatter, discovery scope, progressive disclosure, and invocation.
- [Hooks](references/hooks.md) — lifecycle events, settings.json config, I/O contract, and safety.
- [Subagents](references/subagents.md) — delegation, definition files, runtime model, and precedence.
- [MCP](references/mcp.md) — transports, scopes, configuration, authentication, and tool policy.

When a request crosses surfaces, read each applicable reference and keep their
responsibilities separate. Do not place credentials in manifests, skills, hooks,
or committed configuration; reference secrets through environment variables.
Validate configuration syntax (`claude plugin validate`, JSON linting) and
inspect the resulting diff before handoff.
