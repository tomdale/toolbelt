# Workstreams for BB

Workstreams organizes your BB threads into **workstreams** when you ask. A
single pass proposes the whole map and thread placements; preview it, then
apply. A workstream is a native BB section, so the built-in sidebar and
Workstreams always agree on where a thread lives. [SPEC.md](SPEC.md) is the full
design and the contract the code is checked against.

## What it does

- **Sidebar thread list** (select it under Settings → Appearance → Sidebar):
  - **＋ New work** opens a composer that previews the destination as you type.
    Action, destination, Project and Environment controls stay visible. Solid
    yellow stars mark automatic fields; each chosen field has its own revert.
    Choices survive prompt edits. A workstream's **＋** explicitly selects it
    and skips classification. **No workstream** creates an unassigned thread and
    requires a chosen or confidently inferred project. Existing threads show
    locked placement and use their existing execution settings. Pending routing
    blocks Enter and click before the native composer clears the draft.
  - **For you**: a pending approval or question, or a thread whose latest turn
    asks you to decide something. These rows sit at the top in an amber block
    with a slow shimmer, under an always-open header, each naming its
    workstream. The block shows five rows, with Show more for the rest. A
    delegate's question folds into its parent's newer one. It's hidden when
    nothing is waiting on you (the `showForYou` setting turns it off).
  - **Recent**: the five most recently active threads not already in For you
    (the `showRecent` setting).
  - **One group per workstream**, in BB's section order until you drag a header
    to reorder them. Each thread tree is filed under its root thread's section,
    exactly as BB's own sidebar does. Drag a root thread to reorder it within
    its group or drop it on another group to move it there; its children come
    with it, and threads you never placed stay newest first above the ones you
    did.
  - **Unsorted** and a collapsed **Dormant** fold (no threads, or none touched
    in 30 days).
  - A collapsed **Snoozed** fold. Snoozing a thread takes it (and its children)
    out of For you, Recent, and its group until it wakes. Hover a row and click
    its alarm clock to snooze with your default (Tomorrow morning unless
    changed), or rest the pointer on it for a menu of quick choices. Right-click
    → **Snooze** lists them all: 30 minutes, 1 hour, 3 hours, Tomorrow morning,
    This weekend, Next week, Until it updates, or a date and time you pick. The
    thread header has the same choices as a split button, and the command
    palette has "Workstreams: snooze this thread". Settings → **Snooze** picks
    the default, the hover menu's choices (up to four), and when morning is. A
    timed snooze returns the thread marked unread at its time; "Until it
    updates" returns it at its next activity; sending the thread a message or
    **Wake now** ends any snooze.
  - Rows show BB's status, a work-state mark from analysis (◆ decision, ◇
    review, ⏸ blocked; hover for where it stopped), unread state, drafts,
    shortcuts and pull requests. Pick the working thread's spinner animation and
    its colors under **Working indicator** in the plugin's settings (BB's own by
    default). Hover a row for its Snooze and Archive buttons; right-click to
    move, rename, pin, mark read, snooze, archive, or delete.
- **Workstreams page** (`/plugins/workstreams/home`):
  - **Overview**: workstreams ranked by what needs you, each thread with where
    it stopped. Search with `/`.
  - **Map**: edit each workstream's description and aliases, and organize once
    (below).
  - **Activity**: every change and proposal with its time, rationale, source,
    and Undo, filterable by workstream, action, and needs-review.
- **Analysis**: a few seconds after each turn, one small model call records the
  thread's recap, work state, subject, and (for top-level threads) whether its
  latest request drifted to another workstream. Results are tied to the turn
  they describe and show as updating once a new turn starts. Analysis itself
  never moves anything.
- **Archive suggestions**: when classification finds a natural end and BB has no
  unfinished tasks, goals, queued messages, interactions, or background work, a
  quiet **Archive** button appears in the composer toolbar. Clicking archives
  directly after rechecking outstanding work. Typing a continuation, adding an
  attachment, or starting new work dismisses the suggestion for that completed
  turn; clearing the draft does not bring it back. Reading, scrolling, and
  focusing the composer do not dismiss it. A later completed turn can produce a
  new suggestion. Workstreams never archives automatically.
- **Recap freshness**: stored recaps are shown only for the idle thread revision
  they summarize. A new turn invalidates the recap, and generation checks the
  revision again before saving. Freshness reads do not scan conversation
  history; recaps without a recorded revision regenerate before being shown.
- **Titles**: the same call suggests a title when a thread has none, its title
  is cut off or too vague, or its latest requests moved onto different work.
  Workstreams applies it (at most once an hour for a titled thread) and logs it
  in Activity with Undo. A title you or an agent set is never changed; clear it
  to hand it back. Turn this off with the `autoTitle` setting.
- **Organize** (Map tab, or `bb workstreams rebuild`): one bounded model call
  scans open thread roots and proposes a coherent map with descriptions, aliases
  and placements. Review the whole map, uncheck unwanted moves, then Apply as
  one undoable batch. Between runs, membership stays fixed. Unassigned roots
  remain Unsorted. See [Organizing workstreams](docs/organization.md).
- **Routing**: Workstreams' own New work dialog shows where the draft goes
  (continue a thread or start one in an existing home) and presets the project
  and environment; Enter or Start creates the thread and files it there, and
  Send there continues the thread. An uncertain route leaves the choice to you.
  Creating a workstream requires the explicit Create workstream action;
  classification cannot silently create a home.
- **Task threads**: top-level threads get short instructions to delegate
  subtasks with BB's own `bb thread spawn --parent-self` (with environment
  guidance for the project's shape) and to hand off out-of-scope requests with
  `bb workstreams handoff`. Delegation requires user approval. Delegates are
  told to report to their parent.
- **Parent link** in child threads' headers (the `showParentThreadLink`
  setting).
- **Reconciler**: BB emits no events for section changes, so Workstreams
  compares BB's state with its own every minute. Changes made elsewhere are
  recorded as made "outside Workstreams" and never overridden.

- **Debug mode** (the `debug` setting, off by default): every model call is
  recorded with the exact prompt, the model's reasoning summary, the raw
  response, the parsed result, and what Workstreams did with it. A small bug
  button appears wherever Workstreams used a model: the thread header, the
  New work, Activity entries, the organizing review,
  generated descriptions, Overview rows, and the sidebar row menu (**Inspect
  model calls…**). It opens a side pane with those calls. **Run again** sends
  the same prompt to the same model to show whether the answer is stable,
  without changing anything. Activity lists each model call among the changes,
  including calls that made no change. Model rows use a quiet surface tint and a
  Model badge, and prioritize the event, subject, and labeled assessment.
  Related threads use BB-style thread-reference pills on an aligned row, with
  host-owned link navigation. Small information buttons explain event names and
  lifecycle terms on hover or keyboard focus. **Technical details** reveals
  labeled model, duration, token usage, and cost measurements plus prompt
  inspection; these measurements stay collapsed by default. Debug controls in
  **Activity** filter by call kind and failures, show the count and cost of
  visible calls, load older calls, and clear traces without deleting activity
  changes. Journal entries also expose expandable internal details. Records
  include redacted thread excerpts and are kept for 7 days (at most 1,000).

Model calls go straight to AI Gateway from the analysis machine (`hostId`, blank
for the only connected machine), with the AI Gateway key Pi has there. They
never request reasoning. The analysis and routing model is a setting limited to
models that pass the eval (`eval/README.md`).

## CLI

```sh
bb workstreams list [--json]                   # workstreams with counts
bb workstreams show <workstream> [--json]      # threads nested, with where each stopped
bb workstreams file <thread> <workstream>      # file a root thread; `unsorted` removes it
bb workstreams edit <workstream> [--description <text>] [--alias <a,b>]
bb workstreams new "<prompt>" [--workstream <w>] [--project <id>] [--dry-run]
bb workstreams handoff --request-stdin [--note <text>] [--dry-run] [--json] <<'EOF'
<the user's request, verbatim>
EOF
bb workstreams analyze [<thread>]              # analyze now, or catch up
bb workstreams rebuild                         # generate a saved preview
bb workstreams rebuild --apply --run-id <id>   # apply that preview, no new model call
bb workstreams log [--since 7d] [--external]   # the activity log
bb workstreams undo <entry-id>
bb workstreams trace [<id>] [--thread <id>] [--entry <id>] [--kind <kind>] [--json]
                                               # Debug mode: recorded model calls
```

A workstream argument is a section id or its name (case-insensitive). `new` and
`handoff` exit 3 when the router is unsure, printing the candidates.

## Development

The package uses the published Plugin SDK pinned in its lockfile. New work uses
BB's native composer and a scoped CSS adapter. The native button retains BB's
label, and early submission is rejected with draft restoration. Build and verify
in an isolated task; deploy only from the canonical checkout.

```sh
npm ci
npm run typecheck
npm test
npm run build
# Then run the repository's scripts/bb-plugin-smoke against this package.
node eval/run.ts      # analysis eval (calls models); see eval/README.md
node eval/route.ts    # routing eval
```

Standalone screenshots use actual IntakeBanner markup and production CSS, with
native composer and SDK icons represented by test stand-ins. With Chrome
installed, capture them without opening BB:

```sh
NEW_WORK_CAPTURE_DIR=/tmp/new-work-shots npm test -- --run tests/app/intake-banner.test.tsx
node scripts/capture-new-work.mjs /tmp/new-work-shots
```

- `src/domain/`: pure logic: `tree.ts` (exact-once forests), `project.ts` (the
  projection shared by the sidebar, page, and CLI), `analysis.ts`,
  `organize.ts`, `router.ts`, `instructions.ts`.
- `src/server/`: `service.ts` (mutations, batches, undo, reconciler),
  `analyzer.ts`, `bootstrap.ts`, `router.ts`, `agents.ts` (`configure`),
  `map.ts`, `journal.ts`, `db.ts` (append-only migrations; the existing
  migration IDs remain append-only), `cli.ts`, `contract.ts`, `model.ts` (every
  model call's prompt and parser, and Debug mode's recording), `trace.ts` (the
  trace store), `inference/` (the host entry that runs Pi).
- `src/app/`: the sidebar list, the page, the header parent link and recap
  actions, New work intake, and `debug/` (inspect buttons, the
  inspector pane), fed by `useWorkstreams.ts`.

To check the exact-once guarantee against real data, export a snapshot to
private storage (it contains thread titles) and point the test at it:

```sh
jq -n --argjson threads "$(bb thread list --json)" \
  --argjson sections "$(bb thread section list --json)" \
  '{threads: $threads, sections: $sections}' > /private/path/snapshot.json
WORKSTREAMS_SNAPSHOT=/private/path/snapshot.json npm test
```
