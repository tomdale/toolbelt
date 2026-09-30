Toolbelt is Tom's public monorepo of personal agent tooling: BB plugins (`bb-plugin-*`), the Pi Claude-plugin loader (`claude-plugin-loader/`), and small utilities (`agentlog/`, `iterm-snapshot/`, `agent-browser-plugin-allow-loopback/`). Each package owns its manifest, lockfile, and scripts; install and run them from the package directory.

The canonical checkout `~/Code/Repos/toolbelt/main` is live: the daily BB app loads every installed toolbelt plugin from `main/bb-plugin-*`, and Pi loads `claude-plugin-loader/` and `pi-extensions/` from it. `pi-extensions/` is untracked, so it never reaches a task worktree and the lifecycle below can't carry changes to it; get Tom's direction before changing it. Change code only in your own Workforest task and follow the `personal-repo-lifecycle` skill through push and cleanup: isolate, verify, fast-forward main, build and reload from main, push, remove the task.

BB plugin checks: the package's typecheck, test, and build scripts, then `scripts/bb-plugin-smoke <plugin-dir>`, which activates the built plugin in a throwaway BB server. The daily BB app receives only main paths, via `bb plugin reload <id>` after building in main.

Package-type guides: `.agents/skills/{pi-plugins,claude-plugins,codex-plugins}`.
