# Skills

A skill is a directory containing `SKILL.md`, plus optional scripts and
references. Use it for a repeatable workflow scoped to a repo, user, or system.
Package it as a plugin when it must be distributed or bundled with connectors,
MCP configuration, hooks, or presentation metadata.

## Minimal skill

```text
.agents/skills/my-skill/
└── SKILL.md
```

```md
---
name: my-skill
description: Use for <specific task and trigger terms>; do not use for <boundary>.
---

Instructions for Codex.
```

`name` and `description` are required. Keep the description concise, front-load
trigger terms, and state scope and boundaries. Codex uses it to select skills
implicitly and may shorten descriptions when many skills are installed.

Put detailed material in `references/` and load it only when needed. Put
deterministic or repetitive work in `scripts/`. Keep the main `SKILL.md`
focused on selection, workflow, guardrails, and routing to those files.

## How Codex loads skills

Codex initially receives each available skill's name, description, and path. It
loads the full `SKILL.md` only after explicit invocation or when the task
matches its description.

Invoke explicitly with `$skill-name`; Codex may also select a skill implicitly.
The initial skill list is budgeted, so unnecessarily long descriptions and
large skill catalogs reduce discoverability.

## Discovery scope

Codex scans `.agents/skills` from the current working directory up through the
repository root. It also reads:

- `~/.agents/skills` for personal skills.
- `/etc/codex/skills` for admin skills.
- OpenAI-bundled system skills.

Use the repository root `.agents/skills` for shared repo workflows. Use nested
`.agents/skills` only for a subtree-specific workflow. Codex supports symlinked
skill folders.

Disable a discovered skill without deleting it:

```toml
[[skills.config]]
path = "/path/to/skill/SKILL.md"
enabled = false
```

## Authoring guidance

- Describe when to use the skill, then give the workflow in execution order.
- Keep durable repo conventions in `AGENTS.md`, not in a narrowly scoped skill.
- Use progressive disclosure: main instructions first; references only for
  specialized detail.
- Prefer scripts for steps that should be exact, repeatable, or difficult to
  express reliably in prose.
- Declare an MCP dependency in `agents/openai.yaml` when the workflow requires
  MCP and should be installed and wired automatically.
- Restart Codex if a changed or newly installed skill does not appear.

## Source

- [Build skills](https://learn.chatgpt.com/docs/build-skills)
- [Skills customization reference](https://learn.chatgpt.com/docs/concepts/customization#skills)
