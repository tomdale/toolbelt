# pi-extensions-local

Single-file Pi extensions that Pi loads from this directory as one local
package (see the `pi.extensions` list in `package.json`).

- `claude-rules.ts`: lists `.claude/rules/*.md` in the system prompt. Copy of
  Pi's `examples/extensions/claude-rules.ts`.
- `plan-shortcut.ts`: `Ctrl+Alt+P` sends `/plan`, the command registered by the
  `@narumitw/pi-plan-mode` package.
- `preset.ts`: named model/thinking/tool/instruction presets from
  `~/.pi/agent/presets.json` and `<cwd>/.pi/presets.json`. Copy of Pi's
  `examples/extensions/preset.ts` (Pi 0.87.1).
- `protected-paths.ts`: blocks writes and edits to `.env`, `.git/`, and
  `node_modules/`. Copy of Pi's `examples/extensions/protected-paths.ts`.

Pi supplies the `@earendil-works/pi-*` imports at runtime. The dev
dependencies exist only for `pnpm typecheck`; keep them on the Pi version
installed on this machine so the extensions typecheck against the API they run
with.
