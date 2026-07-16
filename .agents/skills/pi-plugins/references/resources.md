# Prompts, themes, settings, and trust

These are native Pi resources; an extension may contribute or transform them, but a package only bundles them.

## Prompt templates

Locations: `~/.pi/agent/prompts/*.md`, `.pi/prompts/*.md` (trusted project), package `prompts/`, settings `prompts`, or repeatable `--prompt-template <path>`. Disable with `--no-prompt-templates`. Discovery in `prompts/` is non-recursive. Filename becomes the command (`review.md` -> `/review`).

```markdown
---
description: Review staged changes
argument-hint: "<instructions>"
---
Review the staged changes. Focus on: $@
```

Arguments support `$1`, `$2`, `$@`/`$ARGUMENTS`, `${1:-default}`, `${@:N}`, and `${@:N:L}`. `description` is optional (first non-empty line fallback); `argument-hint` affects autocomplete.

## Themes

Locations: built-in `dark`/`light`, `~/.pi/agent/themes/*.json`, `.pi/themes/*.json` (trusted), package `themes/`, settings `themes`, or `--theme <path>`. Disable with `--no-themes`; select with `/settings` or `{ "theme": "my-theme" }`. The active custom theme hot-reloads.

A theme JSON has a unique slash-free `name`, optional reusable `vars`, and `colors` containing all 51 required tokens (with optional `thinkingMax` fallback): UI/core, message/tool backgrounds, markdown, diffs, syntax, thinking levels, and `bashMode`. Values are 6-digit hex, xterm index 0–255, a `vars` name, or `""` for terminal default. Include the official theme `$schema` for editor validation; see `docs/themes.md` for the full token list and starter object.

## Settings

Global: `~/.pi/agent/settings.json`; project: `.pi/settings.json` (nested objects merge and project overrides global). `/settings` edits common options. Resource arrays resolve relative to the settings file (`~/.pi/agent` or `.pi`) and accept paths/globs/exclusions:

```json
{
  "packages": ["npm:my-pkg"],
  "extensions": ["./extensions"],
  "skills": ["./skills"],
  "prompts": ["./prompts"],
  "themes": ["./themes"],
  "enableSkillCommands": true
}
```

Other useful settings include `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `theme`, `compaction`, `retry`, `sessionDir`, `npmCommand`, `shellPath`, and `enabledModels`. Use the installed `docs/settings.md` for the complete version-specific schema.

## Project trust

Interactive startup asks before loading project `.pi` settings/resources, project `.agents/skills`, installing missing project packages, or executing project extensions. Decisions are stored in `~/.pi/agent/trust.json`; `/trust` saves a decision (restart to reload). Non-interactive `-p`, JSON, and RPC modes do not prompt: absent a saved decision, global `defaultProjectTrust` (`ask` default, `always`, or `never`) applies; `--approve`/`--no-approve` overrides one run. Trust controls loading, not sandboxing: loaded extensions and skill-invoked commands have the Pi process's permissions. Review repository-controlled resources.
