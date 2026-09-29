# Pi skills

Pi implements the Agent Skills standard with lenient validation. A skill is a directory whose required `SKILL.md` has YAML frontmatter; scripts, assets, and `references/` are freeform and loaded progressively.

## Discovery

Global: `~/.pi/agent/skills/` and `~/.agents/skills/`. Project (after trust): `.pi/skills/` and `.agents/skills/` in cwd/ancestors up to the repository root. Packages use `skills/` or `pi.skills`; settings use `skills`; CLI uses repeatable `--skill <path>`. In `~/.pi/agent/skills` and `.pi/skills`, root `.md` files are individual skills; root `.md` is ignored in `.agents/skills` locations. Directories with `SKILL.md` are recursively found. `--no-skills` disables discovery (explicit `--skill` still loads).

```json
{ "skills": ["~/.claude/skills", "../.claude/skills"], "enableSkillCommands": true }
```

At startup Pi puts names/descriptions in the system prompt. `/skill:name args` loads the body and appends `User: <args>`; use it to force loading. Duplicate names warn and the first discovered skill wins. Missing `description` means the skill is not loaded.

## Frontmatter and layout

```yaml
---
name: pi-plugins
description: Build and troubleshoot Pi customizations. Use for Pi extensions, packages, skills, hooks, or resources.
license: MIT
compatibility: Requires Pi 0.79.x
metadata:
  owner: team
allowed-tools: read,grep
---
```

Required `name` (1–64 characters, lowercase letters/numbers/hyphens; no leading/trailing/consecutive hyphens) and `description` (max 1024 chars). Optional fields include `license`, `compatibility` (max 500), `metadata`, `allowed-tools`, and `disable-model-invocation`. Pi permits the name to differ from the parent directory, unlike the standard. Unknown fields are ignored.

```text
my-skill/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

Use paths relative to the skill directory in `SKILL.md`; keep the main file concise and link deeper references. Review skill instructions and executable helpers before use: skills can direct the model to run arbitrary commands. Project skills are native resources, but their trust-gated loading is a Pi behavior; scripts are not sandboxed.
