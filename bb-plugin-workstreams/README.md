# Workstreams for BB

Workstreams organizes your BB threads into **workstreams** when you ask. A
single pass proposes the whole map and thread placements; preview it, then
apply. A workstream is a native BB section, so the built-in sidebar and
Workstreams always agree on where a thread lives. [SPEC.md](SPEC.md) is the full
design and the contract the code is checked against.

## What it does

- **Sidebar thread list** (select it under Settings → Appearance → Sidebar):
  - **＋ New work** opens BB's own new-thread composer with one more field,
    Workstream, at the start of the picker row. Enter starts the thread the
    pickers show. When you pause typing, a ✦ suggestion appears under the
    composer: send the draft to an existing thread, start in an existing
    workstream, or start a new one, each with its project and environment. Press
    Tab to apply a workstream suggestion to the pickers, or ⌘⏎ (Ctrl+⏎) to apply
    it and start the thread; on a thread suggestion ⌘⏎ sends the draft there and
    closes the dialog. A new workstream is created first. A workstream's **＋**
    preselects it.
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
  - Rows show BB's status, a work-state mark (✓ complete and ◇ review from the
    agent's recap; ◆ decision, ◇ review, ⏸ blocked from analysis when a thread
    has no recap; hover for where it stopped), unread state, drafts, shortcuts
    and pull requests. Pick the working thread's spinner animation and its
    colors under **Working indicator** in the plugin's settings (BB's own by
    default). Hover a row for its Snooze and Archive buttons; right-click to
    move, rename, pin, mark read, snooze, archive, or delete.
- **Workstreams page** (`/plugins/workstreams/home`):
  - **Overview**: workstreams ranked by what needs you, each thread with where
    it stopped. Search with `/`.
  - **Map**: edit each workstream's description and aliases, and organize once
    (below).
  - **Activity**: every change and proposal with its time, rationale, source,
    and Undo, filterable by workstream, action, and needs-review.
- **Recaps**: every thread except side chats gets a `WorkstreamsRecap` tool, and
  its agent ends each turn one of three ways: a question card (AskUserQuestion
  or the provider's own), a **review** recap, or a **complete** recap. A recap
  is a Goal heading, one to three Latest results, for review a **Review** line
  naming what to inspect or try and the expected result, and links to files or
  pages. It shows above the composer with a dismiss ✕ in its corner and, when
  the thread can be archived, **Archive** centered under it; its state marks the
  sidebar row. Each recap also stays in the thread as a tinted **Recap** tool
  row; expand it to read the recap. Fresh input clears the card. A turn that
  ends without either gets an agent-only reminder, three by default (Settings →
  **Recap**: on/off, reminders 0–10, and a Full or Minimal layout without the
  goal). BB reports turn completion after the fact, so the turn's own reply is
  already visible when the reminder arrives. The tool reaches each thread when
  its provider session next starts, and only those threads get reminders.
- **Archive**: on a complete or review recap, when BB has no unfinished tasks,
  goals, queued messages, interactions, or background work, and every child and
  lifecycle dependent is complete. Archiving a review recap accepts its result.
  Archive rechecks outstanding work. Typing a continuation, adding an
  attachment, or starting new work withdraws it for that recap; clearing the
  draft doesn't bring it back. Dismiss hides the card on every client and keeps
  the sidebar mark. Workstreams never archives automatically.
- **Analysis**: a few seconds after each turn, one small model call records the
  thread's one-line summary, work state, subject, and (for top-level threads)
  whether its latest request drifted to another workstream. Results are tied to
  the turn they describe and show as updating once a new turn starts. A recap
  outranks analysis for the work state. Analysis itself never moves anything.
- **Titles**: the same call suggests a title when a thread has none, its title
  is cut off or too vague, or its latest requests moved onto different work.
  Workstreams applies it (at most once an hour for a titled thread) and logs it
  in Activity with Undo. A title you or an agent set is never changed; clear it
  to hand it back. Turn this off with the `autoTitle` setting.
- **Organize** (Map tab, or `bb workstreams rebuild`): one bounded model call
  scans open thread roots and proposes a coherent map with descriptions, aliases
  and placements. Review the whole map, uncheck unwanted moves, then Apply as
  one undoable batch. Between runs, membership stays fixed. Unassigned roots
  remain Unsorted. Homes default to concrete products/projects; substantial
  initiatives can stand alone. Apply also removes previewed empty homes or
  archived-only homes whose newest archive is over 24 hours old, preserving
  threads and Undo. See [Organizing workstreams](docs/organization.md).
- **Routing**: New work classifies the draft against the map when you pause
  typing and suggests one home: a thread to continue, an existing workstream, or
  a new workstream, with a project and environment. Nothing changes until you
  accept it; Enter starts what the pickers show.
- **Task threads**: top-level threads also get short instructions to delegate
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
  button appears wherever Workstreams used a model: the thread header, the New
  work, Activity entries, the organizing review, generated descriptions,
  Overview rows, and the sidebar row menu (**Inspect model calls…**). It opens a
  side pane with those calls. **Run again** sends the same prompt to the same
  model to show whether the answer is stable, without changing anything.
  Activity lists each model call among the changes, including calls that made no
  change. Model rows use a quiet surface tint and a Model badge, and prioritize
  the event, subject, and labeled assessment. Related threads use BB-style
  thread-reference pills on an aligned row, with host-owned link navigation.
  Small information buttons explain event names and lifecycle terms on hover or
  keyboard focus. **Technical details** reveals labeled model, duration, token
  usage, and cost measurements plus prompt inspection; these measurements stay
  collapsed by default. Debug controls in **Activity** filter by call kind and
  failures, show the count and cost of visible calls, load older calls, and
  clear traces without deleting activity changes. Journal entries also expose
  expandable internal details. Records include redacted thread excerpts and are
  kept for 7 days (at most 1,000).

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

The package uses the published Plugin SDK pinned in its lockfile. New work
embeds BB's native composer unchanged and places its Workstream field in BB's
picker row (see SPEC §6). Build and verify in an isolated task; deploy only from
the canonical checkout.

```sh
npm ci
npm run typecheck
npm test
npm run build
# Then run the repository's scripts/bb-plugin-smoke against this package.
node eval/run.ts      # analysis eval (calls models); see eval/README.md
node eval/route.ts    # routing eval
```

- `src/domain/`: pure logic: `tree.ts` (exact-once forests), `project.ts` (the
  projection shared by the sidebar, page, and CLI), `analysis.ts`,
  `organize.ts`, `router.ts`, `instructions.ts`.
- `src/server/`: `service.ts` (mutations, batches, undo, reconciler),
  `analyzer.ts`, `recap.ts` (the recap tool and reminders), `archive.ts`,
  `bootstrap.ts`, `router.ts`, `agents.ts` (`configure`), `map.ts`,
  `journal.ts`, `db.ts` (append-only migrations; the existing migration IDs
  remain append-only), `cli.ts`, `contract.ts`, `model.ts` (every model call's
  prompt and parser, and Debug mode's recording), `trace.ts` (the trace store),
  `inference/` (the host entry that runs Pi).
- `src/app/`: the sidebar list, the page, the header parent link, the recap
  card, New work, and `debug/` (inspect buttons, the inspector pane), fed by
  `useWorkstreams.ts`.

To check the exact-once guarantee against real data, export a snapshot to
private storage (it contains thread titles) and point the test at it:

```sh
jq -n --argjson threads "$(bb thread list --json)" \
  --argjson sections "$(bb thread section list --json)" \
  '{threads: $threads, sections: $sections}' > /private/path/snapshot.json
WORKSTREAMS_SNAPSHOT=/private/path/snapshot.json npm test
```
