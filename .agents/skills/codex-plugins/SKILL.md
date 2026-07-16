---
name: codex-plugins
description: Build, configure, package, or troubleshoot Codex plugins, agent skills, lifecycle hooks, subagent roles, or MCP servers. Use when choosing among these Codex customization surfaces or when a task mentions plugin.json, SKILL.md, hooks.json, agents, config.toml, or mcp_servers.
---

# Codex plugin development

Use the smallest customization surface that matches the task:

- **Skill** for a reusable workflow, instructions, references, or scripts.
- **Plugin** to distribute one or more skills with MCP servers, hooks, apps, or assets.
- **Hook** for deterministic lifecycle enforcement around Codex turns or tool calls.
- **Subagent** for a focused role that can work independently from the main thread.
- **MCP server** for live external data or actions exposed as tools.

For a repo-specific workflow, prefer a skill in `.agents/skills/<name>/` over a
plugin unless it needs distribution or bundled integrations. Keep `SKILL.md`
concise and place detailed material in `references/`.

Read exactly the reference relevant to the task before changing files:

- [Plugins](references/plugins.md) — package layout, manifest, local testing, and distribution.
- [Skills](references/skills.md) — discovery, progressive disclosure, structure, and scope.
- [Hooks](references/hooks.md) — lifecycle events, configuration, trust, and safe handlers.
- [Subagents](references/subagents.md) — delegation, roles, configuration, and guardrails.
- [MCP](references/mcp.md) — server transports, configuration, authentication, and tool policy.

When a request crosses surfaces, read each applicable reference and keep their
responsibilities separate. Do not place credentials in manifests, skills,
hooks, or committed configuration. Validate configuration syntax and inspect
the resulting diff before handoff.
