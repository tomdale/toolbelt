# pi-extensions-local

Single-file Pi extensions that Pi loads from this directory as one local
package (see the `pi.extensions` list in `package.json`).

- `plan-shortcut.ts`: `Ctrl+Alt+P` sends `/plan`, the command registered by the
  `@narumitw/pi-plan-mode` package.

Pi supplies the `@earendil-works/pi-*` imports at runtime. The dev
dependencies exist only for `pnpm typecheck`; keep them on the Pi version
installed on this machine so the extensions typecheck against the API they run
with.
