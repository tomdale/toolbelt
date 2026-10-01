# pi-offshoot

[English](./README.md)

把当前 Pi 对话分叉为独立 Session，并在新的 Herdr pane 中启动另一个 Pi 进程。

## 安装

本包未发布到 npm。把目录加入 Pi 的 `packages` 设置，或从 toolbelt checkout 安装：

```bash
pi install ./pi-offshoot
```

安装后重启 Pi，并确保 Pi 运行在 Herdr 中。

## 使用

```text
/offshoot
/offshoot vertical
/offshoot horizontal
```

`vertical` 在右侧打开 pane，`horizontal` 在下方打开 pane。默认值为 `vertical`；也支持 `right`、`down`、`v`、`h` 别名。

快捷键：

- `Ctrl+Alt+Right` — 右侧 pane
- `Ctrl+Alt+Down` — 下方 pane

Slash command 会等待当前 turn 完全结束。Extension shortcut 无法使用 command-only Session 控制，因此 Pi 忙碌时快捷键会提示先等待。

## Session 行为

Offshoot 会保留当前活动对话 branch，父 Session 则保持不变。两个 Pi 进程共享同一个 checkout；需要文件系统隔离时请改用 Git worktree。

Offshoot 要求当前 Session 已持久化，并且活动 branch 以一个完整 assistant response 结束。启动失败时，错误信息会报告独立 child Session 的恢复路径。
