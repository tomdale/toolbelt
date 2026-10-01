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

Workstreams organizes open threads on explicit request. One model pass proposes
the whole map and placements; the user previews and applies the result. Between
runs, membership stays fixed while recaps and attention indicators stay current.

Workstreams has four responsibilities:

1. **Organize** threads into workstreams (native BB sections) and keep them
   there.
2. **Route** new work: continue an existing thread, start a thread in a
   workstream, or leave the choice unresolved. New work can also suggest a new
   workstream, which is created only when the user accepts it.
3. **Equip** task threads to delegate subtasks and hand off out-of-scope
   requests.
4. **Show** state through the sidebar thread list, the Workstreams page, and
   per-thread banners.

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

| Shape                                                                                                                                                                                    | How Workstreams detects it                                                                                                                                                                        | Shared environment                    | Isolated environment                                                                                                                                                                                                      | Torn down by core                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Git checkout**: the project root is a repository                                                                                                                                       | `environments.listProviders({ projectId })` offers `git-worktree` as available, and a cached host probe (`git rev-parse --show-toplevel`) confirms that the root is the top level of a repository | Project checkout                      | BB managed worktree (`--new-environment worktree`), or a Workforest task checkout attached by path                                                                                                                        | Worktree: yes (the branch is kept). Workforest checkout: no. |
| **Workforest workspace**: the root is a directory of repositories with no root repo, for example `~/Code/Workspaces/vercel-agent/vercel-agent-sdk` (`agents/ api/ front/ integrations/`) | `git-worktree` is unavailable, and the host probe finds no root repository but at least one child repository                                                                                      | Project checkout (the workspace root) | Workforest only: `wf task new <slug> --repo <repo>` for one repository, or `wf new <slug>` for a follow-up workspace across all of them. Attach the result with `--environment <path>`. **BB worktrees are unavailable.** | No. Remove with `wf delete`.                                 |
| **No project**                                                                                                                                                                           | BB's personal project                                                                                                                                                                             | none                                  | A fresh personal workspace (`--new-environment personal`)                                                                                                                                                                 | Yes                                                          |

- Workstreams always passes an environment explicitly. It never relies on
  `project-default` (I4).
- Workstreams itself creates only project-checkout, BB-worktree, and
  personal-workspace environments. It never runs `wf`. Workforest checkouts are
  created by agents following the per-thread instructions (§5) and repository
  instructions, and cleaned up by whoever created them.
- The shape is recomputed when the project's providers or root path change, and
  otherwise cached per project.

## 4. Concepts and invariants

| Concept          | Definition                                                                                                                                                                                                      | Source of truth                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Workstream**   | Exactly one native section                                                                                                                                                                                      | BB section, plus a workstream-map record keyed by `sectionId` |
| **Membership**   | The **root** thread's `sectionId`. Descendants inherit it, and their own `sectionId` is ignored.                                                                                                                | BB, plus provenance in plugin state                           |
| **Task thread**  | A visible, non-archived, top-level thread (no parent). A workstream has any number of them.                                                                                                                     | Derived                                                       |
| **Delegate**     | A child of a task thread, created for a separable subtask                                                                                                                                                       | BB `parentThreadId` + `lifecycleOwnerThreadId`                |
| **Sibling**      | A task thread spun off from another thread for out-of-scope work                                                                                                                                                | Metadata `spawnedFrom`. This is **not** a parent link.        |
| **Home project** | Where work with no code target goes. **Default: none.** Such work goes to BB's personal project ("Don't work in a project") in a fresh personal workspace. The optional `homeProjectId` setting overrides this. | Plugin setting (optional)                                     |
| **Unsorted**     | Unsectioned roots awaiting an explicit placement or organizing run.                                                                                                                                             | Derived                                                       |

**Invariants.** Tests enforce each one.

- **I1. Exactly once.** Every visible, non-archived thread appears in exactly
  one workstream group (Unsorted and Dormant included), or in Snoozed (§11.1).
  It nests under its parent when the parent is visible and active; otherwise it
  is a root. Orphans and cycles render deterministically. Needs you and Recent
  are overlays that repeat rows from the groups; they never replace them, and
  never show snoozed threads.
- **I2. Tree membership.** A tree's workstream is its root's section.
  Workstreams never writes `sectionId` on a child.
- **I3. Explicit moves only.** A filed thread moves only through one of these:
  - (a) placement at creation, by the router (intake or handoff);
  - (b) an explicit move by the user or an agent;
  - (c) Apply on a reviewed organizing preview.

  Analysis alone never moves a thread; it only adds evidence. The one change it
  can lead to is a thread's title, under the retitle policy (§10.1). Every
  change records its provenance:
  `user | router | handoff | auto | proposal:<id> | bootstrap`.

- **I4. Placement is fixed at creation.** Project and environment are chosen
  once, at creation, and are always passed **explicitly**. Workstreams never
  relies on `project-default`.
- **I5. Reviewed cleanup.** Apply may remove previewed unused sections:
  completely empty, or archived-only with the newest archive strictly older than
  24 hours. Any non-archived member, including hidden threads, blocks cleanup.
  Threads are preserved. Undo restores names, metadata and eligible membership
  with fresh native section IDs.
- **I6. Freshness.** Derived data (analysis's summary, state, subject, drift,
  title) is keyed to the thread's revision. Stale data renders as _pending_,
  never as current. An agent recap belongs to the turn that reported it, and
  fresh input clears it (§10.2).
- **I7. Journal.** Every mutation is written to the journal (§11.5), with undo
  wherever BB allows it.
- **I8. One projection.** The sidebar and the page render from one pure
  projection function over the same inputs.

## 5. Thread roles and injected behavior

Workstreams registers one agent tool, `WorkstreamsRecap` (§10.2), for every
thread except side chats. For everything else agents use the `bb` CLI: BB's own
spawn for delegation, and `bb workstreams handoff` for out-of-scope work.
Workstreams contributes the tool and short, per-thread instructions through
`bb.agents.configure`. `configure` is synchronous, and its context contains
`thread { id, title, parentThreadId, sourceThreadId }`, `project`,
`environment { path, branchName }`, `origin`, and `pluginMetadata`. It **does
not include `sectionId` or visibility** _(spike)_, so role and workstream come
from metadata plus a synchronous SQLite cache. Command details live in `--help`
and the generated `plugin-commands` skill, not in the instructions.

| Thread                      | Instructions (≤ 4096 characters)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task (top-level, visible)   | "You are a task thread in **‹workstream›** (‹one-line description›). When the user requests or approves delegating separable subtasks to child threads, use `bb thread spawn --parent-self --lifecycle-owner-thread "$BB_THREAD_ID"`, always choosing the environment explicitly: ‹shape guidance›. Then coordinate and integrate here. If the user asks for something outside this thread's task or workstream, don't do it here: pass their request verbatim to `bb workstreams handoff --request-stdin` and reply with the link it prints." |
| Delegate (child)            | "You are a delegated subtask of ‹parent›. Report results to it. Hand off out-of-scope requests with `bb workstreams handoff`. Don't spawn further threads."                                                                                                                                                                                                                                                                                                                                                                                    |
| Hidden, side chat, internal | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The ‹shape guidance› text depends on the project shape (§3):

- **Git checkout:** "`--new-environment worktree` for code changes;
  `--environment "$BB_ENVIRONMENT_ID"` otherwise."
- **Workforest workspace:** "This project is a multi-repository Workforest
  workspace, and BB worktrees are unavailable. For isolated code changes, create
  a checkout with `wf task new <slug> --repo <repo>` (or `wf new <slug>` for a
  follow-up across the whole workspace), and attach it with
  `--environment <path>`. Otherwise use `--environment "$BB_ENVIRONMENT_ID"`."
- **No project:** "`--environment "$BB_ENVIRONMENT_ID"` to share this workspace,
  or `--new-environment personal`."

**Delegation.** BB's spawn already sets the parent, lifecycle owner, project,
and environment (_spike S5_). Workstreams recognizes a delegate structurally, by
its `parentThreadId`, so it doesn't matter how the child was created (the CLI,
the SDK, another plugin). Core retires the child's environment. The spawn
command omits `--section`, so the child inherits its workstream through tree
membership.

**Handoff:
`bb workstreams handoff (--request <text> | --request-stdin) [--note <text>] [--dry-run] [--json]`**

- Built with `defineCli`. Agents pass the request on stdin (the option's
  `stdin: true` form, `--request-stdin`) with a quoted heredoc, because requests
  are long and the shell would otherwise expand `$(…)` and backticks.
- The caller is `ctx.threadId` (from `BB_THREAD_ID`). The router (§6) excludes
  the caller as a target and records the new thread as `spawnedFrom` the caller.
- Agent handoffs can't use the intake preview, so the policy is:
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
- "Delegates don't delegate" is an instruction, not an enforced rule: BB has no
  hook on thread creation.
- A handoff spawn retries with backoff while the target's new parent is still
  `starting`: spawning a child in that window returns HTTP 500 _(spike)_.

**Timing.**

- The CLI works in running sessions right away.
- The instructions reach a thread when its provider session next starts _(spike:
  verified on start)_.

**Caveat.** The handoff command needs loopback access from the agent's shell. It
works on macOS, including Claude's sandbox, but other providers' sandboxes may
require approval to escalate.

**Side quests.** These are handled **prospectively** through handoff. A per-turn
drift flag (§10) is the safety net.

## 6. Intake router

One router serves three entry points. BB's native New thread composer remains
host-owned; Workstreams contributes its intake UI only inside its own dialog.

1. **Workstreams ＋ New**, on the page and the sidebar. It embeds
   `experimental_NewThreadComposer` unchanged, so it looks and acts like BB's
   New thread view, plus a Workstream field at the start of BB's picker row. The
   field defaults to No workstream, or to the workstream whose ＋ opened the
   dialog, and its search can create a workstream by name. ⏎ starts the thread
   exactly as the pickers show it, filed in the chosen workstream. When typing
   pauses, the router classifies the draft and the dialog shows one suggestion
   under the composer: continue an existing thread, start in an existing
   workstream with its project and environment, or start a new workstream with a
   project and environment. Clicking it, or ⌘⏎ (Ctrl+⏎ elsewhere), accepts it.
   Accepting a thread queues the draft there through the composer's own submit,
   so attachments and mentions travel with it, and closes the dialog. Accepting
   a workstream fills the Workstream, Project and Environment pickers; a new
   workstream is created first. A suggestion the pickers already match is
   hidden, and a dismissed one stays hidden. BB gives plugins no slot in its
   picker row, so the field keeps one anchor element at the row's start and
   falls back to its own row when the row isn't found.
2. **`bb workstreams handoff`**, called by agents (§5).
3. **`bb workstreams new "<prompt>" [--workstream] [--project]`**, for scripts.

**Inputs.**

- The prompt.
- Explicit choices: a project the user picked is a strong hint, and `@thread` or
  `@section` mentions short-circuit the router.
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

- **The user confirms.** In New work a suggestion changes nothing until it is
  accepted, and ⏎ starts what the pickers show. A `continue` cannot be undone,
  and a thread's project cannot be changed after creation.
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
| A section is renamed or deleted in BB | The reconciler mirrors the rename or drops the record; unassigned roots remain Unsorted.     |

## 8. Keeping state current

**Explicit organization** (also available as `bb workstreams rebuild`).

1. Snapshot visible, non-archived threads and existing sections. Build
   root/child trees and include bounded titles, cached recaps and project
   context.
2. One tool-free model response proposes the whole map, descriptions, aliases
   and exactly one assignment per root. Validate the full response before use.
3. Preview the map and placements together. Every root is shown, including those
   staying put. The user can uncheck moves or cancel without changing the map.
4. Apply the saved preview as one journaled batch. Changed map metadata requires
   a fresh preview; threads changed since the snapshot are skipped. Undo
   includes names, new sections, placements, descriptions and aliases.

`rebuild --apply --run-id <startedAt>` applies the reviewed saved preview
without another model call. See
[organizing bounds and criteria](docs/organization.md).

**Steady state.**

| Change                                                                      | Signal                                                                            | Reaction                                                                                                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Thread created through New work                                             | RPC call                                                                          | Filed in the workstream the user chose (provenance `user`)                                                                                   |
| Thread created through `bb workstreams new` or a handoff                    | RPC or CLI call                                                                   | Placed by the router (provenance `router` or `handoff`)                                                                                      |
| Child created by any source                                                 | `thread.created`                                                                  | No structural change. Analyze it on its first idle.                                                                                          |
| Top-level thread created elsewhere (BB's native composer, CLI, automations) | `thread.created`, then the first `thread.idle`                                    | Respect its existing section; otherwise leave it Unsorted.                                                                                   |
| Visible fork                                                                | `thread.created` with `sourceThreadId`                                            | Preserve the creator's placement; otherwise leave it Unsorted                                                                                |
| User sends a message                                                        | `message.dispatch` (proceeds except for stale recap reminders) or `thread.active` | Mark analysis pending. Clear any inferred "needs decision" and the agent recap.                                                              |
| Turn completes                                                              | `thread.idle` (`lastAssistantText` included)                                      | Per-thread analysis (§10), debounced about 5 s, at most 4 concurrent. A reminder if the turn ended without a recap or question card (§10.2). |
| Pending approval or question                                                | `interaction.pending`                                                             | Show in Needs you immediately. A question card ends the turn properly (§10.2).                                                               |
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
names. Features, evaluations, memory work and architecture stay with their
owning product. Substantial independent projects/initiatives can have their own
homes. Existing abstract labels are not authoritative. Surviving homes retain
native section IDs; unused homes qualify for reviewed cleanup under I5 and the
[organization guide](docs/organization.md).

## 10. Per-thread analysis

- **Input:** title, workstream, the last 1–3 user requests (bounded),
  `lastAssistantText`, and revision. Branch and PR data come from live hooks,
  not the model.
- **Output:**

  ```
  { recap (≤ 140 characters), state: needs_decision | review | blocked | in_progress | done,
    needsYou?: reason, subject, drift?: { workstreamId | newName, confidence },
    title?: string (≤ 48 characters) }
  ```

  `drift` is produced for task threads only. `title` is produced for any thread,
  and only when it needs a new one (§10.1). The input marks an untitled thread,
  whose displayed title is BB's placeholder.

- **Needs you** is either a pending interaction, or `needs_decision` at the
  current revision. A child's question folds into its parent when the parent has
  a newer turn that also needs a decision ("via ‹child›"). The comparison uses
  timestamps only.
- **Agent recaps outrank analysis.** While an idle thread has an agent recap for
  its latest turn, the recap's state (complete → `done`, review → `review`) and
  first Latest line replace analysis's state, ask and summary in the sidebar,
  the page, and the CLI.
- **Model:** a setting. Use the fastest model that passes the eval (candidate:
  Gemini 3.1 Flash-Lite). Changing the prompt or model requires passing the
  private reference set and `eval/delegation.json`. The input never includes the
  BB project name.
- **Cost:** about 1 call per completed turn plus 1 per intake.

### 10.1 Titles

Titles go stale: BB generates one only for a first message of five or more
words, never regenerates it, and a thread's focus drifts over its turns. The
per-turn analysis suggests a title when the thread has none, its title is cut
off or too vague to tell it apart, or its latest substantive requests moved onto
different work. Related follow-ups and procedural asks keep the title.

A suggestion is applied when all of these hold:

- the `autoTitle` setting is on (default);
- the thread is still idle at the analyzed revision;
- the title is not **locked**;
- the thread is untitled, or Workstreams has not retitled it in the last hour.

**Ownership.** BB exposes no title provenance and no title event (§3), so
Workstreams records each thread's observed raw title (`ws_title`), from the
reconciler and again just before any retitle. BB's generator only fills an empty
title, so a change from one title to another that Workstreams did not write was
made by the user or an agent. That change locks the title, and so does undoing a
retitle. Clearing a title unlocks it. A title first observed already set is
treated as BB's own.

Each retitle is journaled (`retitle`, provenance `auto`) with Undo, which
restores the previous title while it is still the one Workstreams wrote.

### 10.2 Agent recaps

The thread's own agent reports how each turn ended. Every thread except a side
chat gets the `WorkstreamsRecap` tool and its instructions when its provider
session is constructed, which enrolls the thread for reminders.

- **Endings.** A turn ends with a question card still open (BB's native
  question, or Toolbelt's AskUserQuestion), or with a recap whose state is
  `complete` (the latest request is fully done) or `review` (a finished result
  waits on the user to inspect, test, merge, or ship).
- **Recap.** `goal` (≤ 80 characters), `latest` (1–3 lines, ≤ 120 each),
  `review` (≤ 160, required for review: what to check and the expected result),
  and `links` (≤ 8 absolute file paths or HTTPS URLs). Closing periods are
  dropped.
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
  threads with queued messages, and threads not enrolled get no reminders. When
  the budget runs out, the card says so.
- **Settings.** The Recap section: whether agents end turns with a recap (off
  removes the tool at each session's next start and stops reminders at once),
  reminders per turn, and the card layout (Full, or Minimal without the goal).

## 11. Surfaces

1. **Sidebar thread list** (`experimental_threadList`):
   - A Needs you section (exact-once, live), with a collapsible header and count
     like Recent's, and its rows set apart in a tinted block. Its rows name
     their workstream and omit the needs-decision mark the section already
     implies.
   - An optional Recent band (de-duplicated against Needs you).
   - Workstream groups with plain headers: the name, a needs-you count only when
     above 0, and a total. Groups follow the user's manual order (drag a
     header), else BB's section order, so their positions stay stable. The page,
     not the sidebar, ranks by attention.
   - Drag and drop: a root row drags its whole tree, reordering it within the
     group or moving it to the group it is dropped on (a journaled move, as from
     the context menu). Manual order is plugin state shared across clients;
     unplaced roots sit above placed ones in the default order, and unplaced
     workstreams sit after placed ones.
   - An Unsorted band, a Dormant fold, and a Snoozed fold (collapsed by default,
     §11.1).
   - Rows show BB's `indicator` glyph plus a work-state glyph (with a legend): ✓
     complete and ◇ review from an agent recap, else ◆ decision, ◇ review and ⏸
     blocked from analysis, provider icon, branch/PR, draft, shortcut pill,
     unread state, nesting, split drag, the keyboard DOM attributes, and Snooze
     and Archive buttons on hover.
   - Context menu: Move to workstream… · Rename · Pin · Read/unread · Snooze ›
     (or Wake now) · Archive · Delete · Open parent.
2. **Workstreams page** (the Monday-morning view):
   - Workstreams ranked by attention, then by recency.
   - Each workstream lists "pick back up" rows: title · where it stopped · age.
   - Search with `/`.
   - Tabs for Map (the workstream editor) and Activity.
3. **Thread header:** a parent link (setting) and the snooze split button
   (§11.1).
4. **CLI:**
   `bb workstreams list | show | edit | new | handoff | file | log | analyze | rebuild | trace`,
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
6. **Debug mode** (the `debug` setting, off by default):
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
   - New work instead adds a collapsed Debug section under the composer. It says
     why the suggestion is or isn't showing; shows the route decision (outcome,
     confidence, reason, subject, placement, time) with the server's numbered
     notes on how it was reached (a mention short-circuit, what the model was
     offered and answered, each rewrite such as an unsure answer becoming its
     first candidate, and how the placement was chosen); embeds the decision's
     recorded model call; shows the dialog's state; and lists every
     classification (including superseded ones), acceptance, dismissal,
     workstream choice and submit with its inputs, result or error, and
     duration. Copy diagnostics copies all of it as JSON. The Activity log lists
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
     either way. Nothing is recorded while the setting is off. Retention: 7 days
     or 1,000 traces.

7. **Recap card** (a composer banner): the agent recap's Goal heading, Latest
   lines, a **Review** section with the recap's links, and Archive and Dismiss
   centered underneath. It stays up while the user drafts and hides while a
   message sends or the thread runs, while a question card is open, and in the
   inline message editor; hiding never moves the thread. **Archive** shows when
   the server confirms that the thread and every child and lifecycle dependent
   are idle with no queued work, interactions, background work, unfinished goal
   or pending todos, and that each dependent is complete (its own recap, else
   current analysis); hidden dependents block it. Archiving a review recap
   accepts its result. Continuing the thread withdraws Archive for that recap.
   Workstreams never archives on its own.

### 11.1 Snooze

Snoozing puts a thread away until later. A snoozed thread leaves For you,
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
| Workstream map, saved organizing preview, analysis cache, title ownership, journal and Activity log, reconciler cursor, debug traces | Plugin SQLite (`bb.storage.database()`) with migrations                  |
| Per-thread `{ kind, workstreamAtCreation, spawnedFrom, filedBy, filedAt, filedSectionId }`                                           | Thread plugin metadata, namespace `workstreams`, readable by `configure` |
| Manual order, thread snoozes, Snooze and Recap settings                                                                              | Plugin SQLite, `ws_meta` values                                          |
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
  src/server/    index · map · journal · service · analyzer · router · bootstrap · inference/{host,gateway} · cli · agents
  src/app/       index · useWorkstreams (live hook + one state RPC + realtime) · sidebar/* · page/* · header/* (parent link) · composer/* (New work intake and thread cards)
  tests/         domain (real exported snapshots) · server (mock SDK) · app (renderSlot)
```

- Use the Plugin SDK surface compatible with the installed BB host.
- Keep to about 3K lines of code, excluding tests.

**Current surfaces:**

- the isolated inference runner (`host.ts`), now a direct AI Gateway call
  (`gateway.ts`) with Pi's key: `pi --print --thinking off` sends
  `thinking: disabled`, which the gateway turns into full reasoning for Gemini
  3.1 Flash-Lite (3-10 s per routing call instead of ~1 s);
- bounded context and redaction (`context.ts`);
- the thread-tree builder (exact-once, orphans, cycles);
- the eval harness, export and fixture replay, the 32-thread reference set, and
  `eval/delegation.json`.

## 14. Organization quality

Evaluate the map holistically: recognizable homes, distinct scopes, coherent
membership and useful Unsorted decisions. Use real snapshot replay outside the
public repository. Compare repeated runs for stability and inspect cost/latency;
model confidence alone does not establish useful organization. Background turns
and reconciliation must leave thread membership unchanged.
