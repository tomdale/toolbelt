# Workstreams for BB

Workstreams organizes your BB threads into **workstreams** and keeps that
organization current as you work. A workstream is a native BB section, so the
built-in sidebar and Workstreams always agree on where a thread lives.
[SPEC.md](SPEC.md) is the full design and the contract the code is checked
against.

## What it does today

- **Sidebar thread list** (select it under Settings → Appearance → Sidebar):
  - **Needs you**: threads waiting on you (a pending approval or question).
  - **Recent**: the five most recently active threads not already in Needs you.
    Turn it off with the `showRecent` setting.
  - **One group per workstream**, in BB's section order. Each thread tree is
    filed under its root thread's section, exactly as BB's own sidebar does, so
    a delegated child always sits under its parent.
  - **Unsorted**: root threads with no workstream.
  - **Dormant**: workstreams with no threads, or none touched in 30 days;
    collapsed by default.
  - Rows show BB's live status, unread state, drafts, the jump shortcut, and the
    branch's pull request. They nest children, open in place (⌘-click opens a
    split), and drag out to split.
  - Right-click a row to move it to a workstream (or a new one), rename, pin,
    mark read or unread, archive, or delete. Children move with their parent.
    Right-click a workstream header to rename it or start a thread in it.
- **Workstreams page** (`/plugins/workstreams/home`): workstreams ranked by what
  needs you, then by recent activity, with each workstream's threads to pick
  back up. Search with `/`. The **Activity** tab lists every change with its
  time, a short rationale, and Undo where BB still allows it.
- **Parent link** in child threads' headers (the `showParentThreadLink`
  setting).
- **Reconciler**: BB emits no events for section changes, so Workstreams
  compares BB's state with its own every minute and after thread lifecycle
  events. Moves and section edits made elsewhere (the built-in sidebar, the CLI,
  agents) are recorded as made "outside Workstreams" and never overridden. The
  Activity tab hides them unless you ask.

Workstreams makes no model calls yet. Recaps, work states, automatic filing,
new-thread routing, and workstream evolution arrive in later phases (SPEC §16).

## CLI

```sh
bb workstreams list [--json]                  # workstreams with thread counts
bb workstreams show <workstream> [--json]     # one workstream's threads, nested
bb workstreams file <thread> <workstream>     # file a root thread; `unsorted` removes it
bb workstreams log [--since 7d] [--external]  # the activity log
bb workstreams undo <entry-id>
```

A workstream argument is a section id or its name (case-insensitive).

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
bb plugin install .   # or `bb plugin reload workstreams` once installed from this path
```

- `src/domain/`: pure logic. `tree.ts` builds parent/child forests that place
  every thread exactly once; `project.ts` is the projection shared by the
  sidebar, the page, and the CLI.
- `src/server/`: `service.ts` (mutations, undo, reconciler), `journal.ts`,
  `db.ts` (append-only migrations; the first two are v1's), `cli.ts`,
  `contract.ts` (RPC).
- `src/app/`: the sidebar list, the page, and the header link, all fed by
  `useWorkstreams.ts`.
- `eval/`: synthetic classification fixtures for the analysis phases.

To check the exact-once guarantee against real data, export a snapshot to
private storage (it contains thread titles) and point the test at it:

```sh
jq -n --argjson threads "$(bb thread list --json)" \
  --argjson sections "$(bb thread section list --json)" \
  '{threads: $threads, sections: $sections}' > /private/path/snapshot.json
WORKSTREAMS_SNAPSHOT=/private/path/snapshot.json npm test
```
