---
name: pi-plugins
description: Build, configure, package, or troubleshoot Pi extensions, skills, hooks, subagents, MCP integrations, prompt templates, themes, and Pi packages. Use when a task mentions Pi plugins, extensions, SKILL.md, lifecycle events, custom tools, agent definitions, MCP, or package distribution.
---

# Pi plugin development

Pi does not have a single `plugin.json` surface. Treat a “plugin” as the
smallest Pi customization surface that solves the problem, or as a Pi Package
when several resources must be distributed together:

- **Skill** — reusable instructions, workflows, scripts, and references.
- **Extension** — TypeScript code for tools, commands, UI, lifecycle hooks,
  providers, persistence, and integrations.
- **Hook** — an extension listener on a Pi lifecycle event; there is no separate
  hooks manifest.
- **Subagent** — an extension/package workflow that starts another `pi`
  process with an agent definition; there is no built-in subagent registry.
- **MCP** — not built into Pi. Wrap an MCP client/server in an extension, or
  expose the needed operation as a normal Pi custom tool.
- **Pi Package** — npm, git, or local distribution containing extensions,
  skills, prompts, and/or themes.

Choose the smallest surface, keep `SKILL.md` concise, and use progressive
disclosure: put API details and long examples in the relevant files under
`references/`. Read the reference that matches the requested surface before
editing code.

## References

- [Extensions](references/extensions.md) — TypeScript modules, tools, commands,
  UI, events, state, testing, and error handling.
- [Packages](references/packages.md) — package layout, `package.json` `pi`
  manifest, install/update commands, dependencies, filtering, and scope.
- [Skills](references/skills.md) — discovery locations, frontmatter, structure,
  validation, commands, and progressive disclosure.
- [Hooks](references/hooks.md) — lifecycle event selection, blocking/rewriting
  behavior, cleanup, and safe hook design.
- [Subagents](references/subagents.md) — agent markdown definitions and the
  extension pattern for isolated `pi` subprocesses.
- [MCP](references/mcp.md) — Pi’s non-native MCP status and patterns for
  adapting MCP clients/servers into extensions or tools.
- [Prompts, themes, and settings](references/resources.md) — prompt templates,
  themes, context, project trust, and settings.

## Safe workflow

1. Identify whether the request is a skill, extension, hook, subagent, MCP
   adapter, or package (it may involve more than one).
2. Read the applicable local reference(s) completely enough to follow their
   API and security guidance.
3. Prefer a project-local `.pi/` resource for repository behavior and a
   package for reusable/distributed behavior.
4. Test a local extension with `pi -e ./path/to/extension.ts`; use `/reload`
   for auto-discovered extensions.
5. Review third-party code before installing it. Pi extensions and packages
   run with the permissions of the Pi process; project trust controls loading,
   not runtime sandboxing.
6. Validate JSON/package metadata, run the smallest useful test, and inspect
   `git diff --check` and the final diff.

## Source documentation

These references summarize Pi 0.79.x documentation. For API details that are
not reproduced here, consult the installed Pi documentation or the matching
version at <https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent/docs>.
Do not assume Claude Code or Codex plugin manifests, hook schemas, MCP config,
or built-in subagent behavior apply to Pi.
