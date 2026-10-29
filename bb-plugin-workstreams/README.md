# Workstreams for BB

Workstreams keeps open BB threads useful at a glance by maintaining each root
thread's **goal**, **topic**, **status**, and **activity**, then deriving native
BB **workstreams** (sections) from topics.

## Install and start

Requires **BB 0.44+** and **Plugin SDK 0.6.5+**. From a retained local checkout:

```sh
cd bb-plugin-workstreams
npm ci
npm run build
bb plugin install "$PWD" --yes
```

Path installs load from that directory; do not delete it while installed. In
Tom's toolbelt checkout, develop in a Workforest task and install only from
canonical `main` after integration.

1. Open **Settings → Workstreams** and choose the Quick and Full analysis
   models. The default Gateway models need a connected BB machine with an AI
   Gateway key; see [model execution](#gateway-vs-provider-worker-models).
2. Select **Workstreams** as the sidebar thread list and open **Workstreams** in
   the main navigation to browse the topic tree and organization state.
3. Start a thread with **Automatic**, or select its **Topic** yourself. To move
   existing work, change its Topic rather than dragging between sections.

See [ISSUES.md](ISSUES.md) for current limitations and audit dispositions.

## Core concepts

| Term                 | Meaning                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Thread**           | A BB thread; the unit of work shown across the UI.                                                                                            |
| **Root**             | A visible, non-archived thread with no visible active parent. Roots are the unit Workstreams classifies and organizes.                        |
| **Delegate**         | A child thread created for separable work. Delegates inherit their root's topic and workstream.                                               |
| **Topic**            | An entry in the topic tree representing a product or capability (`Owner: Capability`), with a description and aliases.                        |
| **Topic tree**       | Every topic Workstreams knows, whether or not an open thread currently uses it.                                                               |
| **Topic assignment** | A root's assigned topic (or **No topic**), together with its provenance (`manual`, `inherited`, `full`, or `quick`) and classification basis. |
| **Workstream**       | A native BB section bound to one topic in the topic tree.                                                                                     |
| **Unfiled**          | Roots that currently have no topic and therefore belong to no workstream.                                                                     |
| **Goal**             | What a thread is for, written as its display title (`3–8` words, up to `60` characters).                                                      |
| **Status**           | How the latest turn ended: `needs you`, `review`, `blocked`, `working` (`in_progress` in JSON/CLI), `done`, or `error`.                       |
| **Agent recap**      | A structured end-of-turn report submitted by the agent with the `WorkstreamsRecap` tool.                                                      |
| **Organization**     | The deterministic process—and Workstreams page tab—that derives workstreams and section membership from topics.                               |
| **Activity**         | The log of changes Workstreams made or observed, with undo where supported.                                                                   |

### Core rules

1. **Topics own workstreams.** A root's topic determines its workstream. Moving
   a thread between sections in BB's sidebar is logged as an outside change and
   reverted on the next organizer pass; change a root's topic to move it to
   another workstream.
2. **Delegates follow their root.** Child threads use their root's topic and
   workstream and are nested under their parent in the sidebar, Home view, and
   CLI.
3. **Topic provenance priority.** Topic sources follow
   `manual > inherited > full > quick`:
   - `manual` (chosen by you in the composer, thread header, sidebar,
     Organization tab, or CLI) is never overwritten by automatic analysis.
   - `inherited` (from a parent/source thread or a workstream's **＋** button)
     changes automatically only when Full analysis reports a scope shift or
     settles a more specific topic beneath it, or when you explicitly apply a
     reviewed topic-repair plan.
   - `full` (settled by Full analysis at turn end) replaces `quick` and updates
     prior `full` assignments.
   - `quick` (initial guess from Quick analysis) fills only threads without a
     stronger source.
4. **Agent reports outrank fallback status.** Structured questions
   (`AskUserQuestion`) and agent recaps (`WorkstreamsRecap`) take precedence
   over Full analysis for thread status, recap text, and `needs you` prompts.
   Full analysis supplies those fields only when the agent did not report.

---

## How it works

### 1. Starting a thread & Quick analysis

When you compose a new thread, the composer includes a **Topic** control (in
BB's picker row on wide viewports, or on its own strip above the prompt on
phones):

- **Automatic (`✦`, default):** Runs **Quick analysis** on your draft while you
  type (after a `250 ms` pause, or `900 ms` for drafts of `20` characters or
  fewer) to preview a goal and topic. When you send the first request, a
  matching draft preview is reused immediately without a second model call;
  otherwise Quick analysis runs on the sent request.
- **Explicit workstream reference:** A draft containing `@section:<id>` resolves
  to that section's bound topic without a model call when typing suggestions are
  enabled. For example, `@section:sec_0123456789` uses a native BB section ID,
  not a topic name or topic ID. Run `bb workstreams list` to find section IDs.
  Unknown or unbound section IDs fall back to Quick analysis. This is a preview
  shortcut, not a separate destination-workstream control.
- **Workstream `＋` button:** Clicking **New work in \<workstream\>** in a
  sidebar group header seeds the composer with that workstream's topic
  (`inherited` provenance).
- **Forked or spawned threads:** Inherit their source thread's topic
  (`inherited` provenance).
- **Manual topic selection:** Opening the Topic picker lets you search the topic
  tree, create **New topic "\<query\>"** inline, or choose **No topic**
  (`manual` provenance, keeping the thread **Unfiled**).

Quick analysis defaults to schema-constrained `openai/gpt-6-luna-fast` with
reasoning disabled (`15 s` timeout, up to `4` in-flight calls). Title and topic
outputs validate independently: an invalid topic receives one bounded repair
attempt within the remaining time budget and never blocks a valid opening title
or clears an existing assignment. Opening titles only fill threads that do not
yet have a title while the first turn is still running.

### 2. Turn end & Full analysis

When a visible, non-archived thread goes idle after a turn (`5 s` debounce, up
to `4` concurrent runs), **Full analysis** runs with:

- The thread's opening request, recent substantive user requests (control-only
  replies such as `continue`, `yes`, or `ok` do not redefine the thread's
  objective), referenced continuation threads (`@thread:`), and the latest
  assistant reply.
- The thread's current durable objective, title, topic assignment, project
  context, the topic tree (up to `500` topics), and the latest agent recap if
  one was recorded.

Full analysis settles:

- **Durable objective and goal (title):** Evaluates whether the thread's
  objective should `keep`, `refine` (requires new user request evidence), or
  `pivot` (requires the latest user request). When **Keep titles current** is
  enabled, Workstreams updates the thread title (`3–8` words, up to `60`
  characters; titles exceeding `60` characters are dropped rather than clipped).
  If you rename a thread outside Workstreams, that title is locked and preserved
  until cleared.
- **Topic assignment:** Settles the root's topic (or proposes a new topic path
  in the topic tree) subject to provenance priority
  (`manual > inherited > full > quick`). Classification chooses the most
  specific capability the work concerns: work on one capability of a product or
  platform files under that capability's topic, which Full analysis proposes as
  a new subtopic when none exists. Work on the whole product, or work whose
  capability is unclear, stays with the broader topic. Every inferred update
  re-validates live thread evidence, assignment state, and topic-tree freshness
  before writing so superseded runs never overwrite newer state.
- **Fallback recap and status:** Only when the agent did not call
  `WorkstreamsRecap`, Full analysis supplies a one-line recap, work state
  (`needs_decision`, `review`, `blocked`, `in_progress`, or `done`), and a short
  `needsYou` prompt when waiting on your decision. Failed turns are marked
  `error` without running analysis.
- **Observed product and feature names:** Accumulates product and feature names
  mentioned in analyzed conversation excerpts and agent recaps per thread,
  independent of topic assignments. Observations persist across model-trace
  pruning and are deleted when the thread is deleted.

### 3. Deterministic organization

The **Organizer** runs automatically after topic assignments, thread lifecycle
state, or organization settings change. It is completely deterministic and makes
**no model calls**:

- **Contraction:** Driven by **Contraction threshold** (default `3`, range
  `0–99`), counting **visible, non-archived roots**, including `done` roots:
  - When a top-level topic's total visible roots are at or below the threshold,
    it gets one workstream for all of its subtopics.
  - Above the threshold, every topic with a visible root gets its own workstream
    (`Owner: Capability`), and the sidebar nests those workstreams by topic.
  - The same counts always give the same workstreams; completion alone never
    regroups, because done roots count too.
- **Section sync and cleanup:** Creates, renames, or removes Workstreams-owned
  BB sections, moves roots into their derived workstream, logs and reverts
  outside section moves, and prunes unused, childless discovered topics.
- **Stable visual collapse:** Expanding or collapsing a workstream in the
  sidebar follows its bound topic identity across windows and across section
  recreation.

---

## Surfaces in BB

### Sidebar (`Workstreams` thread list)

Select **Workstreams** as your sidebar thread list to organize threads into:

1. **Up Next:** A sticky amber card at the top of the sidebar with the few root
   threads most worth your attention. Every root that isn't archived or snoozed
   is a candidate. A thread with a question for you (`AskUserQuestion` or
   approval pending, or a `needs_decision` status) or a turn ready for review is
   _blocked on you_; anything else (complete, waiting, working, failed) is not.
   A review or decision whose turn ended more than `7` days ago ages out and
   counts as not blocked; a pending question card or approval never ages out.
   Candidates rank in six tiers, each newest first by latest turn end:
   1. Unread questions
   2. Unread reviews
   3. Read questions
   4. Read reviews
   5. Other unread threads
   6. Other read threads

   Up Next then trims from the bottom: threads not blocked on you leave (read
   before unread) until `5` remain; read blocked threads leave until `10`
   remain; past that, only the `10` most recently active stay, whatever their
   tier. So Up Next always shows a few threads, grows only for threads blocked
   on you, and never lists more than `10`. It re-ranks as recaps, read state,
   and activity change. The thread you have open keeps its row and place until
   you open another thread. Nested delegates do not appear as separate Up Next
   entries; find them in their workstream's thread tree.
   - **Focus:** While a focused workstream has a thread blocked on you, Up Next
     applies these rules to focused workstreams' threads only, marks its header
     with the focus icon, and counts the threads blocked on you elsewhere on the
     **Show other workstreams** toggle.

2. **Workstreams (focused and other tiers):**
   - **Nesting:** Workstreams nest by topic. A product's workstreams form one
     group headed by the most specific topic they share; each more specific
     workstream is a subgroup under the topic it shares with another, with its
     name shown below its parent's (**Beacon Automations** → **Alert
     Investigations**). A shared topic with no workstream of its own appears as
     a header with no threads of its own. A group lists its own threads first,
     then its subgroups, which collapse independently; a subgroup whose threads
     are all snoozed is left out. Focus, ordering, and Dormant apply to a
     top-level group as a whole.
   - Click the **Focus** button (viewfinder icon) on any workstream header to
     pin it to the top tier. When at least one workstream is focused, the other
     workstreams, **Unfiled**, and **Dormant** collapse behind **Show/Hide other
     workstreams**.
   - Click **New work in \<workstream\>** (`＋`) on a header or subgroup header
     to open the composer pre-seeded with that topic.
   - Click **Snooze** (alarm-clock icon) on a header or subgroup header to
     snooze every thread it lists with your default preset, subgroups included
     and whether or not it is collapsed; rest the pointer on it for the snooze
     menu. Each root thread is snoozed with its delegate subtree, as if snoozed
     from its own row, and **Undo** in the confirmation wakes them all. The
     button appears only while the header lists threads.
   - Use the **Sort workstreams** menu to order workstreams by **Name A–Z**,
     **Recent activity**, or **Manual order** (drag headers within their tier).
   - Drag root threads within a workstream to set manual thread order (newly
     created roots appear at the top of their workstream; newly created
     workstreams appear at the bottom).
3. **Unfiled:** Roots with no topic assignment.
4. **Dormant:** Unfocused workstreams with no activity in the last `30` days and
   nothing waiting on you.
5. **Recent, Snoozed, and Archived bands:**
   - **Recent** lists the most recently active root threads (`1–20`, default
     `5`) that Up Next isn't showing, so it carries on where Up Next stops.
     Snoozed threads stay out.
   - **Snoozed** lists snoozed threads ordered by soonest wake time (or
     `On update`), carrying their delegate subtrees with them while snoozed.
   - **Archived** paginates archived threads via BB's archive list.
   - Each band has a **⋯** menu for **Sort by** (`Recent activity`, `Title A–Z`,
     `Soonest to wake`, or `Archive date`) and **Group by workstream**.

#### Row indicators and actions

- **Status marks:** Live BB runtime indicators (customizable working spinner,
  `?` waiting, `!` error, `✎` unsent draft, unread dot) and Workstreams status
  glyphs (`◆` Needs your decision, `◇` Ready for your review, `⏸︎` Blocked on
  something else, `✓` Complete from agent recap, `↻` Waiting from agent recap).
- **Hover actions:** **Archive** and **Snooze** (click to snooze with your
  default preset; rest the pointer for `350 ms` to open the snooze menu, or
  click **Wake now** on a snoozed row). Thread rows and workstream headers share
  one set of buttons: they appear while the row is hovered, holds keyboard
  focus, or has a menu open, take no room otherwise, and come in one order
  everywhere: **Focus**, **New work**, **Archive**, then **Snooze** or **Wake
  now** last. A focused workstream's **Focus** mark and an empty workstream's
  `＋` always show. Touch screens, which can't hover, show only those two; a
  thread row's actions stay in its long-press menu. Section **⋯** menus always
  show, dimmed until used.
- **Right-click context menu:** **Open in split**, **Open parent** (for
  delegates), **Topic** (switch to **Automatic** or assign any topic in the
  tree), **Rename…**, **Pin / Unpin**, **Mark read / Mark unread**, **Inspect
  model calls…** (when Debug mode is on), **Snooze / Change snooze / Wake now**,
  **Archive**, and **Delete…**.

### Phone Home screen

On compact viewports (when **Sidebar → Up next and workstreams on phones** is
enabled), Workstreams replaces BB's flat Recent list on the Home screen with:

- The **Up Next** card at the top.
- **Workstreams** sections with deterministic hue dots, waiting/total badges, an
  **Expand all / Collapse all** toggle, and per-parent delegate fold controls.
  Focused workstreams (or a single active workstream) start expanded.
- A collapsible **Snoozed** section at the bottom.

### Thread view and header

- **Sticky goal header:** Displays the thread's workstream (in its deterministic
  hue) above the thread's goal title and—when the latest recap has a more
  specific turn goal—a subtitle below it. Scrolling down collapses the heading
  smoothly into the top bar.
- **Thread header actions:**
  - **Parent thread** (optional, off by default): Opens the parent thread from a
    delegate's header.
  - **Topic:** Shows the root's current topic path (or _No topic_ /
    _Classifying…_) and provenance on hover. Click to search and assign a topic
    (`manual`) or choose **Automatic** to reclassify with Full analysis.
  - **Observed names** (Debug mode only): Opens a popover of products and
    features observed across Full analysis runs for the thread, with run counts
    and first/last-seen timestamps on hover.
  - **Snooze:** Split button on desktop (one-click default snooze + chevron menu
    for all presets and **Custom…**) or menu button on phones; shows **Snoozed
    \<time\>** with a **Wake now** option while snoozed.
  - **Archive** (on by default): Archives the current thread through BB's
    archive flow.

### Agent recap card (`WorkstreamsRecap`)

When **End turns with a recap** is enabled (default), agents report the outcome
of each turn using `WorkstreamsRecap`, rendered as a card above the composer:

- **States and accents:**
  - **Complete** (emerald): Shows the turn's goal, completed `latest` bullets,
    optional follow-up action buttons, and an **Archive** suggestion when the
    thread and all of its delegates, goals, and todos are finished and idle.
    Archiving opens the top Up Next thread when it is blocked on you or unread,
    and otherwise the next thread in the same workstream.
  - **Ready for Review** (sky): Adds numbered **Review** steps (`1–3`) and up to
    `8` clickable **Links** (HTTPS URLs or absolute workspace/host file paths,
    including paths with spaces).
  - **Waiting** (violet): Used when the agent is waiting on background subagents
    or external work. Lists **Awaited agents** with live status dots (polled
    every `4 s`, including hidden worker threads) and a draining countdown bar
    (**Next check in M:SS**). When the timer expires, Workstreams automatically
    prompts the agent once to check status and report back.
- **Interactive tokens:** `@thread:<id>` mentions render as clickable thread
  chips; Git commit hashes (`7–40` hex characters containing letters and digits)
  render shortened with configurable digit/letter tints and click-to-copy.
- **Next actions:** Up to `3` suggested follow-up buttons. **Click** a button to
  send its prompt immediately; **Shift-click** (or choose **Edit in composer**
  from the overflow menu) to insert the prompt into the composer for editing.
- **Dismiss and restore:** Click **Dismiss recap** (`×`) to hide the card (and
  cancel any pending waiting-recap countdown); click the **Show recap** pill to
  restore it.
- **Reminders and loop guard:** If an enrolled agent ends a turn without calling
  `WorkstreamsRecap` or `AskUserQuestion`, Workstreams sends up to `3` automatic
  reminders (configurable `0–10`). If an active thread hits `5` identical
  consecutive tool-call failures, Workstreams stops the turn and pauses
  automatic continuation to prevent an infinite retry loop.

### Structured question card (`AskUserQuestion`)

When an agent needs a structured decision (and the active provider does not
supply its own native question tool), `AskUserQuestion` renders an amber card
above the composer:

- Supports `1–4` questions in tabs, each with up to `4` single-select or
  multi-select options (with number-key shortcuts and optional Markdown
  previews) plus an **Other…** freeform input.
- Freeform answers support pasted images and project file attachments (`Enter`
  to submit, `Shift+Enter` for a newline).
- Draft answers save automatically to `sessionStorage` (`250 ms` debounce) and
  recover across page reloads or interrupted turns.
- Completed or dismissed questions render inline in the conversation timeline as
  **QuestionHistoryCard** entries.

### Workstreams page (`/plugins/workstreams/home`)

Open **Workstreams** in the main navigation panel to access four tabs:

1. **Overview:** Press `/` to search across workstream names, thread titles, and
   recaps; click **New work…** to open the composer; browse active workstream
   cards ranked by `needs you` and recency; or expand the quiet/dormant
   workstreams disclosure.
2. **Topics:** Browse and search the full topic tree (`Owner › Capability`),
   descriptions, and aliases. Create top-level topics (**New topic**), **Add
   subtopic**, **Rename**, **Move** (reparent to another topic or top level),
   **Merge** (moves assigned threads and subtopics into the target topic and
   deletes the source), or **Edit details** (description and comma-separated
   aliases).
3. **Organization:**
   - Inspect live organizer status (`Workstreams up to date`,
     `Analyzing threads N of M`, `Updating workstreams`, or
     `Organizing stopped`), summary counts (**Active threads**, **Active
     workstreams**, **No topic**, **Done**), and click **Refresh** or
     **Rebuild…**.
   - Assign topics directly to **Threads with no topic** or inspect **Derived
     Workstreams** with their active/total counts and grouping policy reason.
   - **Review automatic topics:** After editing topic definitions, click
     **Preview topic repairs** to evaluate up to `100` visible roots against the
     current topic tree (making model calls without changing any assignments,
     titles, or statuses). Review the proposed `from → to` changes and click
     **Apply topic repairs** to commit them. Plans expire after `30` minutes,
     reject stale topic trees, preserve manual assignments, and skip threads
     whose evidence changed since the preview.
4. **Activity:** Day-grouped log of automatic and outside changes. Filter by
   workstream, action (`Move`, `New workstream`, `Rename`, `Delete`, `Undo`,
   `Reorganize`, `Edit`, `New thread`, `Updated title`, `Removed topic`),
   **Needs review**, or **Outside changes**. Hover or focus any reversible entry
   and click **Undo** to revert its effect when current BB state still matches.

---

## Commands and keyboard shortcuts

| Command / Shortcut                                              | Where                             | Action                                                                                          |
| --------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Workstreams: next Up Next thread` (`Cmd+Alt+J` / `Ctrl+Alt+J`) | Global command palette / shortcut | Opens the next thread in Up Next, wrapping to the top.                                          |
| `Workstreams: snooze this thread`                               | Command palette (active thread)   | Snoozes the current thread using your configured **Click to snooze** default preset.            |
| `Workstreams: wake this snoozed thread`                         | Command palette (snoozed thread)  | Wakes the current snoozed thread immediately.                                                   |
| `/`                                                             | Workstreams page                  | Switches to the **Overview** tab and focuses the search box.                                    |
| `Shift+Click`                                                   | Recap card **Next action** button | Copies the suggested prompt into the composer for editing instead of sending immediately.       |
| `1`–`4`, `Enter` / `Shift+Enter`                                | `AskUserQuestion` card            | Selects an option by number; submits the answer (`Enter`) or inserts a newline (`Shift+Enter`). |

---

## Snooze presets and wake behavior

Threads can be snoozed from the sidebar hover button, the sidebar right-click
menu, the thread header, or the command palette, and a whole workstream's
threads at once from its sidebar header. Every snooze menu lists your presets in
order, then **Custom…**; clicking a snooze button uses the default preset.

You keep between `1` and `6` presets in **Settings → Workstreams → Snooze**.
Each preset has an optional label (an empty label names it by its rule) and one
rule, which resolves to a wake time at the moment you choose it:

| Rule          | Wakes                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Duration**  | That many minutes or hours from now (up to `999`), or that many days from now at the same clock time (up to `365`).                                                            |
| **Time**      | At a clock time on **Today** (tomorrow once that time has passed), **Tomorrow**, **Next workday** (Friday through Sunday wake on Monday), or the coming weekday (never today). |
| **On update** | On the thread's next activity (`until: null`).                                                                                                                                 |

The defaults are **1 hour**, **Tomorrow morning** (tomorrow at `9 AM`, the
default), **Next week** (Monday at `9 AM`), and **Until it updates**.

**Custom…** opens a submenu for a one-off snooze with the same rules (**For a
duration…**, **At a time…**, **Until it updates**) plus **On a date…**, which
picks any date and time up to `366` days out. Editing a preset never moves a
thread that is already snoozed: a snooze stores only its wake time.

- Snoozing a root removes the root and its entire delegate subtree from its
  workstream and from **Up Next** / **Recent**, placing them in the **Snoozed**
  section until wake.
- **Time-based snoozes ignore background agent activity** so an overnight run
  does not wake a thread before morning; when a timed snooze expires,
  Workstreams wakes the thread and marks it unread.
- Sending a message to a snoozed thread or clicking **Wake now** wakes it
  immediately.

---

## Settings reference

Open **Settings → Workstreams** to configure:

| Section               | Setting                                            | Default                                     | Details                                                                                                                                                                        |
| --------------------- | -------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Sidebar**           | **Up Next**, **Recent**, **Snoozed**, **Archived** | All `On`                                    | Show or hide each band in the Workstreams sidebar.                                                                                                                             |
| **Sidebar**           | **Threads shown** (under Recent)                   | `5` (`1–20`)                                | Maximum root threads shown in the Recent band.                                                                                                                                 |
| **Sidebar**           | **Up next and workstreams on phones**              | `On`                                        | Replaces BB's flat Recent list on the compact phone Home screen.                                                                                                               |
| **Sidebar**           | **Timestamp**                                      | `Always`                                    | Show row timestamps `Always`, `On hover`, or `Never`.                                                                                                                          |
| **Sidebar**           | **Thread count** / **Waiting count**               | `When collapsed`                            | Show workstream counts `Always`, `When collapsed`, or `Never`.                                                                                                                 |
| **Working indicator** | **Style**, **Color**, **Track**                    | `Spokes`, `Subtle gray`, `Faded color`      | Choose from `7` spinner shapes (`Spokes`, `Sunburst`, `Arc`, `Orbit`, `Ring`, `Braille`, `Dots`), named or custom `#rrggbb` colors, and track styles for `Arc`/`Orbit`/`Ring`. |
| **Threads**           | **Full analysis model**                            | `openai/gpt-6-sol-fast`                     | Model used at turn end to settle goals, topics, and fallback status.                                                                                                           |
| **Threads**           | **Keep titles current**                            | `On`                                        | Automatically titles new threads and updates titles as focus evolves. Outside manual title edits stay locked until cleared.                                                    |
| **Threads**           | **Show parent thread link**                        | `Off`                                       | Shows a parent-thread pill in delegate thread headers.                                                                                                                         |
| **Threads**           | **Show archive button**                            | `On`                                        | Shows an Archive button in thread headers.                                                                                                                                     |
| **Recap**             | **End turns with a recap**                         | `On`                                        | Gives agents `WorkstreamsRecap` and displays the recap card above the composer.                                                                                                |
| **Recap**             | **Reminders**                                      | `3` (`0–10`)                                | Maximum turn-end reminders sent when an enrolled agent omits a recap (`0` disables reminders).                                                                                 |
| **Recap**             | **Layout**                                         | `Full` (`Full` / `Compact`)                 | Card layout on desktop (`Compact` is always used on phones), with a live preview carousel.                                                                                     |
| **Recap**             | **Commit hash colors**                             | Theme default                               | Custom `#rrggbb` colors for commit-hash digits and letters, with **Reset**.                                                                                                    |
| **Snooze**            | **Presets**                                        | `4` presets, **Tomorrow morning** default   | `1–6` presets every snooze menu lists before **Custom…**: add, edit, delete, drag to reorder, and choose the **Default** a click uses.                                         |
| **New threads**       | **Home project**                                   | `Don't work in a project`                   | Default project used for background worker fallback when a thread has no project.                                                                                              |
| **New threads**       | **Suggestions while typing**                       | `On`                                        | Runs Quick analysis on composer drafts while typing.                                                                                                                           |
| **New threads**       | **Quick analysis model**                           | `openai/gpt-6-luna-fast` (reasoning `none`) | Model used for composer draft previews and first-send Quick analysis (remains active when typing suggestions are off because first-send analysis still uses it).               |
| **Organization**      | **Contraction threshold**                          | `3` (`0–99`)                                | Visible-root count (including done roots) at or below which a top-level topic gets one workstream; above it, each topic with threads gets its own. Applies immediately.        |
| **Advanced**          | **Analysis machine**                               | Automatic                                   | Enrolled BB machine used for gateway model calls when multiple machines are connected.                                                                                         |
| **Advanced**          | **Debug mode**                                     | `Off`                                       | Records redacted model traces (`7` days / `1,000` records) and reveals **Observed names**, **Inspect** buttons, composer diagnostics, and Activity model-call rows.            |

### Gateway vs. provider worker models

- **AI Gateway models** (the built-in defaults and `pi` models prefixed
  `vercel-ai-gateway/`) run directly on the connected analysis host via
  `~/.pi/agent/auth.json` or `AI_GATEWAY_API_KEY` (`90 s` timeout,
  schema-constrained JSON for Quick analysis, no silent model fallback).
- **Other BB provider models** run inside a temporary hidden
  `"Workstreams worker"` BB thread (`120 s` timeout, automatically stopped and
  archived after completion), which takes several seconds longer per call. The
  released SDK does not expose schema-constrained generation or output-token
  limits for spawned threads. Responses still pass the same parser, validation,
  and bounded repair rules, but generation itself is unconstrained. Worker token
  usage, cost, and reasoning metadata are unavailable (`null` in traces), not
  evidence that the call was free.

---

## CLI reference

Run `bb workstreams --help` or any subcommand below. Every command accepts
`--json` for machine-readable output.

### Workstreams, organization, analysis, and activity

```sh
# List active workstreams, Unfiled, and Dormant groups with thread and Up Next counts
bb workstreams list [--json]

# Show threads in one workstream (by name, section ID, or "unfiled"), nested by parent
bb workstreams show <workstream> [--json]

# Inspect current organizer state and agent-report coverage, or force a fresh pass
bb workstreams organization [--rebuild] [--json]

# Run Full analysis on one thread now, or queue all unanalyzed active threads
bb workstreams analyze [<thread-id>] [--json]

# Read the activity log (retained for 90 days / 2,000 entries; default --since unit is hours)
bb workstreams log [--limit 1..500] [--since <duration, e.g. 90m or 7d>] [--external] [--json]

# Undo a logged activity entry when current BB state still matches
bb workstreams undo <entry-id> [--json]

# Inspect recorded Debug-mode model traces (kinds: quick-analysis, full-analysis)
bb workstreams trace [<trace-id>] [--thread <id>] [--entry <id>] [--kind <kind>] [--limit 1..500] [--json]
```

`show` returns at most 200 rows and reports truncation; JSON includes `count`,
`shown`, and `hasMore`. `log` defaults to 50 entries (maximum 500), applies
`--since` to the matching query window, and reports whether more matching
entries remain. Its JSON adds `count`, `limit`, and `hasMore`. `trace` defaults
to 20 records (maximum 500). These are bounded inspection commands, not full
history exports.

### Topic tree management and repair plans

```sh
# List all topics sorted by full path (Owner: Capability)
bb workstreams topics list [--json]

# Show a topic's ID, path, description, parent, aliases, active workstream home, and assigned threads
bb workstreams topics show <topic-name-or-id> [--json]

# Create, edit, reparent, or merge topics (automatically triggers the organizer)
bb workstreams topics create <name> [--description <text>] [--parent <topic-name-or-id>] [--aliases <a,b,c>] [--json]
bb workstreams topics edit <topic> [--name <name>] [--description <text>] [--aliases <a,b,c>] [--json]
bb workstreams topics reparent <topic> [--to <parent-topic-or-root>] [--json]
bb workstreams topics merge <source-topic> <target-topic> [--json]

# Preview and apply automatic topic repairs (up to 100 roots per preview; plans expire after 30m)
bb workstreams topics preview [<root-thread-id>] [--json]
bb workstreams topics apply <plan-id> [--json]
```

### Per-thread topic assignment

```sh
# Inspect a thread's workstream, topic, provenance source, and parent inheritance
bb workstreams thread show <thread-id> [--json]

# Manually assign a thread to a topic (sets manual provenance; protected from automatic changes)
bb workstreams thread assign <thread-id> <topic-name-or-id> [--json]

# Manually clear a thread's topic so it stays Unfiled (sets manual provenance)
bb workstreams thread clear <thread-id> [--json]

# Hand a thread back to automatic classification and run Full analysis immediately
bb workstreams thread reclassify <thread-id> [--json]
```

---

## Debug mode and observability

Enabling **Settings → Workstreams → Advanced → Debug mode** turns on trace
recording and unlocks diagnostic tools across the UI:

- **Trace recording & redaction:** Every Quick analysis and Full analysis model
  call records its redacted input, prompt, raw response, reasoning summary,
  parsed output, token usage, cost, duration, and applied outcome. Common secret
  patterns (`sk-…`, `ghp_…`, `github_pat_…`, `xoxb-…`, `Bearer …`, and
  `api_key`/`token`/`password`/`secret` assignments) are masked before prompts
  reach a model or trace store. Redaction is best effort, not a security
  boundary; do not put secrets in requests or assume diagnostics are safe to
  share without inspection. Conversation excerpts go to your selected model
  provider under that provider's policies. Traces are retained for `7` days or
  `1,000` records and pruned automatically even after Debug mode is turned off.
- **Thread Inspector:** Click the bug (`Inspect`) button on an Overview row,
  Activity row, or trace entry to open the side-pane inspector. Inspect every
  recorded call for a thread, copy the full trace JSON, or click **Run again**
  to replay the stored prompt against the current model and compare canonical
  results (`Same result` vs. `Differs in <fields>`) without mutating thread
  state.
- **Observed names:** Open **Observed names** in the thread header to inspect
  all product and feature names accumulated from Full analysis runs on that
  thread, with run counts and first/last-seen timestamps.
- **Activity model calls:** Filter the **Activity** tab by **Model calls**
  (`quick-analysis` or `full-analysis`) and **Failures only**, view total
  reported cost for the filtered calls, or click **Clear traces…** to delete
  recorded model traces while keeping the Activity log intact.
- **Composer routing diagnostics:** Expand the **Debug** disclosure in the
  new-thread composer to inspect live Quick-analysis confidence, inputs, token
  usage, reasoning, and copyable JSON diagnostics.

---

## Development

Build and verify in an isolated Workforest task worktree; deploy only from the
canonical checkout.

```sh
npm ci
npm run typecheck
npx vitest run
npm run build
```

Then run the repository's `scripts/bb-plugin-smoke` against this package to
verify activation in an isolated throwaway BB server. Opt-in model evaluations
live in [eval/README.md](eval/README.md) (they make paid model calls and are not
part of the unit test suite). See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md),
[SPEC.md](SPEC.md), and [docs/organization.md](docs/organization.md) for
architectural and specification details.
