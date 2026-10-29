Toolbelt is Tom's public monorepo of personal agent tooling. Pi packages: `claude-plugin-loader/`, `pi-{extensions-local,offshoot,recap,subagents,todo}/`. Utilities: `agentlog/` (agent session history CLI), `iterm-snapshot/` (Python, uv), `agent-browser-plugin-allow-loopback/`. Each package owns its manifest, lockfile, and scripts; install and run them from the package directory. Read `pi-subagents/AGENTS.md` before changing that package.

The canonical checkout `~/Code/Repos/toolbelt/main` is live: Pi loads the six Pi packages from it through `~/.pi/agent/settings.json`, whose source is dotfiles `home/dot_pi/agent/settings.json`; adding, renaming, or removing a Pi package changes that file too (see the `agent-config` skill).

Forks: `pi-recap/`, `pi-subagents/`, and `pi-todo/` keep their upstream LICENSE. `pi-{recap,subagents}/UPSTREAM.md` record source, base commit, and local changes; update it in the same change as any change to that package.

Pi package checks: the package's declared scripts, then `pi -p --no-session -ne -e <task>/<package> --model vercel-ai-gateway/openai/gpt-6-luna-fast 'Reply with exactly: ok'`, which loads only the task copy and must print `ok` with no "Failed to load extension" warning. `pi-todo/`'s `test` script runs only inside the upstream rpiv-mono workspace, whose harness (`test/setup.ts`, `@juicesharp/rpiv-test-utils`) it imports, so a toolbelt task cannot run it.

Package-type guides: `.agents/skills/{pi-plugins,claude-plugins,codex-plugins}`.
