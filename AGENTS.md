Package types: Pi extensions/packages (Pi manifests and extension/resource paths); BB plugins (BB manifests, commonly in `bb-plugin-*` directories); Claude/Codex integrations (host manifests or loader packages); standalone utilities (their own package manifests). Identify ownership from the directory and manifest, then follow the matching type guidance. Read that package's README, manifest, and nearest `AGENTS.md`; use its declared package manager and scripts.

Pi extensions/packages: Follow Pi's extension/package guidance and API references. Test source directly with `pi -e <source>`; reload auto-discovered extensions with `/reload`, and start a fresh process after direct-source changes. For distribution testing, build/package as documented, install the local package with `pi install <path>`, and verify it in a fresh runtime.

BB plugins: Install dependencies as declared, run the package checks/tests, and build with `bb plugin build`. For live testing, install the local plugin path with `bb plugin install path:<directory> --yes`, then run `bb plugin reload <plugin-id>` and verify behavior. `bb plugin dev <directory>` watches, builds, and reloads source changes. Reload does not restart BB or separate provider/child processes; restart the affected runtime when required.

Claude/Codex integrations: Use the host or package manifest to find build, test, and local-loading commands; verify behavior through the consuming host.

Standalone utilities: Use the package manifest and README for their build, test, and local-run commands.
