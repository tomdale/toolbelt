# pi-offshoot

[简体中文](./README.zh-CN.md)

Fork the active Pi conversation into an independent Pi process in a new Herdr pane.

## Install

This package is not published to npm. Add its directory to Pi's `packages` setting, or install it from a toolbelt checkout:

```bash
pi install ./pi-offshoot
```

Restart Pi after installation, and run Pi inside Herdr.

## Use

```text
/offshoot
/offshoot vertical
/offshoot horizontal
```

`vertical` opens a right-hand pane. `horizontal` opens a lower pane. The default is `vertical`; `right`, `down`, `v`, and `h` are accepted aliases.

Keyboard shortcuts:

- `Ctrl+Alt+Right` — right-hand pane
- `Ctrl+Alt+Down` — lower pane

The command waits for the active turn to settle. Shortcuts ask you to wait when Pi is busy because extension shortcuts do not receive command-only session controls.

## Session behavior

The offshoot preserves the active conversation branch while leaving the parent session unchanged. The two Pi processes share the same checkout, so use a worktree when filesystem isolation is required.

Offshoot requires a persisted session whose active branch ends with a completed assistant response. If startup fails, the error reports the independent child session path for recovery.
