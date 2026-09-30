# Workstreams for BB

Workstreams organizes your BB threads into **workstreams** and keeps that
organization current as you work. A workstream is a native BB section, so the
built-in sidebar and Workstreams always agree on where a thread lives.
[SPEC.md](SPEC.md) is the full design and the contract the code is checked
against.

## What it does

- **Sidebar thread list** (select it under Settings → Appearance → Sidebar):
  - **＋ New work** opens a composer that previews the destination as you type.
    Edit the prompt or choose a workstream before sending. A workstream's **＋**
    selects that workstream explicitly and skips classification. The project is
    chosen automatically; **Settings** reveals project and execution controls.
  - **Needs you**: a pending approval or question, or a thread whose latest turn
    asks you to decide something. These rows sit at the top in a tinted block
    under a collapsible header, each naming its workstream. A delegate's
    question folds into its parent's newer one.
  - **Recent**: the five most recently active threads not already in Needs you
    (the `showRecent` setting).
  - **One group per workstream**, in BB's section order until you drag a header
    to reorder them. Each thread tree is filed under its root thread's section,
    exactly as BB's own sidebar does. Drag a root thread to reorder it within
    its group or drop it on another group to move it there; its children come
    with it, and threads you never placed stay newest first above the ones you
    did.
  - **Unsorted** and a collapsed **Dormant** fold (no threads, or none touched
    in 30 days).
  - Rows show BB's status, a work-state mark from analysis (◆ decision, ◇
    review, ⏸ blocked; hover for where it stopped), unread state, drafts,
    shortcuts, pull requests, and a yellow dot when a workstream change involves
    the thread. Pick the working thread's spinner animation and its colors under
    **Working indicator** in the plugin's settings (BB's own by default). Hover
    a row for its Archive button; right-click to move, rename, pin, mark read,
    archive, or delete.
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
  never moves anything; the later filing pass may use its subject.
- **Archive suggestions**: when classification finds a natural end and BB has no
  unfinished tasks, goals, queued messages, interactions, or background work, a
  quiet **Archive** button appears in the composer toolbar. Clicking
  archives directly after rechecking outstanding work. Typing a continuation,
  adding an attachment, or starting new work dismisses the suggestion for that
  completed turn; clearing the draft does not bring it back. Reading, scrolling,
  and focusing the composer do not dismiss it. A later completed turn can
  produce a new suggestion. Workstreams never archives automatically.
- **Titles**: the same call suggests a title when a thread has none, its title
  is cut off or too vague, or its latest requests moved onto different work.
  Workstreams applies it (at most once an hour for a titled thread) and logs it
  in Activity with Undo. A title you or an agent set is never changed; clear it
  to hand it back. Turn this off with the `autoTitle` setting.
- **Organize once** (Map tab, or `bb workstreams rebuild`): proposes a map
  (renames, merges, new workstreams, descriptions), lets you review it, files
  unfiled and automatically filed threads, and previews the result before
  applying it as one undoable change. Threads you filed stay put.
- **Evolution**, after that: when a subject collects two or more threads in a
  workstream, Workstreams spins it out, moves threads to the workstream their
  subject names, or merges a workstream into another, with a yellow banner under
  the thread header to Undo (or, with `evolution = ask`, to accept first).
  Unsorted threads it can place confidently are filed the same way. A
  high-confidence `new: <subject>` assignment creates that workstream and files
  the thread in the same pass; lower-confidence assignments remain Unsorted.
- **Routing**: in BB's new-thread composer a banner shows where the draft goes
  (continue a thread, a new thread in a workstream, or a new workstream) and
  presets the project and environment; Enter or Start creates the thread and
  files it there, and Send there continues the thread.
- **Task threads**: top-level threads get short instructions to delegate
  subtasks with BB's own `bb thread spawn --parent-self` (with environment
  guidance for the project's shape) and to hand off out-of-scope requests with
  `bb workstreams handoff`. Delegates are told to report to their parent. A
  thread whose latest request drifted shows a banner to hand off, move, or
  dismiss.
- **Parent link** in child threads' headers (the `showParentThreadLink`
  setting).
- **Reconciler**: BB emits no events for section changes, so Workstreams
  compares BB's state with its own every minute. Changes made elsewhere are
  recorded as made "outside Workstreams" and never overridden.

- **Debug mode** (the `debug` setting, off by default): every model call is
  recorded with the exact prompt, the model's reasoning summary, the raw
  response, the parsed result, and what Workstreams did with it. A small bug
  button appears wherever Workstreams used a model: the thread header, the drift
  and proposal banners, the routing banner and New work, Activity entries, the
  organizing review, generated descriptions, Overview rows, and the sidebar row
  menu (**Inspect model calls…**). It opens a side pane with those calls. **Run
  again** sends the same prompt to the same model to show whether the answer is
  stable, without changing anything. Activity lists each model call among the
  changes, including calls that made no change. Model rows use a quiet surface
  tint and a Model badge, and prioritize the event, subject, and labeled
  assessment. Related threads use BB-style thread-reference pills on an aligned
  row, with host-owned link navigation. Small information buttons explain event
  names and lifecycle terms on hover or keyboard focus. **Technical details**
  reveals labeled model, duration, token usage, and cost measurements plus
  prompt inspection; these measurements stay collapsed by default. Debug
  controls in **Activity** filter by call kind and failures, show the count and
  cost of visible calls, load older calls, and clear traces without deleting
  activity changes. Journal entries also expose expandable internal details.
  Records include redacted thread excerpts and are kept for 7 days (at most
  1,000).

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
bb workstreams rebuild [--apply]               # organize once; preview unless --apply
bb workstreams log [--since 7d] [--external]   # the activity log
bb workstreams undo <entry-id>
bb workstreams trace [<id>] [--thread <id>] [--entry <id>] [--kind <kind>] [--json]
                                               # Debug mode: recorded model calls
bb workstreams cutover                         # after organizing: drop v1's leftover data
```

A workstream argument is a section id or its name (case-insensitive). `new` and
`handoff` exit 3 when the router is unsure, printing the candidates.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
bb plugin install .   # or `bb plugin reload workstreams` once installed from this path
node eval/run.ts      # analysis eval (calls models); see eval/README.md
node eval/route.ts    # routing eval
```

- `src/domain/`: pure logic: `tree.ts` (exact-once forests), `project.ts` (the
  projection shared by the sidebar, page, and CLI), `analysis.ts`,
  `evolution.ts`, `organize.ts`, `router.ts`, `instructions.ts`.
- `src/server/`: `service.ts` (mutations, batches, undo, reconciler),
  `analyzer.ts`, `bootstrap.ts`, `evolution.ts`, `router.ts`, `agents.ts`
  (`configure`), `map.ts`, `journal.ts`, `db.ts` (append-only migrations; the
  first two are v1's), `cli.ts`, `contract.ts`, `model.ts` (every model call's
  prompt and parser, and Debug mode's recording), `trace.ts` (the trace store),
  `inference/` (the host entry that runs Pi).
- `src/app/`: the sidebar list, the page, the header parent link and proposal
  banner, the composer routing banner, and `debug/` (inspect buttons, the
  inspector pane), fed by `useWorkstreams.ts`.

To check the exact-once guarantee against real data, export a snapshot to
private storage (it contains thread titles) and point the test at it:

```sh
jq -n --argjson threads "$(bb thread list --json)" \
  --argjson sections "$(bb thread section list --json)" \
  '{threads: $threads, sections: $sections}' > /private/path/snapshot.json
WORKSTREAMS_SNAPSHOT=/private/path/snapshot.json npm test
```
