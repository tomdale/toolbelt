# Skills

A skill is a directory containing `SKILL.md`, plus optional scripts and
references. Use it for a repeatable workflow scoped to a repo, user, or system.
Package it as a plugin when it must be distributed or bundled with subagents,
MCP configuration, hooks, or output styles.

## Minimal skill

```text
.claude/skills/my-skill/
└── SKILL.md
```

```md
---
name: my-skill
description: Use for <specific task and trigger terms>; do not use for <boundary>.
---

Instructions for Claude.
```

Only `description` is recommended. `name` defaults to the directory name and sets
the display label, not the command you type. Front-load trigger terms and state
scope and boundaries: Claude matches requests against the description to select
skills implicitly. The combined `description` (plus optional `when_to_use`) is
capped at 1,536 characters in the skill listing, so put the key use case first.

Constraints: `name` is at most 64 characters, lowercase letters, numbers, and
hyphens; it cannot contain XML tags or the reserved words "anthropic"/"claude".
`description` must be non-empty, at most 1,024 characters, no XML tags.

Put detailed material in `references/` (or any bundled `.md`) and load it only
when needed. Put deterministic or repetitive work in `scripts/`. Keep the main
`SKILL.md` focused on selection, workflow, guardrails, and routing to those
files; keep it under 500 lines.

## How Claude Code loads skills

Progressive disclosure runs in levels. At startup Claude sees only each skill's
name and description (~100 tokens each). When a request matches, or you invoke
the skill, the full `SKILL.md` body loads. Bundled reference files and scripts
load only when the body points Claude to them — reference files enter context
when read, scripts run via bash and only their output enters context.

Invoke a skill three ways: type `/skill-name`, let Claude select it implicitly
from the description, or call the Skill tool. Invoked content stays in context
for the rest of the session, so every line is a recurring cost.

## Frontmatter fields

All fields are optional beyond `description`.

- `name`, `description`, `when_to_use` — discovery and selection.
- `allowed-tools` — pre-approve tools while the skill is active (space/comma
  list or YAML list). Does not restrict the pool; `disallowed-tools` removes
  tools.
- `disable-model-invocation: true` — only you can invoke it (`/name`); removes
  the description from Claude's context. Use for side-effecting workflows.
- `user-invocable: false` — only Claude can invoke it; hides from the `/` menu.
  Use for background knowledge.
- `context: fork` (with optional `agent`) — run the skill as a subagent; the
  body becomes the prompt.
- `argument-hint`, `arguments`, `model`, `effort`, `paths`, `hooks` — see docs.

Arguments reach the body via `$ARGUMENTS`, `$ARGUMENTS[N]`/`$N`, or named
`$name`. `` !`command` `` and ` ```! ` fenced blocks inject shell output before
Claude sees the content.

## Discovery scope

| Location   | Path                                     | Applies to              |
| ---------- | ---------------------------------------- | ----------------------- |
| Enterprise | Managed settings                         | All users in the org    |
| Personal   | `~/.claude/skills/<name>/SKILL.md`       | All your projects       |
| Project    | `.claude/skills/<name>/SKILL.md`         | This project only       |
| Plugin     | `<plugin>/skills/<name>/SKILL.md`        | Where plugin is enabled |

Same-name precedence: enterprise overrides personal overrides project, and any
of these overrides a bundled skill. Plugin skills use a `plugin:skill`
namespace and cannot conflict. Project skills also load from parent `.claude/skills/`
up to the repo root and from nested package directories on demand.

This repo also uses portable `.agents/skills/`, shared across agents. Prefer the
repo-root location for shared workflows; use a nested directory only for a
subtree-specific workflow.

## Authoring guidance

- Describe when to use the skill, then give the workflow in execution order.
- Keep durable repo conventions in `CLAUDE.md`, not in a narrowly scoped skill.
- Use progressive disclosure: main instructions first; references only for
  specialized detail.
- Prefer scripts for steps that should be exact, repeatable, or difficult to
  express reliably in prose; reference the path with `${CLAUDE_SKILL_DIR}`.
- Live change detection picks up `SKILL.md` edits within a session; a brand-new
  top-level skills directory needs a restart.

## Source

- [Use Skills in Claude Code](https://code.claude.com/docs/en/skills)
- [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
