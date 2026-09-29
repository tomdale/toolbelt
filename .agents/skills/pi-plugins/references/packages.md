# Pi packages

A Pi package is an npm, git, or local resource bundle. It can contain extensions, skills, prompt templates, and themes. It is not a Claude/Codex plugin manifest.

## Commands and storage

```bash
pi install npm:@scope/pkg@1.2.3
pi install git:github.com/user/repo@v1
pi install https://github.com/user/repo
pi install ./local-package
pi remove npm:@scope/pkg
pi list
pi update --extensions       # packages and pinned-ref reconciliation
pi update --all              # Pi plus packages
pi -e npm:@scope/pkg         # temporary, current run only
```

User settings are written by default; `-l` writes project settings (`.pi/settings.json`). User installs live under `~/.pi/agent/npm` and `~/.pi/agent/git`; project installs under `.pi/npm` and `.pi/git`. Git refs are pinned; updates do not silently move a configured tag/commit. Project package installation/loading requires trust.

## Manifest and convention

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "dependencies": { "zod": "^3.0.0" },
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Manifest paths are package-relative; arrays accept globs and `!` exclusions. Without `pi`, conventional directories load `.ts`/`.js` extensions, recursive skill directories containing `SKILL.md` (and top-level skill markdown), non-recursive prompt `.md`, and theme `.json` files. Add gallery `video` (MP4) or `image` (PNG/JPEG/GIF/WebP) under `pi` if desired.

## Dependencies

Put runtime libraries in `dependencies`, not `devDependencies`: package installation uses production installs (`npm install --omit=dev` by default). Core packages are bundled by Pi; declare these as `peerDependencies: { "*" }` and do not bundle them: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`. Other Pi packages must be shipped in the tarball via `dependencies` and `bundledDependencies`; reference their resources through `node_modules/<package>/...`.

With a wrapper, pin npm operations in settings:

```json
{ "npmCommand": ["mise", "exec", "node@20", "--", "npm"] }
```

## Filtering and scope

Settings can load strings or filtered objects:

```json
{
  "packages": [{
    "source": "npm:my-package",
    "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
    "skills": [], "prompts": ["prompts/review.md"], "themes": ["+themes/legacy.json"]
  }]
}
```

Omitted type loads all; `[]` loads none; `!pattern` excludes; `+path` force-includes and `-path` force-excludes exact package-relative paths. `pi config` interactively enables/disables resources (Tab switches global/project; `pi config -l` starts with project overrides). A package in project settings wins over the same global identity unless project `autoload:false` makes it a delta. Identity is npm name, git URL without ref, or resolved local path.
