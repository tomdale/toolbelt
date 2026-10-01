# Overlay and `/todos` display

How
[`@tomdale/pi-todo`](https://www.npmjs.com/package/@tomdale/pi-todo)
renders the task list — when the overlay appears, what each glyph means, how
overflow is trimmed, and which strings localize.

## When the overlay exists

The widget is mounted above the Pi editor under the key `rpiv-todos`.

| Stage | Condition |
| --- | --- |
| Created | At the first session start that has a UI. A headless session never creates it. |
| Registered | Only while at least one overlay-visible task exists. The widget unregisters itself when the list empties, and re-registers when a task reappears. |
| Bound | Only the foreground session's overlay is refreshed. A detached or child session has its own task state and never rebinds or repaints the foreground panel. |
| Disposed | On the foreground session's shutdown. A child session shutting down leaves the overlay alone. |

Task state is partitioned by session id, so parallel sessions cannot read or
overwrite each other's lists. Nothing is written to disk: on session start,
compaction, and session-tree changes, the list is rebuilt by walking the branch
and taking the last `todo` tool result's snapshot, which replaces the whole list
(last-write-wins).

## Anatomy of a row

```
● Todos (2/5)
├─ ✓ Create DemoTodo domain entity
├─ ✓ Create IDemoTodoRepository interface
├─ ◐ Create DemoTodoRepository (creating the repository)
├─ ○ Register DI bindings
└─ ○ Add integration tests
```

- **Heading** — `● Todos (done/total)` in the accent color while any task is
  `pending` or `in_progress`; `○ Todos (done/total)` dimmed once everything is
  completed.
- **Glyphs** — `○` pending, `◐` in_progress, `✓` completed, `✗` deleted.
  Completed and deleted subjects render dim and struck through.
- **activeForm** — appended dim in parentheses, only while the task is
  `in_progress`.
- **Dependencies** — appended as `⛓ #1,#2` when the task has a `blockedBy` set.
- **`#id` prefix** — shown on every row only when at least one visible task
  carries a `blockedBy`. Without a `⛓ #N` anywhere, the per-row ids have nothing
  to point at, so they are omitted.
- **Prefixes** — `├─` on each row, `└─` on the last one. A blank spacer line is
  always appended below the panel so it is not flush against the input box.

Rows longer than the terminal width are truncated with `…`.

## Overflow

The content-row budget is `maxWidgetLines` (default `12`), and the heading counts
against it. When there are more tasks than fit:

1. one row is reserved for the summary line;
2. completed tasks are dropped first, newest first — the oldest completed rows
   are the last completed rows to go;
3. if the unfinished tasks alone still overflow, the tail of that list is
   truncated;
4. the last row becomes `+N more (X completed, Y pending)`.

Use Pi's tool-output expansion shortcut (`ctrl+o` by default) to expand the
widget and show every task. Collapsing Pi's tool output reapplies the configured
row budget. Unfinished work is therefore the last thing to disappear in the
compact view. See [configuration.md](./configuration.md#maxwidgetlines) for the
budget's floor and reload semantics.

## Completed tasks fading out

A completed task stays on screen for the remainder of the turn in which it was
completed. At the start of the next agent turn, every completed row that has
already been displayed is hidden from later renders. Reloading or compacting the
session resets that tracking, so a fresh session shows the full list again.

## Collapsing

Press `ctrl+shift+t` to collapse the panel to two lines — the heading plus a dim
`└─ ctrl+shift+t to expand` hint — and again to expand it. The hint always shows
the currently configured key.

Rebind or disable the shortcut with the `collapseKey` option; see
[configuration.md](./configuration.md#collapsekey). If the shortcut is set to
`"off"` while the panel is collapsed, the hint becomes a static `collapsed`
label rather than advertising an unbindable key.

## `/todos`

`/todos` opens a focused modal containing the complete detailed hierarchy,
independent of the overlay's row budget and completed-task auto-hiding. The
modal supports:

- `↑`/`↓` and page keys to select tasks;
- `e` or `enter` to edit subject, description, active form, status, or owner;
- `a` to add a pending sibling, `d`/`delete` to delete the selected task, and
  uppercase `C` to clear the draft;
- `ctrl+↑`/`ctrl+↓` (or `K`/`J`) to reorder siblings with their subtrees while
  keeping focus on the moved task;
- `tab`/`→` to make a task a child of its previous sibling;
- `shift+tab`/`←` to move a task out one hierarchy level; and
- `escape` or `q` to save and close.

Opening and closing an unchanged draft has no side effects. A changed draft is
persisted as a branch entry, refreshes the persistent overlay, and queues a
hidden message containing the complete new hierarchy for the agent's next
turn. This makes user edits authoritative without starting an agent turn just
because the modal closed.

`/todos clear` clears the live list directly without opening the modal. It uses
the same persistence, overlay refresh, and next-turn notification path as a
modal edit. In a non-interactive session, plain `/todos` reports `/todos
requires interactive mode`.

## Localization

The overlay heading, the `+N more` summary, the collapse hint, and status words
localize through
[`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
when that package is installed. Bundled locales: `de`, `en`, `es`, `fr`, `pt`,
`pt-BR`, `ru`, `uk`, `zh`.

LLM-facing output — the tool response envelope, reducer error messages, and the
schema descriptions — stays English by design.

The SDK is a soft optional peer, loaded through a dynamic import at module init.
When it is absent, every call site returns its inline English literal and the
extension stays online: no warning, no crash. Install it at any time with
`pi install npm:@juicesharp/rpiv-i18n` and restart the session. To add or
override a translation, drop a `locales/<code>.json` file mirroring `en.json` —
see the `@juicesharp/rpiv-i18n` README's "Contributing translations" section.
