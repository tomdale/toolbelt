# Subagents

Use subagents for independent, bounded work that benefits from parallelism or would otherwise fill the main thread with noisy exploration, test output, logs, or summaries. Each subagent runs in its own context window with its own system prompt, tool access, and permissions, and returns only a summary to the main conversation. Prefer one main agent for requirements and integration; use workers for isolated research, review, test, or implementation tasks.

Do not parallelize overlapping writes without explicit coordination. Many subagents that each return detailed results also consume real context when they report back, so spawn them only when parallel work materially improves speed or quality.

## Delegation prompt

Claude delegates automatically when a task matches a subagent's `description`, so write that field to say when the subagent should run (include "use proactively" to encourage it). You can also request one explicitly: name it in natural language, `@`-mention it to guarantee it runs, or use `/agents` to manage definitions. State the independent task boundaries, whether to wait for all agents, the result format and evidence expected, and whether workers may edit.

```text
Spawn one subagent for each review area: security, test gaps, and maintainability.
Do not edit files. Wait for all results, then summarize findings by area with
file references and severity.
```

Subagents return summaries to the main agent, preserving the main thread for decisions and final synthesis.

## Runtime model

Each subagent starts with a fresh, isolated context: its own system prompt plus environment details, the delegation message Claude writes, and (for custom agents) CLAUDE.md and git status. It does not see the main conversation's history or the files already read. Subagents inherit the parent's tool access and permission context; a definition may set narrower defaults, but the parent's live runtime choices (for example `bypassPermissions` or `acceptEdits`) take precedence and can't be loosened.

As of recent versions, subagents run in the background by default; Claude runs one in the foreground when it needs the result before continuing. Background subagents still surface permission prompts in the main session. Each subagent consumes its own model and tool work, so weigh the cost and latency against doing the work inline.

## Custom agents

Claude Code ships built-in agents including `Explore`, `Plan`, and `general-purpose`. Define a personal agent in `~/.claude/agents/<name>.md` or a project agent in `.claude/agents/<name>.md` (also distributable via plugins). Each is Markdown with YAML frontmatter; the body is the system prompt.

```markdown
---
name: reviewer
description: Review code for correctness, security, and missing tests. Use proactively after changes.
tools: Read, Grep, Glob
model: sonnet
---

Review code like an owner. Report evidence with file references and do not modify files.
```

Only `name` and `description` are required. `description` drives automatic delegation. `tools` is an allowlist — omit it to inherit every tool available to the main conversation. `model` accepts an alias (`sonnet`, `opus`, `haiku`, `fable`), a full model ID, or `inherit`; it defaults to `inherit`. Use narrow roles, clear instructions, and a limited tool surface. Store project agents in version control so the team shares them.

## Precedence

When several definitions share a `name`, the higher-priority location wins: managed (organization) settings, then the `--agents` CLI flag, then project `.claude/agents/`, then user `~/.claude/agents/`, then plugin `agents/` directories. A custom agent named `Explore` or `Plan` overrides the built-in of the same name. Both scopes are scanned recursively, so subfolders organize definitions without changing identity — a subagent is identified only by its `name` field.

## Source

- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Subagents: configure subagents](https://code.claude.com/docs/en/sub-agents#configure-subagents)
