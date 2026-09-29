# Workstreams v2 specification

Status: **draft for sign-off**. This document defines Workstreams v2, a rewrite
of the Workstreams BB plugin. It is the contract that implementation, tests, and
reviews check against. §17 lists every decision and whether Tom made it or it is
a default awaiting confirmation.

## 1. Purpose

Tom works across dozens of BB agent threads in many repositories and switches
context constantly. Workstreams answers five questions at a glance:

- What product is this work for?
- What is unfinished?
- Where did it stop?
- What needs Tom now?
- Where does new work go?

Workstreams also keeps that organization current as work happens, without manual
"Analyze" or "Organize" runs.

Workstreams has four responsibilities:

1. **Organize** threads into products (native BB sections) and keep them there.
2. **Route** new work: continue an existing thread, start a thread in a product,
   or start a new product.
3. **Equip** task threads to delegate subtasks and hand off out-of-scope
   requests.
4. **Show** state through the sidebar thread list, the Workstreams page, and
   per-thread banners.

## 2. Non-goals

- Manager threads as a special role, a Dispatch or intake thread, or any
  hard-coded product, project, or thread.
- Retroactive fork, split, or compaction of threads.
- Generated banner art and AI group summaries.
- Hidden helper threads. Workstreams ignores them everywhere.
- Moving a thread between BB projects. BB does not support it.
- Mutating state through the DOM or CSS outside supported plugin slots.

## 3. BB primitives

Everything Workstreams does is expressed in these primitives. This table records
what BB allows. Rows marked _(spike)_ were verified against BB 0.44 / SDK
0.5.29.

| Primitive       | Meaning                                                                                                                              | Mutable after creation                      | Facts that constrain Workstreams                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine         | An execution host                                                                                                                    | —                                           | Currently one machine (`Vercel MBP`).                                                                                                                                                                                                                                                                                                                                      |
| Project         | A container bound to a source path on each machine. It supplies default environments, `AGENTS.md` and skills, and prompt history.    | Name only. **A thread's project is fixed.** | The personal project means "no project". 22 of 39 active threads share the tomdaleOS checkout, so a project is not a product.                                                                                                                                                                                                                                              |
| Environment     | The working directory a thread runs in: a project checkout (shared), a managed worktree, a personal workspace, or an unmanaged path. | A thread can switch directories.            | **`{ type: "project-default" }` resolves to the project's server-side default, which can be a managed worktree. The native composer can show "Project checkout" for the same project at the same time.** _(spike)_ BB core owns retirement and teardown: after the last live thread is archived or deleted, the worktree is removed asynchronously and the branch is kept. |
| Section         | A **global**, cross-project bucket. A thread has at most one `sectionId`.                                                            | Move, rename, delete                        | The built-in sidebar groups each **tree by its root's section**. Sections have no description or owner.                                                                                                                                                                                                                                                                    |
| Parent / child  | `parentThreadId` (can cross projects). The parent receives child-completion system messages.                                         | Reparent                                    | Each child completion arrives as `[bb system] @thread:X completed: …` and **starts a parent turn**. _(spike)_                                                                                                                                                                                                                                                              |
| Lifecycle owner | Archiving or deleting the owner cascades to the thread.                                                                              | Set at spawn                                | Independent of the parent.                                                                                                                                                                                                                                                                                                                                                 |
| Fork            | `originKind: fork`, `sourceThreadId`                                                                                                 | —                                           | Side chats are hidden forks from `side-chat`.                                                                                                                                                                                                                                                                                                                              |
| Visibility      | `visible` or `hidden`                                                                                                                | Yes                                         | The sidebar hook omits hidden threads. _(spike)_                                                                                                                                                                                                                                                                                                                           |
| Plugin metadata | A per-thread JSON namespace (≤ 256 KiB)                                                                                              | Yes                                         | Any client can write it. Validate it, and never treat it as authorization.                                                                                                                                                                                                                                                                                                 |

**Signals.**

- Events:
  `thread.created/active/idle(lastAssistantText)/failed/archived/unarchived/deleted`,
  `interaction.pending`, `turn.failed`, `message.queued/dispatched/cancelled`,
  and `experimental_thread.events` (the event sequence advanced, coalesced to
  about 1/s).
- The `message.dispatch` hook, which answers proceed, wait, or reject.
- **No event fires for section moves, title changes, reparenting, or section
  create/rename/delete, not even `experimental_thread.events`.** _(spike)_

## 4. Concepts and invariants

| Concept          | Definition                                                                                       | Source of truth                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **Product**      | Exactly one native section                                                                       | BB section, plus a product-map record keyed by `sectionId` |
| **Membership**   | The **root** thread's `sectionId`. Descendants inherit it, and their own `sectionId` is ignored. | BB, plus provenance in plugin state                        |
| **Task thread**  | A visible, non-archived, top-level thread (no parent). A product has any number of them.         | Derived                                                    |
| **Delegate**     | A child of a task thread, created for a separable subtask                                        | BB `parentThreadId` + `lifecycleOwnerThreadId`             |
| **Sibling**      | A task thread spun off from another thread for out-of-scope work                                 | Metadata `spawnedFrom`. This is **not** a parent link.     |
| **Home project** | The code target for work that has no repository                                                  | Setting                                                    |
| **Unsorted**     | Unsectioned roots. A safety valve that is kept near-empty.                                       | Derived                                                    |

**Invariants.** Tests enforce each one.

- **I1. Exactly once.** Every visible, non-archived thread appears once in the
  sidebar. It nests under its parent when the parent is visible and active;
  otherwise it is a root. Orphans and cycles render deterministically.
- **I2. Tree membership.** A tree's product is its root's section. Workstreams
  never writes `sectionId` on a child.
- **I3. Explicit moves only.** A filed thread moves only through one of these:
  - (a) placement at creation, by the router or a tool;
  - (b) an explicit move by the user or an agent;
  - (c) auto-filing of an Unsorted root;
  - (d) an **evolution proposal**, accepted by the user or auto-applied under §9
    policy.

  Analysis alone never moves a thread; it only adds evidence. Every change
  records its provenance:
  `user | router | tool | auto | proposal:<id> | bootstrap`.

- **I4. Placement is fixed at creation.** Project and environment are chosen
  once, at creation, and are always passed **explicitly**. Workstreams never
  relies on `project-default`.
- **I5. Section ownership.** Workstreams deletes only sections it created, and
  only when they are empty in every lifecycle and the user has confirmed.
- **I6. Freshness.** Derived data (recap, state, subject, drift) is keyed to the
  thread's revision. Stale data renders as _pending_, never as current.
- **I7. Journal.** Every mutation is written to the journal (§11.5), with undo
  wherever BB allows it.
- **I8. One projection.** The sidebar and the page render from one pure
  projection function over the same inputs.

## 5. Thread roles and injected behavior

Delegation uses BB's own spawn. Workstreams adds only instructions and one tool,
`workstreams_handoff`, because handoff needs the router and BB has no
equivalent. Both are delivered with `bb.agents.configure` (plus
`bb.agents.registerTool` for handoff). `configure` is synchronous, and its
context contains `thread { id, title, parentThreadId, sourceThreadId }`,
`project`, `environment { path, branchName }`, `origin`, and `pluginMetadata`.
It **does not include `sectionId` or visibility** _(spike)_, so role and product
come from metadata plus a synchronous SQLite cache.

| Thread                      | Tools                 | Instructions (≤ 4096 characters)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task (top-level, visible)   | `workstreams_handoff` | "You are a task thread in **‹product›** (‹one-line description›). Delegate separable subtasks to child threads with `bb thread spawn --parent-self --lifecycle-owner-thread "$BB_THREAD_ID"`, always choosing the environment explicitly: `--new-environment worktree` for code changes, `--environment "$BB_ENVIRONMENT_ID"` otherwise. Then coordinate and integrate here. If the user asks for something outside this thread's task or product, don't do it here: call `workstreams_handoff` with their request verbatim and reply with the link." |
| Delegate (child)            | `workstreams_handoff` | "You are a delegated subtask of ‹parent›. Report results to it. Hand off out-of-scope requests. Don't spawn further threads."                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Hidden, side chat, internal | none                  | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Delegation needs no plugin tool.** BB's spawn already sets the parent,
lifecycle owner, project, and environment (_spike S5_). Workstreams recognizes a
delegate structurally, by its `parentThreadId`, so it doesn't matter how the
child was created (the CLI, the SDK, another plugin). Core retires the child's
environment. The spawn command omits `--section`, so the child inherits its
product through tree membership.

**`workstreams_handoff({ request, note? })`**, also available as
`bb workstreams handoff`, backed by the same function:

- Runs the §6 router with the caller excluded as a target.
- Returns `{ outcome, threadId, link }`.
- Sends the text prefixed with "Handed off from @thread:‹caller›", because
  messages the plugin sends are recorded as `initiator: user` with no sender
  _(spike)_.
- The product map is available through `bb workstreams products`. It is not a
  separate tool, since the router consults the map itself.

**Guards.**

- No handoff back to the caller.
- At most 3 handoffs per turn.
- "Delegates don't delegate" is an instruction, not an enforced rule: BB has no
  hook on thread creation.
- A handoff spawn retries with backoff while the target's new parent is still
  `starting`: spawning a child in that window returns HTTP 500 _(spike)_.

**Timing.** Tools and instructions reach a thread when its provider session next
starts. A running session does not pick them up until it restarts. _(spike:
verified on start)_

**Side quests.** These are handled **prospectively** through handoff. A per-turn
drift flag (§10) is the safety net.

## 6. Intake router

One router serves four entry points:

1. **BB's native New thread composer.** A banner added with
   `app.composer.customize({ scopes: ["new-thread"], banners })` shows the
   proposed route while you type. Proposals are debounced about 600 ms and start
   once the draft reaches about 20 characters.
   - `experimental_setSelection({ projectId, environment })` presets the
     pickers. _(spike: works)_
   - "Send there" sends the draft to the chosen thread, then calls
     `composer.clear()`. _(spike: works)_
   - A plain ⏎ creates the thread through the composer, and the server files it
     using the routing decision passed as
     `experimental_submit({ experimental_data })` / `pluginSubmission`.
   - The banner remounts when the composer scope changes, so its state lives
     outside the component, keyed by scope. _(spike)_
2. **Workstreams ＋ New**, on the page and the sidebar. It embeds
   `experimental_NewThreadComposer` and routes on the server.
3. **`workstreams_handoff`**, called by agents.
4. **`bb workstreams new "<prompt>" [--product] [--project]`**, for scripts.

**Inputs.**

- The prompt.
- Explicit choices: a project the user picked is a strong hint, and `@thread` or
  `@section` mentions short-circuit the router.
- The product map (§7).
- Active task threads (title, product, one-line recap, state, age).

The BB project _name_ is never used as evidence. The prompt hard-codes no
products.

**Decision.** One fast model call (about 1–2 s, about 10K tokens) picks from a
closed set:

```
continue    { threadId }                                       → send with mode "queue-if-active", open it
new-thread  { sectionId, projectId, environment, title }       → spawn top-level, filed
new-product { name, description, projectId, environment, title } → create section + record, then spawn
unsure      { candidates[≤ 3] }                                → show choices
```

Each decision carries `confidence`, a `reason` of at most 120 characters, and a
`subject` (§9).

**Policy.**

- **Always preview. ⏎ accepts.** A `continue` cannot be undone, and a thread's
  project cannot be changed after creation.
- Auto-routing per outcome is a later setting, and the eval must support it
  first.
- Code work goes to the product's primary project, with the product's
  environment policy.
- Non-code work goes to the home project's checkout.
- The router runs as a direct model call in the plugin server, not as an intake
  agent thread.

## 7. Product map

Plugin SQLite, keyed by `sectionId`. The name mirrors BB.

```
{ sectionId, description, descriptionSource: "generated" | "user", aliases[], subjects[],
  projects: [{ projectId, role: "primary" | "secondary", environment: "checkout" | "worktree" }],
  evidence: { repos[], paths[], threadCount, lastActiveAt }, family?, createdBy: "user" | "workstreams", updatedAt }
```

| Event                                  | Update                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Bootstrap                              | Proposal reviewed once (§8)                                                                               |
| A user creates a section in BB         | The reconciler adds a record. The description is generated lazily.                                        |
| The router or a tool creates a product | Section and record, with a description generated from the prompt                                          |
| A thread is filed or created           | Deterministic evidence update                                                                             |
| Evidence changes materially            | Lazy description refresh, **only when `descriptionSource` is `generated`**                                |
| The user edits a product               | The edit always wins (`descriptionSource: user`)                                                          |
| A section is renamed or deleted in BB  | The reconciler mirrors the rename, or drops the record. Former members fall to Unsorted with suggestions. |
| A spin-out is accepted                 | The source description narrows, e.g. "… BB Recap and Workstreams have their own products".                |

## 8. Keeping state current

**One-time bootstrap** (also available as `bb workstreams rebuild`). Target:
under 2 minutes, including review.

1. **Deterministic intake.** Read threads, sections, and the forest. v1's change
   log identifies the filings v1 made automatically; those count as `auto` and
   are re-evaluated. Every other filing counts as `user`.
2. **Map proposal.** One model call proposes merges, renames, retirements,
   descriptions, and project associations.
3. **Review.** Tom reviews the map on one screen.
4. **Assignment.** Closed-set model calls, 8 threads per batch and 4 batches at
   a time, give each root a product, `new`, or `unsure`. This step may use a
   stronger fast model.
5. **Apply.** Preview the diff, then apply it as one journaled, undoable batch.

The bootstrap runs the §9 evolution engine with relaxed thresholds.

**Steady state.**

| Change                                                                                    | Signal                                                               | Reaction                                                                                       |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Thread created through intake or a tool                                                   | RPC or tool call                                                     | Placed by the router (provenance `router` or `tool`)                                           |
| Child created by any source                                                               | `thread.created`                                                     | No structural change. Analyze it on its first idle.                                            |
| Top-level thread created elsewhere (native composer without the banner, CLI, automations) | `thread.created`, then the first `thread.idle`                       | Respect a section that is already set. Otherwise classify it, then auto-file or suggest (§17). |
| Visible fork                                                                              | `thread.created` with `sourceThreadId`                               | Default to the source's product                                                                |
| User sends a message                                                                      | `message.dispatch` (observe and always `proceed`) or `thread.active` | Mark analysis pending. Clear any inferred "needs decision".                                    |
| Turn completes                                                                            | `thread.idle` (`lastAssistantText` included)                         | Per-thread analysis (§10), debounced about 5 s, at most 4 concurrent                           |
| Pending approval or question                                                              | `interaction.pending`                                                | Show in Needs you immediately                                                                  |
| Turn fails                                                                                | `thread.failed` / `turn.failed`                                      | Show an error indicator. No analysis.                                                          |
| Moves, retitles, reparents, section changes                                               | **None**, so the reconciler catches them                             | Record as provenance `user`, never override, update the map                                    |
| Archive, unarchive, delete                                                                | Lifecycle events                                                     | Update views, re-analyze if stale, purge on delete.                                            |
| The plugin was offline                                                                    | Load                                                                 | Full reconcile, then analyze every thread whose revision is newer than its last analysis       |

**Reconciler.** A deterministic diff that calls no model. It runs on load, every
60 s while a client is connected, and on page focus. It pages through
`threads.list` and `threadSections.list`, compares them with plugin records, and
records user moves. It is idempotent.

## 9. Product evolution

The map evolves incrementally as work accumulates. Three kinds of change are
kept separate:

| Kind                 | Example                                    | Mechanism                                               |
| -------------------- | ------------------------------------------ | ------------------------------------------------------- |
| Thread drift         | One thread's work moves to another product | Per-thread drift flag, with Hand off / Move / Dismiss   |
| Map evolution        | A cluster in BB & plugins becomes BB Recap | Product-level proposals                                 |
| Classification noise | The model disagrees with itself            | Suppressed: membership is never re-derived turn by turn |

**Evidence.** Each root carries:

- a `subject`, chosen from the product's existing `subjects[]` when one fits;
- a deterministic `subjectKey` (the repo or package path from its own and its
  children's environments and PRs), which wins when present.

**Proposals.** Defaults use `responsive` sensitivity. `balanced` and
`conservative` are settings.

| Proposal         | Trigger                                                                                                                                                        | Effect                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Spin out         | Within one product, a subject has **≥ 2 roots** in the last 60 days (active or archived), and at least 1 is active. The router can also propose one at intake. | Create a section and record, move the selected roots, narrow the source description |
| Move to existing | A subject matches another product (name, alias, or subject key), with ≥ 1 thread                                                                               | Move the selected roots                                                             |
| Merge            | Small products whose subjects overlap, or the router is repeatedly unsure between them, or the user repeatedly moves threads between them                      | Move all roots into the survivor. Delete the losing section only under I5.          |
| Dormant          | No active threads for 30 days                                                                                                                                  | View rule only: hidden from the sidebar and listed under Dormant on the page        |

**Surfacing.**

- A yellow **floating banner** appears on each affected thread. It is anchored
  below the thread header through `experimental_threadHeaderAction` and a portal
  _(spike: works)_.
  - Pending:
    `✦ This thread and 2 others look like BB Recap work. Spin out a BB Recap product?  [Spin out] [Review…] [Not now]`
  - Applied: `✦ Moved from BB & plugins → BB Recap  [Undo] [OK]`. There is no
    action label or timestamp; the Activity log carries those.
  - The banner collapses to a header pill (`✦ BB Recap?`).
  - It never takes focus.
  - On phone widths only the pill shows.
  - `useSidebarSplitLayout()` returns `null` when the window isn't split, so the
    banner aligns its right edge under the pill and centers over the pane only
    in split view _(spike)_.
- Affected sidebar rows get a small yellow dot.
- The intake preview offers the proposal when it applies.
- The Activity log lists every proposal.
- **Auto-apply.** Proposals whose evidence accumulated outside intake are
  applied automatically, with an Undo banner. The alternative, prompting first,
  is a setting.
- Accepting runs a preflight revision check, applies the change as one journaled
  batch, skips threads that changed and reports them, and can be undone as a
  whole.
- Dismissing snoozes the subject until it gains 2 more threads.

**Anti-churn rules.**

- At most one open proposal per product, and at most 3 globally.
- A thread the user moved in the last 14 days is excluded.
- Every proposal is revalidated when it is shown and when it is applied.
- A model call only names and describes a proposal that has already crossed its
  threshold.

## 10. Per-thread analysis

- **Input:** title, product, the last 1–3 user requests (bounded),
  `lastAssistantText`, and revision. Branch and PR data come from live hooks,
  not the model.
- **Output:**

  ```
  { recap (≤ 140 characters), state: needs_decision | review | blocked | in_progress | done,
    needsYou?: reason, subject, drift?: { productId | newName, confidence } }
  ```

  `drift` is produced for task threads only.

- **Needs you** is either a pending interaction, or `needs_decision` at the
  current revision. A child's question folds into its parent when the parent has
  a newer turn that also needs a decision ("via ‹child›"). The comparison uses
  timestamps only.
- **Model:** a setting. Use the fastest model that passes the eval (candidate:
  Gemini 3.1 Flash-Lite). Changing the prompt or model requires passing the
  private reference set and `eval/delegation.json`. The input never includes the
  BB project name.
- **Cost:** about 1 call per completed turn plus 1 per intake.

## 11. Surfaces

1. **Sidebar thread list** (`experimental_threadList`):
   - A Needs you band (exact-once, live).
   - An optional Recent band (de-duplicated against Needs you).
   - Product groups with plain headers: the name, a needs-you count only when
     above 0, and a total.
   - An Unsorted band, a Dormant fold, and a yellow dot on rows affected by a
     proposal.
   - Rows matching Dockside: BB `indicator` glyph plus a work-state glyph (with
     a legend), provider icon, branch/PR, draft, shortcut pill, unread state,
     nesting, split drag, and the keyboard DOM attributes.
   - Context menu: Move to product… · Rename · Pin · Read/unread · Archive ·
     Delete · Open parent.
2. **Workstreams page** (the Monday-morning view):
   - Products ranked by attention, then by recency.
   - Each product lists "pick back up" rows: title · where it stopped · age.
   - Search with `/`.
   - Tabs for Products (map editor) and Activity.
3. **Thread header:** a parent link (setting), the proposal pill, and the
   floating banner.
4. **CLI:**
   `bb workstreams list | show | new | file | products | log | analyze | rebuild`,
   built with `defineCli`.
5. **Activity log** (page tab and `bb workstreams log`):
   - Covers every change and proposal, newest first, grouped by day.
   - Fields: time, action, affected products and threads (linked), rationale (≤
     120 characters, built from deterministic evidence or the router's reason),
     source, and status (applied · Undo / pending · Review / dismissed / undone
     / partial).
   - Filters by product, action, and needs-review.
   - Retention: 90 days or 2,000 entries.
   - Moves the reconciler detects appear behind a toggle.

## 12. Storage

| Data                                                                                    | Store                                                                    |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Product map, analysis cache, journal and Activity log, proposals, reconciler cursor     | Plugin SQLite (`bb.storage.database()`) with migrations                  |
| Per-thread `{ kind, productAtCreation, spawnedFrom, filedBy, filedAt, filedSectionId }` | Thread plugin metadata, namespace `workstreams`, readable by `configure` |
| Collapse state and UI preferences                                                       | Client local storage                                                     |

v1 tables are left untouched until cutover and are not read after bootstrap.

## 13. Architecture

```
bb-plugin-workstreams/
  src/domain/    tree · project (forest → groups and bands) · attention · rank · evolution · schemas   ← pure; most tests live here
  src/server/    index · map · journal · reconciler · analyzer (idle queue) · router · evolution-runner · inference/{host,pi,prompts} · rpc · cli · agents (tools + configure)
  src/app/       index · useWorkstreams (live hook + one state RPC + realtime) · sidebar/* · page/* · header/* (pill + floating banner) · composer/* (routing banner)
  tests/         domain (real exported snapshots) · server (mock SDK) · app (renderSlot)
```

- Use the current SDK (0.5.29 at the time of writing; v1 was pinned to 0.5.9).
- Keep to about 3K lines of code, excluding tests.

**Carried over from v1:**

- the isolated Pi inference runner (`host.ts` / `pi.ts`);
- bounded context and redaction (`context.ts`);
- the forest algorithm (exact-once, orphans, cycles);
- the eval harness, export and fixture replay, the 32-thread reference set, and
  `eval/delegation.json`.

## 14. Platform findings (spikes, 2026-09-29)

| #   | Question                                                                                   | Result                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Does the live sidebar hook work on a plugin page?                                          | **Yes.** It returned 38 visible threads, 16 sections (including the spike's temporary one), and 14 projects, with fields including `indicator`, `environment`, `lifecycleOwnerThreadId`, and `queuedWork`. Hidden threads are excluded.  |
| S2  | Does a banner in the new-thread composer work, with `setSelection` and clearing the draft? | **Yes.** The scope exposes `projectId`, the picker switched to the requested project, and `clear()` works. The banner remounts when the scope changes, so its state must live outside the component.                                     |
| S3  | What does the `configure` context contain, and does tool and instruction injection work?   | **Yes**, gated by metadata: an injected codeword and tool call succeeded, and threads without the metadata got neither. The context has no `sectionId` or visibility.                                                                    |
| S4  | Is there an event for section, title, or rename changes?                                   | **No**, not even `experimental_thread.events`. A reconciler is required.                                                                                                                                                                 |
| S5  | Can one spawn set section, parent, and lifecycle owner?                                    | **Yes**, but it returns HTTP 500 while the parent is still `starting`. `project-default` provisioned a managed worktree and branch. (Core tears down a worktree after its last thread is deleted, asynchronously, and keeps the branch.) |
| S6  | How does a plugin-sent message appear?                                                     | As `initiator: user` with no sender, and the agent reads it as the user. Child completions reach the parent as system messages that start a turn.                                                                                        |
| S7  | Does a floating banner at the top of the thread work?                                      | **Yes**, using the header action plus a portal. Pane geometry is available only in split view.                                                                                                                                           |

## 15. Process rules

- A single implementation owner works in the `workstreams-v2` worktree.
  Subagents review only.
- Never install from uncommitted work. Develop side by side as
  `workstreams-next`.
- Every phase gate reports:
  - the commit and a clean tree;
  - that the plugin was reloaded;
  - the **selected sidebar provider**;
  - fresh data timestamps;
  - sidebar and page screenshots;
  - what was not verified.
- Requirements stay narrow and testable, and each one lists the interpretations
  it rules out.
- No live mutations outside throwaway fixtures until the bootstrap phase, and
  then only through the journal.

## 16. Phases

| Phase | Scope                                                                                                                        | Gate                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 0     | Freeze v1 (`organize = suggest`, workers idle), worktree, spikes, this spec                                                  | Tom signs off                                                   |
| 1     | Deterministic core: forest and projection, sidebar, Unsorted, reconciler, page skeleton, parent link, journal                | Exact-once tests on a real export. Screenshots. No model calls. |
| 2     | Analysis: idle queue, recap/state/subject, Needs you, eval harness                                                           | Analysis within about 10 s of idle. Passes the eval.            |
| 3     | Bootstrap and evolution: map proposal, review, assignment, evolution engine, floating banner, Activity log                   | Live state organized in under 2 minutes. Undo works.            |
| 4     | Intake: router, native-composer banner, ＋ New, CLI `new`                                                                    | Routing eval on replayed real prompts                           |
| 5     | Task-thread behavior: `configure` instructions, the handoff tool, drift flag; update tomdaleOS agent instructions separately | Handoff and delegate scenarios on throwaway threads             |
| 6     | Cutover: rename to `workstreams`, remove v1                                                                                  | A day of normal use                                             |

## 17. Decisions

**Decided by Tom.**

- Manager threads are replaced by task threads that delegate and hand off.
- Intake is opinionated: continue an existing thread, start a new thread, or
  start a new product.
- No manual or big-bang Analyze or Organize runs.
- The product map evolves incrementally with responsive thresholds (≥ 2 roots in
  60 days, archived included) and is dialed down if it proves disruptive.
- Evolution proposals surface as a yellow floating banner at the top of affected
  threads, with minimal copy.
- The page carries an Activity log of every change and proposal, with timestamps
  and rationale.

**Defaults awaiting confirmation.**

| #   | Question                               | Default                                                                                                                                                      |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | What is a product?                     | A native section                                                                                                                                             |
| D2  | Which intake entry points?             | Native-composer banner, plus ＋ New                                                                                                                          |
| D3  | How is a route confirmed?              | Always preview. ⏎ accepts.                                                                                                                                   |
| D4  | Home project and default environments? | Home project: tomdaleOS. Task threads use the product project's **checkout** (explicit). Delegates choose: `worktree` for code changes, `inherit` otherwise. |
| D5  | Which threads get task instructions?   | All visible top-level threads                                                                                                                                |
| D6  | Who owns a delegate's lifecycle?       | The task thread (archiving the task archives its delegates)                                                                                                  |
| D7  | Which models?                          | A stronger fast model for the bootstrap assignment, and Flash-Lite for steady state (pending the eval)                                                       |
| D8  | Threads created outside Workstreams?   | Auto-filed at high confidence, journaled                                                                                                                     |
| D9  | Evolution outside intake?              | Auto-apply with an Undo banner                                                                                                                               |
| D10 | Recent band?                           | Keep, de-duplicated against Needs you                                                                                                                        |
| D11 | Titles?                                | Auto-title only threads BB left untitled                                                                                                                     |
| D12 | Development strategy?                  | Side by side as `workstreams-next`                                                                                                                           |
| D13 | UI term for a section?                 | "Product"                                                                                                                                                    |
| D14 | Product families?                      | Display-only grouping, off by default                                                                                                                        |
