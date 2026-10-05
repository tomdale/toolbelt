# Workstreams specification

This document defines the plugin's user-facing contracts. The organizing flow
and its bounds are detailed in [Organizing workstreams](docs/organization.md).

## 1. Purpose

Tom works across dozens of BB agent threads in many repositories and switches
context constantly. Workstreams answers five questions at a glance:

- Which workstream is this work part of?
- What is unfinished?
- Where did it stop?
- What needs Tom now?
- Where does new work go?

Workstreams organizes active threads automatically. Tasks are classified
against the Catalog, then grouped deterministically into workstreams based on
active task counts by product and feature; navigation syncs automatically to BB
native sections without manual placement or preview/apply staging.

Workstreams has five responsibilities:

1. **Maintain** a retained hierarchy of known products and features in the
   Catalog, independently of current navigation.
2. **Organize** threads adaptively into workstreams (native BB sections) and
   keep them there.
3. **Route** new work: recognize products and features from the Catalog,
   suggest a home or continuation, and keep identity selection independent from
   placement.
4. **Equip** threads with question and recap tools and their usage guidance.
5. **Show** state through the sidebar thread list, the Workstreams page
   (Overview, Catalog, Organize, Activity), and per-thread banners.

## 2. Non-goals

- Manager threads as a special role, a Dispatch or intake thread, or any
  hard-coded workstream, project, or thread.
- Retroactive fork, split, or compaction of threads.
- Generated banner art and AI group summaries.
- Hidden helper threads. Workstreams ignores them everywhere.
- Moving a thread between BB projects. BB does not support it.
- Mutating state through the DOM or CSS outside supported plugin slots.
- Grouping workstreams into families. Deferred.

## 3. BB primitives

Everything Workstreams does is expressed in these primitives. This table records
what BB allows. Rows marked _(spike)_ were verified against BB 0.44 / SDK
0.5.29.

| Primitive       | Meaning                                                                                                                              | Mutable after creation                      | Facts that constrain Workstreams                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine         | An execution host                                                                                                                    | —                                           | Currently one machine (`Vercel MBP`).                                                                                                                                                                                                                                                                                                                                      |
| Project         | A container bound to a source path on each machine. It supplies default environments, `AGENTS.md` and skills, and prompt history.    | Name only. **A thread's project is fixed.** | BB's personal project means "Don't work in a project"; its threads run in personal workspaces. 22 of 39 active threads share the tomdaleOS checkout, so a project is not a workstream.                                                                                                                                                                                     |
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

### Project shapes and environments

A project's root is one of three shapes, and each shape allows different
environments.

| Shape                                                                                                                                                                                    | How Workstreams detects it                                                                                | Shared environment                    | Isolated environment                                                                                                                                                                                                      | Torn down by core                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Git checkout**: the project root is a repository                                                                                                                                       | `environments.listProviders({ projectId })` offers `git-worktree` as available                            | Project checkout                      | BB managed worktree (`--new-environment worktree`), or a Workforest task checkout attached by path                                                                                                                        | Worktree: yes (the branch is kept). Workforest checkout: no. |
| **Workforest workspace**: the root is a directory of repositories with no root repo, for example `~/Code/Workspaces/vercel-agent/vercel-agent-sdk` (`agents/ api/ front/ integrations/`) | Provider availability determines supported environments; Workforest owns workspace detection and guidance | Project checkout (the workspace root) | Workforest only: `wf task new <slug> --repo <repo>` for one repository, or `wf new <slug>` for a follow-up workspace across all of them. Attach the result with `--environment <path>`. **BB worktrees are unavailable.** | No. Remove with `wf delete`.                                 |
| **No project**                                                                                                                                                                           | BB's personal project                                                                                     | none                                  | A fresh personal workspace (`--new-environment personal`)                                                                                                                                                                 | Yes                                                          |

- Workstreams always passes an environment explicitly. It never relies on
  `project-default` (I4).
- Workstreams itself creates only project-checkout, BB-worktree, and
  personal-workspace environments. It never runs `wf`. Workforest checkouts are
  created under Workforest and repository guidance, and cleaned up by whoever
  created them.

## 4. Concepts and invariants

| Concept               | Definition                                                                                                                                                                                                                 | Source of truth                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Catalog**           | The retained hierarchy of known **Products** and **Features**, whether or not they have active tasks.                                                                                                                      | Plugin SQLite (`ws_corpus_entity`, `ws_corpus_group`)          |
| **Task identity**     | A task's canonical assignment to a specific Catalog product/feature entity, with status (`assigned` \| `unresolved`) and provenance (`manual` \| `automatic`). Children inherit root semantics.                          | Plugin SQLite (`ws_corpus_subject`)                           |
| **Workstream**        | Exactly one native section representing a current navigation group.                                                                                                                                                        | BB section, plus a workstream record keyed by `sectionId`      |
| **Membership**        | The **root** thread's `sectionId`. Descendants inherit it, and their own `sectionId` is ignored.                                                                                                                           | BB, plus provenance in plugin state                           |
| **Task thread**       | A visible, non-archived, top-level thread (no parent). A workstream has any number of them.                                                                                                                                | Derived                                                       |
| **Delegate**          | A child of a task thread, created for a separable subtask                                                                                                                                                                  | BB `parentThreadId` + `lifecycleOwnerThreadId`                |
| **Sibling**           | A task thread spun off from another thread for out-of-scope work                                                                                                                                                           | Metadata `spawnedFrom`. This is **not** a parent link.        |
| **Home project**      | Where work with no code target goes. **Default: none.** Such work goes to BB's personal project ("Don't work in a project") in a fresh personal workspace. The optional `newWork.homeProjectId` preference overrides this. | Plugin preference (optional)                                  |
| **Unfiled**           | Unsectioned roots awaiting an explicit placement or organizing run.                                                                                                                                                        | Derived                                                       |

**Invariants.** Tests enforce each one.

- **I1. Exactly once.** Every visible, non-archived thread appears in exactly
  one workstream group (Unfiled and Dormant included), or in Snoozed (§11.1). It
  nests under its parent when the parent is visible and active; otherwise it is
  a root. Orphans and cycles render deterministically. Up Next and Recent are
  overlays that repeat rows from the groups; they never replace them, and never
  show snoozed threads.
- **I2. Tree membership and identity.** A tree's workstream is its root's section.
  A tree's task identity is its root's canonical Catalog assignment.
  Children inherit both; Workstreams never writes `sectionId` on a child.
- **I3. Identity and placement independence.** Selecting or correcting a task's
  product/feature identity leaves its section placement unchanged; moving a
  native section preserves its identity.
- **I4. Explicit moves only.** A filed thread moves only through one of these:
  - (a) placement at creation, by the router (intake or handoff);
  - (b) an explicit move by the user or an agent;
  - (c) Apply on a reviewed organizing preview.

  Analysis alone never moves a thread; it only adds evidence. The one change it
  (or the opening-request call that names a new thread) can lead to is a
  thread's title, under the retitle policy (§10.1). Every change records its
  provenance:
  `user | router | handoff | auto | proposal:<id> | bootstrap`.

- **I5. Preview revision safety.** Organization previews snapshot `catalogRevision`.
  Any Catalog mutation (entity rename, reparent, merge, task assignment, or clear)
  increments `catalogRevision`, which marks saved previews as stale (`isStale: true`)
  and safely prevents applying them until regenerated.
- **I6. Placement is fixed at creation.** Project and environment are chosen
  once, at creation, and are always passed **explicitly**. Workstreams never
  relies on `project-default`.
- **I7. Reviewed cleanup.** Apply may remove previewed unused sections:
  completely empty, or archived-only with the newest archive strictly older than
  24 hours. Any non-archived member, including hidden threads, blocks cleanup.
  Threads are preserved. Undo restores names, metadata and eligible membership
  with fresh native section IDs.
- **I8. Freshness.** Derived data (analysis's summary, state, subject, drift,
  goal) is keyed to the thread's revision. Stale data renders as _pending_,
  never as current. An agent recap belongs to the turn that reported it, and
  fresh input clears it (§10.2).
- **I9. Journal.** Every mutation is written to the journal (§11.5), with undo
  wherever BB allows it.
- **I10. One projection.** The sidebar, the page, and the phone Home screen
  render from one pure projection function over the same inputs, and the
  sidebar and Home share their Up Next and group-arrangement rules.
- **I11. Discoveries extend the Catalog.** A classified new identity is anchored
  at its deepest existing ancestor: each segment of its proposed path that names
  an identity already on that path, or an existing child, reuses it rather than
  creating a same-named copy. A proposal whose whole path exists is that
  identity.

## 5. Agent tools and explicit transfers

Workstreams contributes question and recap configuration through
`bb.agents.configure`, independently of parent links, workstream placement, or
project shape. Ordinary threads receive `WorkstreamsRecap` (§10.2) and question
support. Side-chat forks receive question support without recap enrollment.
Internal inference workers receive neither tools nor instructions. Providers
with native question support use that capability; other providers receive the
`AskUserQuestion` tool and its usage guidance.

Workstream membership and parent links support navigation. Repository
instructions and execution plugins own checkout guidance and delegation
behavior. Command details live in `--help` and the generated `plugin-commands`
skill.

**Handoff:
`bb workstreams handoff (--request <text> | --request-stdin) [--note <text>] [--dry-run] [--json]`**

- Built with `defineCli`. Agents pass the request on stdin (the option's
  `stdin: true` form, `--request-stdin`) with a quoted heredoc, because requests
  are long and the shell would otherwise expand `$(…)` and backticks.
- The caller is `ctx.threadId` (from `BB_THREAD_ID`). The router (§6) excludes
  the caller as a target and records the new thread as `spawnedFrom` the caller.
- Agent handoffs can't use the intake preview, so the policy is:
  - A filed caller's workstream is the handoff destination; an unfiled caller
    leaves the destination to the router.
  - `new-thread` acts immediately (journaled, undoable);
  - `continue` acts only at high confidence, and otherwise falls back to
    `new-thread`;
  - `unsure` makes no change: it prints the candidates and exits with a distinct
    code, so the agent can ask the user.
- `--dry-run` prints the route without acting.
- Output is bounded: `{ outcome, threadId, link, workstream, reason }`.
- The sent text is prefixed with "Handed off from @thread:‹caller›", because
  messages the plugin sends are recorded as `initiator: user` with no sender
  _(spike)_.

**Guards.**

- No handoff back to the caller.
- At most 3 handoffs per turn, counted server-side per `ctx.threadId`.
- A handoff spawn retries with backoff while the target's new parent is still
  `starting`: spawning a child in that window returns HTTP 500 _(spike)_.

**Timing.**

- The CLI works in running sessions right away.
- The instructions reach a thread when its provider session next starts _(spike:
  verified on start)_.

**Caveat.** The handoff command needs loopback access from the agent's shell. It
works on macOS, including Claude's sandbox, but other providers' sandboxes may
require approval to escalate.

**Scope changes.** A per-turn drift flag (§10) offers organizational placement
updates. Explicit transfers require a user request or approval; the receiving
thread owns the task and treats the dispatch instruction as fulfilled.

## 6. Intake router

One router serves three entry points. BB's native New thread composer remains
host-owned; Workstreams adds a Product or feature field to it and a
suggestion row.

1. **New work**, in BB's native New thread view. Workstreams' ＋ New work
   buttons (the sidebar's, each workstream's, and the page header's) open
   that view with its prompt focused (`navigate.toCompose`). The view gets
   the field from the plugin's `NewThreadRouting` composer banner, which
   stays inert in any other composer and inside any dialog. The banner builds
   the `NewWork` model and renders the field (`WorkstreamPicker.tsx`,
   `picker-options.tsx`), the suggestion row (`Suggestion.tsx`) and, in Debug
   mode, the Debug section (`NewWorkDebug.tsx`).
   - **Product or feature.** The field identifies the Catalog entity the work
     concerns, independently of navigation: New work never asks for a
     destination workstream, and the coordinator derives section placement
     from active task identities. It starts **Automatic** (✦, the magic
     tint); each classification as typing pauses fills it with the entity the
     router names, or a proposed new feature, and a classification that names
     neither returns it to Automatic. Its searchable list offers Automatic,
     the Catalog, a new feature proposal for the typed name, and
     **Unresolved**; any pick is manual and later classifications leave it
     alone. Choosing Automatic again resumes them. Emptying the draft clears
     an automatic value and keeps a manual one.
   - **Starting the thread.** ⏎ starts the thread with the identity the field
     shows (provenance `manual` or `automatic`; Unresolved is a manual clear).
     BB creates the thread, and the message dispatch hook files the identity
     on its first message and journals "Started from New thread" once per
     thread. The banner attaches the identity as submit data when it sees the
     submit (a click on BB's send button); BB's Enter submits without an event
     a plugin can intercept, so the banner also reports each draft's text and
     identity (`draftIdentity`), and the hook files a first message whose
     text matches a reported draft, in either order of arrival
     (`ComposedDrafts`). A draft naming an entity merged or deleted since is
     left for automatic classification, because its thread already exists.
   - **Send to.** A continue decision changes nothing until accepted, because
     sending to a thread cannot be undone: it shows in the suggestion row as Send to
     with the thread and its workstream, and ⌘⏎ (Ctrl+⏎ elsewhere) from inside
     that composer, its Send button, or a click queues the draft there and
     opens the thread. Attachments are copied to the target thread's project
     first. A dismissed suggestion stays hidden. A
     failed send keeps the draft and shows its error once under the row.
   - **Placement.** BB gives plugins no slot in its picker row, so the field
     keeps one anchor element at the row's start and falls back to its own row
     when the row isn't found. BB's own chips never shrink, so ours gives way
     first: its label ellipsizes down to an icon-wide floor. On a phone (BB's
     compact viewport, `max-width: 767px`) BB's row is full, so the field
     takes a line of its own above the prompt box. The New thread view's
     banner slot sits above the prompt box, so the suggestion row and Debug
     section sit above it too.
   - **Feedback.** The banner announces "Classifying…" beside the field while
     a classification runs, and pulses the suggestion's ✦ while newer text is
     classified.
   - Product and feature marks use a tag icon declared in the manifest (BB's
     icon set has none, and an unknown name draws a lightning bolt).
2. **`bb workstreams handoff`**, called by agents (§5).
3. **`bb workstreams new "<prompt>" [--workstream] [--project]`**, for scripts.

**Inputs.**

- The prompt.
- Explicit choices: a project the user picked in the New thread view is a
  strong hint, and `@thread` or `@section` mentions short-circuit the router.
- The workstream map (§7).
- Active task threads (title, workstream, one-line recap, state, age).

The BB project _name_ is never used as evidence. The prompt hard-codes no
workstreams.

**Decision.** One fast model call (about 1–2 s, about 10K tokens) picks from a
closed set:

```
continue    { threadId }                                       → send with mode "queue-if-active", open it
new-thread  { sectionId, projectId, environment, title }       → spawn top-level, filed
new-workstream { name, description, projectId, environment, title } → create section + record, then spawn
unsure      { candidates[≤ 3] }                                → show choices
```

Each decision carries `confidence`, a `reason` of at most 120 characters, and a
`subject` (§9).

**Policy.**

- **The user confirms.** ⏎ starts what the pickers show: in Automatic mode the
  pickers follow the classification, so the user confirms the destination by
  leaving it alone or overrides it by touching any picker. A `continue` is
  never applied automatically — sending to a thread cannot be undone, and a
  thread's project cannot be changed after creation — so it waits for an
  explicit acceptance.
- New work's suggestion names the single likeliest home. An unsure answer
  becomes its first candidate, empty workstreams are offered too, and code work
  with no project evidence (a workstream without a primary project, or a new
  workstream related to none) leaves the user's project as it is. Only New work
  asks the model for new workstreams.
- Auto-routing per outcome is a later setting, and the eval must support it
  first.
- Code work goes to the workstream's primary project, in its **checkout** by
  default. It gets a BB worktree only when the workstream's policy asks for one
  and the project is a git checkout (§3).
- Non-code work goes to the home project's checkout when one is set, and
  otherwise to BB's personal project in a fresh personal workspace.
- The router runs as a direct model call in the plugin server, not as an intake
  agent thread.

## 7. Workstream map

Plugin SQLite, keyed by `sectionId`. The name mirrors BB.

```
{ sectionId, description, descriptionSource: "generated" | "user", aliases[], subjects[],
  projects: [{ projectId, role: "primary" | "secondary", environment: "checkout" | "worktree" }],  // "worktree" only for git-checkout projects
  evidence: { repos[], paths[], threadCount, lastActiveAt }, createdBy: "user" | "workstreams", updatedAt }
```

| Event                                 | Update                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Bootstrap                             | Proposal reviewed once (§8)                                                                  |
| A user creates a section in BB        | The reconciler adds a record; scope can be edited or supplied by an explicit organizing run. |
| Explicit Create workstream            | Section and record, with a description from the previewed action.                            |
| A thread is filed or created          | Deterministic evidence update                                                                |
| Organization is applied               | Reviewed descriptions and aliases are stored with Undo.                                      |
| The user edits a workstream           | The edit always wins (`descriptionSource: user`)                                             |
| A section is renamed or deleted in BB | The reconciler mirrors the rename or drops the record; unassigned roots remain Unfiled.      |

## 8. Keeping state current

**Explicit organization** (also available as `bb workstreams rebuild`).

1. Snapshot visible, non-archived threads and existing sections. Build
   root/child trees and include bounded titles, cached recaps, and project
   context.
2. Classify tasks missing a stored subject against the Catalog using `classify`.
   Compute concurrent task counts by product and feature. Regroup tasks
   adaptively into workstreams based on capacity and contraction threshold policy
   via `regroup`.
3. Preview the workstreams, specific product/feature identities, and placements
   together. Truthful reasons distinguish classified features from unresolved
   or completed retention. Unresolved threads in existing sections retain their
   homes.
4. Stale preview invalidation: any Catalog mutation (entity rename, reparent,
   merge, task assignment, or clear) increments `catalogRevision`, which marks
   saved proposals stale (`isStale: true`) and safely prevents applying until
   regenerated.
5. Apply the saved preview as one journaled batch. Changed metadata or concurrent
   moves require a fresh preview; threads changed since the snapshot are skipped.
   Undo restores names, new sections, placements, descriptions and aliases.

`rebuild --apply --run-id <startedAt>` applies the reviewed saved preview
without another model call. See
[organizing bounds and criteria](docs/organization.md).

**Steady state.**

| Change                                                                      | Signal                                                                            | Reaction                                                                                                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Thread created through New work (BB's New thread view)                      | `message.dispatch` on its first message                                           | Identity filed as the field showed (§6), journaled as started; the coordinator derives its section                                           |
| Thread created through `bb workstreams new` or a handoff                    | RPC or CLI call                                                                   | Placed by the router (provenance `router` or `handoff`)                                                                                      |
| Child created by any source                                                 | `thread.created`                                                                  | No structural change. Analyze it on its first idle.                                                                                          |
| Top-level thread created elsewhere (CLI, automations, other plugins)        | `thread.created`, then the first `thread.idle`                                    | Respect its existing section; otherwise leave it Unfiled.                                                                                    |
| Visible fork                                                                | `thread.created` with `sourceThreadId`                                            | Preserve the creator's placement; otherwise leave it Unfiled                                                                                 |
| A thread's first message, while it has no title                             | `message.dispatch` (first message); `thread.active` or the reconciler if missed   | Name it from the request alone while its first turn runs (§10.1). Nothing waits on it.                                                       |
| User sends a message                                                        | `message.dispatch` (proceeds except for stale recap reminders) or `thread.active` | Mark analysis pending. Clear any inferred "needs decision" and the agent recap.                                                              |
| Turn completes                                                              | `thread.idle` (`lastAssistantText` included)                                      | Per-thread analysis (§10), debounced about 5 s, at most 4 concurrent. A reminder if the turn ended without a recap or question card (§10.2). |
| Pending approval or question                                                | `interaction.pending`                                                             | Show in Up Next immediately. A question card ends the turn properly (§10.2).                                                                 |
| Turn fails                                                                  | `thread.failed` / `turn.failed`                                                   | Show an error indicator. No analysis.                                                                                                        |
| Moves, retitles, reparents, section changes                                 | **None**, so the reconciler catches them                                          | Record as provenance `user`, never override (a retitle locks the title, §10.1), update the map                                               |
| Archive, unarchive, delete                                                  | Lifecycle events                                                                  | Update views, re-analyze if stale, purge on delete.                                                                                          |
| The plugin was offline                                                      | Load                                                                              | Full reconcile, then analyze every thread whose revision is newer than its last analysis                                                     |

**Reconciler.** A deterministic diff that calls no model. It runs on load, every
60 s while a client is connected, and on page focus. It pages through
`threads.list` and `threadSections.list`, compares them with plugin records, and
records user moves. It is idempotent.

## 9. Stable membership

Turn completion, cached-analysis changes, timers and reconciliation do not
create sections or move roots. Explicit organizing considers the whole map (§8);
New work classifies against that applied map (§6). Manual moves and edits remain
available. Dormancy and snooze change presentation, not membership.

The organizer defaults to concrete products/projects with simple recognizable
names. Owners with 4+ roots in two or more capability clusters split into 2–3
areas in `<Product>: <Area>` format, formatted distinctly in the UI. Features,
evaluations, memory work and architecture stay with their owning product.
Substantial independent projects/initiatives can have their own homes. Existing
abstract labels are not authoritative. Surviving homes retain native section
IDs; unused homes qualify for reviewed cleanup under I5 and the
[organization guide](docs/organization.md).

## 10. Per-thread analysis

- **Input:** title, previous goal, workstream, the last 1–3 user requests
  (bounded), `lastAssistantText`, and revision. Branch and PR data come from
  live hooks, not the model.
- **Output:**

  ```
  { recap (≤ 140 characters), state: needs_decision | review | blocked | in_progress | done,
    needsYou?: reason, subject, drift?: { workstreamId | newName, confidence },
    goal?: string (≤ 60 characters) }
  ```

  `drift` is produced for task threads only. `goal` is produced for any thread:
  what the thread is for, which is also its title (§10.1). A goal over the cap
  is dropped rather than cut, and the thread keeps its previous goal. The input
  marks an untitled thread, whose displayed title is BB's placeholder.

- **Needs you** is either a pending interaction, or `needs_decision` at the
  current revision. A child's question folds into its parent when the parent has
  a newer turn that also needs a decision ("via ‹child›"). The comparison uses
  timestamps only.
- **Agent recaps outrank analysis.** While an idle thread has an agent recap for
  its latest turn, the recap's state (complete → `done`, review → `review`,
  waiting → `in_progress`) and first line (the first async task while waiting,
  else the first Latest line) replace analysis's state, ask and summary in the
  sidebar, the page, and the CLI.
- **Model:** the `threads.analysisModel` preference, for analysis and for the
  opening title call (§10.1). Gateway-backed choices use a direct completion
  from the selected analysis machine. Other provider choices run in a hidden BB
  worker thread. Model changes require passing the private reference set and
  `eval/delegation.json`. The input never includes the BB project name.
- **Cost:** about 1 call per completed turn plus 1 per intake, and 1 small call
  per new thread (§10.1).

### 10.1 Titles

A thread's title is its goal: one phrase of 3–8 words, in sentence case with no
closing period, at most 60 characters, saying what the thread is for. It names
the durable larger outcome, so it outlasts implementation details, procedural
asks, related follow-ups, and side questions. Workstreams infers the goal and
writes it to BB as the thread's title, so the sidebar rows, the thread heading,
Overview, Up Next, Activity, recap cards, and the CLI name a thread with one
string. While a thread has no title, they all show BB's placeholder, the opening
words of its first request.

Every analysis is given the thread's title and its previous goal. It reuses a
title that already states the goal, keeps the previous goal through the thread's
ordinary course, and replaces it only when the objective or scope genuinely
changes or the goal is too vague or cut off to tell the thread apart. A better
wording of the same objective is no reason to change it.

A goal becomes the title when all of these hold:

- the `threads.autoTitle` preference is on (default);
- the goal differs from the title the thread shows;
- the title is not **locked**;
- the thread is still idle at the analyzed revision;
- the thread is untitled or provisionally titled, or Workstreams has not
  retitled it in the last hour.

**Opening title.** A turn can run for an hour before analysis names the thread,
so the thread's first request names it. When BB admits a thread's first message
(`message.dispatch`), one small call sees the opening request alone, with no
assistant text, and returns a goal, or none when the request doesn't say what
the work is (a greeting, a bare "continue"). The goal is applied at once, while
the first turn runs, as a **provisional** title, journaled like any retitle.

- It runs for a visible, unarchived thread that has no title of its own and
  whose turns have not been analyzed, while `autoTitle` is on and the title is
  not locked. Hidden threads (workers, side chats) are never named. A title that
  appears first, from BB's generator, the user, or an agent, is never replaced,
  including one that appears while the call runs.
- It never delays the turn. The hook only schedules the call, which uses the
  `threads.analysisModel`, gives up after 15 s, and is one of at most four at a
  time; a thread that finds them busy is named when it becomes active, or by its
  analysis. A call that fails or times out is logged and dropped, and the thread
  keeps BB's placeholder until its first analysis. A thread is tried once per
  run.
- A thread whose dispatch this run never saw (the plugin loaded mid-turn, or the
  hook missed it) is named the same way from its recorded first request, on
  `thread.active` or when the reconciler finds it running with no title.
- The goal is discarded if the thread's revision has advanced when the call
  returns, because its first turn has ended and that turn's analysis names it.
- The analysis of the first finished turn replaces a provisional title with its
  goal whatever the hour's cooldown says, and settles it when the goal is the
  same. From then on it is an ordinary Workstreams title.

**Adoption.** A thread analyzed before goals were titles has a stored goal and
no title. Once, on the first reconciliation that sees threads while `autoTitle`
is on, each idle, visible, unlocked thread with no title of its own and a stored
goal of at most 60 characters is given that goal as its title through the
ordinary retitle policy: a thread that has moved on since its analysis waits for
its next one. Each is a journaled `retitle` with Undo, the rationale saying it
came from the stored goal. A pass that finds no threads, or runs with `autoTitle`
off, is not spent, and one that met a BB failure is repeated. `ws_meta` records
the finished pass as `goal_titles_adopted`.

**Ownership.** BB exposes no title provenance and no title event (§3), so
Workstreams records each thread's observed raw title (`ws_title`), from the
reconciler and again just before any retitle. BB's generator only fills an empty
title, so a change from one title to another that Workstreams did not write was
made by the user or an agent. That change locks the title, and so does undoing a
retitle. Clearing a title unlocks it. A title first observed already set is
treated as BB's own. A provisional title is Workstreams' own, flagged
`provisional` on its `ws_title` row until the first analysis settles it or
anyone else changes or clears it.

Each retitle is journaled (`retitle`, provenance `auto`) with Undo, which
restores the previous title while it is still the one Workstreams wrote. The
rationale says which retitle it was: from the opening request, after the first
turn, from the stored goal, from another title, or of an untitled thread.

### 10.2 Agent recaps

The thread's own agent reports how each turn ended. Every thread except a side
chat gets the `WorkstreamsRecap` tool and its instructions when its provider
session is constructed. `configure` also runs on turn submits and can't tell
them from session starts, so a thread gets reminders only while it has the tool
selected and its session demonstrably has it: the thread was created after
agents started getting the tool (first load, or recaps turned back on), or its
agent has called the tool. A fork carries on its source's session, so the first
thread in its fork chain must meet the creation test; an unreadable chain fails
it.

- **Endings.** A turn ends with a question card still open (BB's native
  question, or Workstreams' own AskUserQuestion), or with a recap whose state is
  `complete` (the latest request is fully done) or `review` (a finished result
  waits on the user to inspect, test, merge, or ship), or `waiting` (an async
  task is running and the agent needs its result; shown as Waiting).
- **Recap.** `goal` (≤ 80 characters; past tense for complete and review, "-ing"
  while waiting), `latest` (finished results for complete and review, 1–3 lines,
  ≤ 120 each), `review` (1–3 steps, ≤ 160 each, required for review: what to
  check and the expected result), and `links` (≤ 8 absolute file paths or HTTPS
  URLs, optional in review only and limited to artifacts or pages explicitly
  being reviewed). `next` (1–3 user messages, complete and review only) renders
  as full sentence-case labels on neutral, unfilled buttons. Use
  `{ title, message, description? }` for a very short label (≤ 28 characters),
  exact message to send, and optional longer explanation shown on hover or in
  the menu; strings remain supported for simple actions. Labels are never
  truncated. If they would wrap or overflow, Workstreams replaces the buttons
  with one action menu. Clicking sends the message verbatim. Items in `latest`
  and `review` accept strings or `{ text, detail }` objects (legacy
  `{ step, expect }` is also accepted as an alias). `detail` is optional
  secondary text shown as a bulleted subrow. Separate items render as a list;
  review items are numbered. A single string counts as one item. Keep distinct
  results in separate items rather than joining them with semicolons. UI review
  steps explain how to reach and exercise the UI; source links qualify when
  source review is requested. Waiting recaps use the required `goal` as their
  short async task description (≤ 80 characters) and require `timeout` (an
  integer from 1 to 86400 seconds), and omit latest, review, links, and next.
  The deadline is the recap timestamp plus the timeout. Timers recover on plugin
  reload. At expiry, a durable reservation permits one agent-only status prompt
  if the recap and turn are still current and the thread is idle, visible,
  unarchived, and has no queued work. Dispatch validates the recap and turn
  again to cancel prompts racing fresh input. Complete recaps have no links.
  Text fields are inline Markdown (code, emphasis, links, `@thread:<id>`
  mentions as chips, commit hashes shortened with copy on click, through BB's
  Markdown renderer); limits count visible text, and the sidebar shows the first
  line as plain text. Closing periods are dropped. The card shows a single
  Latest line or Review step as plain text and several as a list. A file link
  opens in the thread's workspace when its path is inside it, else on the
  environment's host.
- **Timeline row.** The tool call stays in the thread as a tinted row titled
  Recap, whose output is the recap as short Markdown, so the recap remains
  readable after the conversation moves on. BB renders plugin tool rows with
  fixed titles and looks up custom row renderers by the thread's provider
  plugin, so the state and goal appear only in the expanded row.
- **Currency.** A recap is stored with the turn that reported it. Any fresh
  input (`message.dispatch` other than a reminder) clears it, so a stored recap
  always describes the latest turn. Dismissing hides the card on every client
  and keeps the recap's sidebar state.
- **Reminders.** BB has no completion veto, so the turn's final reply is already
  visible. On `thread.idle` after a completed turn that ended with neither,
  Workstreams sends an agent-only reminder, up to a configurable number per turn
  (default 3, 0–10). The budget persists in SQLite, is reserved before sending,
  and resets on fresh input. Each reminder carries an epoch and token that
  `message.dispatch` checks, so input that arrived first rejects it; a queued
  reminder is recognized by a text marker because submission metadata is
  transient. Failed and interrupted turns, hidden, archived, and busy threads,
  threads with queued messages, and threads without the tool get no reminders.
  When the budget runs out, the card says so.
- **Settings.** Feature-grouped preferences are stored in plugin storage and
  edited in Workstreams' settings sections. Recap settings remain in the Recap
  section: whether agents end turns with a recap (off removes the tool at each
  session's next start and stops reminders at once), reminders per turn, and the
  card layout (Full or Compact; Compact is stored as `minimal`), and optional
  `#rrggbb` colors for commit hash digits and letters (unset follows the theme).

## 11. Surfaces

1. **Sidebar thread list** (`experimental_threadList`):
   - The Up Next section: threads that need you (exact-once, live), plus unread
     complete or review results, in an always-open amber block of five rows with
     Show more. Its rows name their workstream and omit the needs-decision mark
     the section already implies. The open thread's row stays through read and
     status updates, and past the five-row limit, until the user selects another
     thread; hiding, archiving, and snoozing still remove it at once.
   - Prioritized workstreams pin directly below Up Next, in manual order, and
     never go dormant. The header's flag button toggles priority: it appears on
     hover, and stays shown, filled, on a prioritized workstream as its mark.
     The header menu's Prioritize and `bb workstreams prioritize` do the same.
     While any workstream is prioritized, the other workstreams, Unfiled, and
     Dormant are hidden behind a subtle "Show lower priority workstreams"
     link-style toggle directly below the prioritized ones (Recent follows it).
     Revealing shows them all collapsed; expansions there are per reveal and
     never touch their stored collapse state. While any prioritized workstream
     has a thread in Up Next, Up Next shows only prioritized threads (focus):
     the toggle shows a neutral count of the threads it leaves out, and other
     groups' waiting counts turn neutral. With no prioritized thread waiting, Up
     Next shows every waiting thread. Focus never takes away the open thread's
     row; it leaves once the user selects another thread. Priorities are view
     state, stored with the manual order and shared across clients.
   - An optional Recent band (de-duplicated against Up Next).
   - Workstream groups with plain headers: the name, a needs-you count only when
     above 0, and a total. Groups follow the user's manual order (drag a header;
     prioritized and other workstreams reorder within their own tier), else BB's
     section order, so their positions stay stable. The page, not the sidebar,
     ranks by attention.
   - Motion: rows and bands entering or leaving Up Next open and close their
     height, so the list below slides rather than jumps, and a priority change
     glides the workstreams to their new places. A leaving row is inert. Reduced
     motion applies every change at once.
   - Drag and drop: a root row drags its whole tree, reordering it within the
     group or moving it to the group it is dropped on (a journaled move, as from
     the context menu). Manual order is plugin state shared across clients;
     unplaced roots sit above placed ones in the default order, and unplaced
     workstreams sit after placed ones.
   - Unfiled, a virtual group of unsectioned roots, after the populated
     workstreams and before the empty ones; it shows only while it has threads.
     The CLI accepts `unfiled` (or `unsorted`) for it.
   - A Dormant fold and a Snoozed fold (collapsed by default, §11.1).
   - Rows show BB's `indicator` glyph plus a work-state glyph (with a legend): ✓
     complete, ◇ review and ↻ waiting from an agent recap, else ◆ decision, ◇
     review and ⏸ blocked from analysis, provider icon, branch/PR, draft,
     shortcut pill, unread state, nesting, split drag, the keyboard DOM
     attributes, and Snooze and Archive buttons on hover.
   - Context menu: Move to workstream… · Rename · Pin · Read/unread · Snooze ›
     (or Wake now) · Archive · Delete · Open parent.
2. **Workstreams page** (the Monday-morning view):
   - Workstreams ranked by attention, then by recency.
   - Each workstream lists "pick back up" rows: title · where it stopped · age.
   - Search with `/`.
   - Tabs for Overview, Catalog, Organize, and Activity.
3. **Thread header:** a parent link (preference), the task's Product/Feature identity badge, the snooze split button
   (§11.1), and an icon-only Archive button (preference, on by default). The button archives through BB's own
   flow (`experimental_useSidebarThreadActions().archive`), exactly as the sidebar row's Archive does: BB confirms
   first when child threads will be archived too, shows its Undo toast, and moves off the thread. Unlike the recap
   card's Archive (item 7), it requires no recap and no completion evidence. It shows for any thread in BB's active
   list. Above the timeline, the **thread heading** shows the thread's workstream and its title, the string every
   other surface shows (§10.1), with the current recap's goal beneath when that adds to the title. Scrolled away from
   the newest message, it collapses into the title bar in place of BB's own title when there is room, and otherwise
   stays pinned at the top of the timeline.
4. **CLI:**
   `bb workstreams list | show | edit | prioritize | new | handoff | file | log | analyze | rebuild | trace | catalog (list | show | create | edit | reparent | merge) | task (show | assign | clear | reclassify)`,
   built with `defineCli`.
5. **Activity log** (page tab and `bb workstreams log`):
   - Covers every change and proposal, newest first, grouped by day.
   - Fields: time, action, affected workstreams and threads (linked), rationale
     (≤ 120 characters, built from deterministic evidence or the router's
     reason), source, and status (applied · Undo / pending · Review / dismissed
     / undone / partial).
   - Filters by workstream, action, and needs-review.
   - Retention: 90 days or 2,000 entries.
   - Moves the reconciler detects appear behind a toggle.
6. **Debug mode** (the `advanced.debug` preference, off by default):
   - Every model call records a trace: kind, model, timing, token usage, the
     system prompt and prompt exactly as sent, the structured input (redacted,
     long strings bounded), the model's reasoning summary when it returns one,
     the raw response, the parsed result, and what Workstreams did with it. A
     response that fails to parse is recorded as invalid, and a failed call as
     failed. Calls never request reasoning; a model that returns a reasoning
     summary anyway has it recorded. A call aborted because its draft changed is
     not recorded.
   - Links tie traces to threads, journal entries and organizing runs. Analysis
     results and routing decisions carry their own trace ID.
   - Each surface that shows a model's decision gets a small inspect button that
     opens a side pane with those calls: the thread header, Activity entries,
     the organizing review, generated descriptions, Overview rows, and the
     sidebar row menu.
   - New work instead adds a collapsed Debug section to the New thread
     composer (§6). Its
     summary names the decision and whether the suggestion shows. Open, it shows
     the result (outcome, confidence, project and environment, the reason), the
     inputs the model was given (the request, the selected workstream, the
     project hint, how many workstreams and threads were offered, the model and
     its time), the server's numbered notes on each deterministic step (a
     mention short-circuit, the model's raw answer, each rewrite such as an
     unsure answer becoming its first candidate, and where the placement came
     from), and, collapsed, the exact prompt and raw response. Copy diagnostics
     copies that with New work's state and its log of classifications,
     acceptances and identity choices as JSON. The Activity log lists
     each call in place among the changes, with a one-line summary of what the
     model decided (or why it failed) and a "Model calls" filter. Debug-only
     Activity controls filter calls by kind and failures, show the count and
     cost of visible calls, load older traces, and clear traces without deleting
     journal entries. Model rows use a quiet surface tint and Model badge, and
     show an event name, subject, and labeled assessment, distinct from applied
     changes. Related threads use BB-style thread-reference pills with
     host-owned link navigation. Information buttons explain event and lifecycle
     terms on hover and keyboard focus. Model, duration, token usage, and cost
     appear under collapsed Technical details. Journal change status is separate
     from assessed thread state; raw JSON is a nested disclosure. There is no
     separate Debug tab; `debug` page links open Activity.
     `bb workstreams trace` prints recorded calls.
   - "Run again" sends a recorded prompt to its model again and records the
     answer as a replay of the original. A replay changes nothing Workstreams
     stores.
   - Tracing never changes behavior: the same prompt goes to the same model
     either way. Nothing is recorded while the preference is off. Retention: 7
     days or 1,000 traces.

7. **Recap card** (a composer banner), in its state's accent (blue for review,
   green for complete, violet for waiting) on its border, background, state
   line, and row labels: a state line (Ready for Review, Complete, or Waiting),
   with the Waiting label; the Goal heading, then rows by layout. Full: while
   waiting, `goal` as the title, one row per awaited agent (provider icon with
   a live status dot, thread title, and task, linking to the agent thread),
   and a footer reading "Next check in m:ss" over a draining rule. Dismissing
   a waiting card cancels its scheduled nudge durably, so a restored card
   reads "Check cancelled"; results alone when complete; Done (check-marked) and Review (the
   requested checks, with optional review-target Links as chips under their
   steps) for review; labels stack above their rows on narrow cards. Compact
   uses smaller type and spacing and one unlabeled row: the task title while
   waiting, results when complete, review steps and links for review. A dismiss
   ✕ sits in the top-right corner. Archive, when it applies, sits at the right
   of a footer strip in Full and as an icon-only button beside ✕ in Compact. It
   stays up while the user drafts and hides while a message sends or the thread
   runs, while a question card is open, and in the inline message editor; hiding
   never moves the thread. **Archive** is unavailable for waiting recaps. For
   complete and review it shows when the server confirms that the thread and
   every child and lifecycle dependent are idle with no queued work,
   interactions, background work, unfinished goal or pending todos, and that
   each dependent is complete (its own recap, else current analysis); hidden
   dependents block it. Archiving a review recap accepts its result. Continuing
   the thread withdraws Archive for that recap. Workstreams never archives on
   its own.

8. **Phone Home screen** (`homepageSection`): on a phone BB's new-thread view
   is its composer pinned to the bottom under a flat Recent list. The section
   takes that list's place with the sidebar's rules over the one projection
   (I10), and no state of its own beyond what the user opened:
   - **Up Next** first, in the sidebar's amber block: the sidebar's membership
     (threads waiting on the user, then threads whose agent left a recap, newest
     first), prioritized focus, and five-row limit with Show more. A row is at
     least 56px: BB's status mark or the work-state mark (the needs-decision
     mark is implied and left out), the thread's BB display title, never the
     analysis goal, its workstream in the workstream's hue, what it asks, its
     age, and an unsent-draft mark. A tap opens the thread in place. A row's
     accessible name is its content (mark, title, workstream, ask, the age
     spelled out), and a header's counts are stated in words.
   - **Workstreams** below, from the same arrangement as the sidebar:
     prioritized workstreams first, the others in the Sidebar sort setting, then
     Unfiled (marked by a hollow ring in place of the workstream's dot), a
     Dormant fold, and a Snoozed fold listing wake times. While any workstream
     is prioritized the rest wait behind Show lower priority workstreams, which
     counts the waiting threads Up Next left out. Workstreams with no threads
     and the Archived fold are left off. A group's 48px header opens and closes
     it and carries the waiting and thread counts as the Sidebar settings choose
     (Always, When collapsed, Never); rows are 48px; a thread with children has
     a trailing count that folds them; headers stay stuck to the top of the
     scroll area while their rows pass. Groups start closed except prioritized
     workstreams and the only workstream there is. Expand all and Collapse all
     switch every shown group. Open state is local to the device and kept in its
     own store (`workstreams:v1:home`), apart from the sidebar's, because a
     phone mounts both lists at once.
   - Settings: Up Next, Snoozed, Timestamp (ages show for Always only: a phone
     has no hover), Thread count, Waiting count and the sort order apply.
     **Home screen** (`sidebar.phoneHome`, default on) turns the section off and
     restores BB's list. Type uses BB's `--text-*` tokens and every control is
     at least 44px tall.
   - **Placement.** BB offers no slot to replace its Recent list or resize its
     scroll viewport, so the section reads where it mounted (`home/layout.ts`):
     - `takeover`, inside BB's compact home scroll viewport
       (`[data-testid="root-compose-compact-scroll-viewport"]`): a stylesheet
       (`home/home.css`), scoped by `:has()` to the section being mounted
       there, hides BB's Recent list and the spacer above it, lifts the
       viewport to just under the top controls (56px, BB's own minimum, over
       its inline `top`, which BB rewrites on resize; BB's shell already pads
       the safe-area inset), starts the content at the top, and hides BB's
       heading for the section. BB's own bottom spacer keeps the last row clear
       of the composer.
     - `inline`, in a narrow window where that viewport isn't found (BB's
       markup changed, or its empty welcome shows), or when threads fail to
       load: the section renders below BB's list, changes none of BB's markup,
       and hides only BB's heading.
     - `hidden`, in wide windows, with the preference off, or with nothing to
       list: the section renders nothing and hides BB's heading for it.
     - Until the thread list, the preferences and the plugin's state have all
       arrived (or three seconds pass), the takeover shows a placeholder: the
       first frame is never drawn from defaults, and BB's list never flashes. A
       render failure is contained in a boundary that falls back to `hidden`,
       leaving BB's list.
     The stylesheet restyles BB's presentation only; it never changes state.

### 11.1 Snooze

Snoozing puts a thread away until later. A snoozed thread leaves Up Next,
Recent, and its workstream group, taking its descendants with it, and is listed
in the sidebar's Snoozed fold, soonest to wake first, with its wake time. Its
workstream is unchanged.

- **Choices:** 30 minutes · 1 hour · 3 hours · Tomorrow morning · This weekend
  (Saturday morning) · Next week (Monday morning) · Until it updates · Pick a
  date and time…. Times are the client's local clock; morning is a setting
  (default 9:00), and day choices are never today.
- **One click** applies the default choice (default: Tomorrow morning): the
  row's hover snooze button, the face of the thread header's split button, and
  the palette's "Workstreams: snooze this thread".
- **Hover menu:** resting the pointer on a row's snooze button for 350 ms opens
  up to four quick choices plus Pick a date and time…, above the button when
  there's room. Passing over the button does nothing; the menu survives 200 ms
  after the pointer leaves it or the button, so the pointer can travel between
  them. A hover-opened menu never takes focus. From the keyboard, Enter snoozes
  with the default and ArrowDown opens the menu. The context menu's Snooze
  submenu and the header button's arrow list every choice.
- **Settings:** the Snooze settings section picks the default, the hover menu's
  choices, and the morning hour. They're stored with the plugin and shared by
  every client.
- **Waking:** a timed snooze ends at its time, whatever the agent does in the
  meantime, and the thread returns marked unread. "Until it updates" ends when
  the thread's `latestAttentionAt` passes its value at snooze time. Every snooze
  also ends when the user sends the thread a message, on Wake now, and on
  archive or delete.
- Snoozes are view state, like the manual order: shared across clients, not
  journaled. The snooze toast's Undo and Wake now reverse them.

BB's own thread menu (the header's `…`) takes no plugin items, so the header
entry point is a Workstreams header action.

## 12. Storage

| Data                                                                                                                                 | Store                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Catalog products and features, task assignments, group bindings, and revision                                                        | Plugin SQLite (`ws_corpus_entity`, `ws_corpus_subject`, `ws_corpus_group`, `ws_meta`) |
| Workstream map, saved organizing preview, analysis cache, title ownership, journal and Activity log, reconciler cursor, debug traces | Plugin SQLite (`bb.storage.database()`) with migrations                  |
| Per-thread `{ kind, workstreamAtCreation, spawnedFrom, filedBy, filedAt, filedSectionId }`                                           | Thread plugin metadata, namespace `workstreams`, readable by `configure` |
| Manual order and prioritized workstreams, thread snoozes, feature-grouped Workstreams preferences, Snooze and Recap settings         | Plugin SQLite, `ws_meta` values                                          |
| Agent recaps and their reminder budgets (§10.2)                                                                                      | Plugin SQLite, `ws_agent_recap`                                          |
| Collapse state and UI preferences                                                                                                    | Client local storage                                                     |

Durable organization consists of the native sections, scope metadata,
placements, organizing preview and journal. Agent recaps and analysis are
per-turn state kept apart from it. Migrations preserve their append-only
statement IDs.

## 13. Architecture

```
bb-plugin-workstreams/
  src/domain/    tree · project (thread trees → groups and bands) · organize · analysis · router · schemas
  src/server/    index · prefs · map · journal · service · analyzer · opening · adopt · router · bootstrap · inference/{host,gateway,worker} · cli · agents
  src/app/       index · useWorkstreams (live hook + one state RPC + realtime) · sidebar/* · home/* (phone Home screen) · page/* · header/* (parent link) · composer/* (New work intake and thread cards)
  tests/         domain (real exported snapshots) · server (mock SDK) · app (renderSlot)
```

- Use the Plugin SDK surface compatible with the installed BB host.
- Keep to about 3K lines of code, excluding tests.

**Current surfaces:**

- the hybrid inference path: gateway-backed choices use the isolated host runner
  and Pi's AI Gateway key; other provider/model choices run in a hidden BB
  worker thread with the selected execution settings;
- bounded context and redaction (`context.ts`);
- the thread-tree builder (exact-once, orphans, cycles);
- the eval harness, export and fixture replay, the 32-thread reference set, and
  `eval/delegation.json`.

## 14. Organization quality

Evaluate the map holistically: recognizable homes, distinct scopes, coherent
membership and useful Unfiled decisions. Use real snapshot replay outside the
public repository. Compare repeated runs for stability and inspect cost/latency;
model confidence alone does not establish useful organization. Background turns
and reconciliation must leave thread membership unchanged.
