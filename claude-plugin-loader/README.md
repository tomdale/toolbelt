# pi-claude-plugin-loader

A [pi](https://pi.dev) package that installs and loads plugins written in
[Claude Code's plugin format](https://code.claude.com/docs/en/plugins-reference)
so their skills and slash commands work inside pi.

Claude plugins and pi both build on the
[Agent Skills](https://agentskills.io/integrate-skills) convention, so a plugin's
`skills/` directory is already something pi can load. This package handles the
two things pi does not do on its own: fetching a Claude plugin (or marketplace)
and pointing pi's resource loader at the skills it contains.

## What it maps

Claude plugins can declare many component types. This loader bridges the ones
that have a native pi equivalent and ignores the rest:

| Claude component | pi equivalent | Status |
| --- | --- | --- |
| Skills (`skills/`, `skills` field, root `SKILL.md`) | Skills | ✅ loaded |
| Commands (`commands/`, `commands` field) | Prompt templates | ✅ loaded |
| Agents, hooks, MCP servers, LSP servers, monitors, themes | — | ⏭️ ignored |

### Namespacing

Skills are loaded with a plugin-name prefix. A plugin named `tdx` that defines a
`refactoring` skill is invoked as `/skill:tdx-refactoring`. This keeps plugin
skills from colliding with your global skills (or another plugin's) that share a
name — pi dedups skills by name, so without a prefix one would silently win.

pi skill names may only contain lowercase letters, numbers, and hyphens, and pi
has no in-memory skill API (skills are discovered only as files on disk), so the
loader stages a copy of each skill with its frontmatter `name` rewritten to
`<plugin>-<name>` and points pi at the staged copy. The fetched clone is left
unmodified. A skill's supporting files (`references/`, `scripts/`, etc.) are
copied alongside it so relative paths keep working.

### Marketplaces

Marketplace manifests (`.claude-plugin/marketplace.json`) with multiple plugins
are supported, including in-repo (`"source": "."`) and external git/github
plugin sources. A bare `.claude-plugin/plugin.json` or a lone `skills/`
directory also works.

## Install

```bash
pi install git:github.com/tomdale/pi-plugins/claude-plugin-loader
```

Or try it for a single run without installing:

```bash
pi -e git:github.com/tomdale/pi-plugins/claude-plugin-loader
```

## Use

Inside a pi session:

```
/claude-plugin install git:github.com/tomdale/skills
/claude-plugin list
/claude-plugin remove tdx
```

`install` resolves the plugin, records what it found, and reloads the session so
the new skills are available immediately (as `/skill:<name>` and to the model).
Local plugin sources are re-discovered and re-staged automatically during Pi
startup and reload, so edits in a local checkout are reflected without running
`install` again. Remote plugin clones remain unchanged until an explicit install
or update.

The same operations are available headless via the bundled CLI, which shares one
registry with the extension:

```bash
pi-claude-plugin install git:github.com/tomdale/skills
pi-claude-plugin list
```

Accepted sources match `pi install` shorthands: `git:host/owner/repo@ref`,
`https://…`, `ssh://…`, `owner/repo` (GitHub), and local paths.

## Where things live

- Installed plugin clones: `~/.pi/agent/claude-plugins/repos/…`
- Staged, namespaced skill copies: `~/.pi/agent/claude-plugins/skills/<plugin>/…`
- Registry of installed plugins: `~/.pi/agent/claude-plugins/registry.json`

Set `PI_CLAUDE_PLUGINS_DIR` to relocate both (used by the test suite).

## How it works

- **Install** (`src/install.ts`) resolves a source to a directory, reads any
  marketplace/plugin manifests, and records each plugin's absolute skill and
  command paths in the registry.
- **Namespace** (`src/skills.ts`) stages a `<plugin>-`-prefixed copy of each
  skill, since pi can only name a skill from its on-disk `SKILL.md` frontmatter.
- **Load** (`src/index.ts`) subscribes to pi's `resources_discover` event and
  returns the staged skill directories as `skillPaths` and command paths as
  `promptPaths`. pi scans them with its own loader, so plugin skills are
  indistinguishable from any other pi skill.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test      # installs github.com/tomdale/skills and asserts pi loads its skills
```

The test proves the end-to-end path against the real
[`github.com/tomdale/skills`](https://github.com/tomdale/skills) marketplace: it
installs the plugin, then loads the registered directories with pi's own
`loadSkillsFromDir` and checks that skills are discovered namespaced
(`tdx-refactoring`, `tdx-recap`, `tdx-cruft`) rather than bare, with no skill
validation warnings.
