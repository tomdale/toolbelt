# Pi Offshoot design

## Goal

Launch an independent Pi process in a new Herdr pane while preserving the active root-to-leaf conversation path and never exposing the parent JSONL to concurrent writers.

## Reviewed approaches

- Pi `SessionManager.createBranchedSession()` is the native operation used to extract one active path into a new session ID and JSONL. It preserves entries on that path, reconstructs labels, rechains parent IDs, and records the source file as `parentSession`.
- `@maxedapps/pi-herdr-sidetrack` calls the native operation through a detached manager. Its tests demonstrate preservation of messages, model/thinking changes, compaction, labels, session name, and parent bytes.
- `@henryqw/pi-herdr-clone` also uses a detached manager and conservatively retains session/tab state after an uncertain launch.
- `forkoff` temporarily calls `createBranchedSession()` on the live manager and then restores its session file. Although guarded by `finally`, this unnecessarily mutates the manager owned by the active Pi process.
- Snapshot-based `/btw` implementations replay model-facing context but do not preserve the complete native session-entry path.
- Raw file copying risks copying a changing append-only JSONL and does not apply Pi's branch extraction, new-session identity, label reconstruction, or parent linkage.

## Chosen session sequence

1. Wait for the active turn to settle.
2. Validate the current Herdr pane before creating durable child state.
3. Capture the parent session file and leaf together after settlement.
4. Open the parent file through a detached `SessionManager`.
5. Validate that the captured leaf still exists and has a completed assistant response.
6. Call `createBranchedSession(leafId)` on the detached manager.
7. Verify that Pi materialized a different child file.
8. Split the explicit parent Herdr pane.
9. Start a new Pi process with `--session <child-file>`.

The live manager is never switched or written by Offshoot. The child is the only process launched against the new JSONL, while the parent remains the only process using its original JSONL.

## Failure policy

Before child creation, failures create no recoverable state. After child creation, a failed or uncertain Herdr operation never deletes the child file. Once an explicit child pane ID is known, a failed agent start leaves that pane open for inspection. Errors report the recoverable child path and known pane ID without echoing raw Herdr diagnostics.

## Layout and controls

Herdr names split directions `right` and `down`. Offshoot presents them as `vertical` (side-by-side, new pane right) and `horizontal` (stacked, new pane down). `/offshoot` defaults to vertical. `Ctrl+Alt+Right` and `Ctrl+Alt+Down` provide direct shortcuts when Pi is idle.
