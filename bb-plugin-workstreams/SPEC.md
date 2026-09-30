# Workstreams v2 specification

Status: **approved 2026-09-29**. This document defines Workstreams v2, a rewrite
of the Workstreams BB plugin. It is the contract that implementation, tests, and
reviews check against. §17 lists every decision; Tom made or accepted all of
them.

## 1. Purpose

Tom works across dozens of BB agent threads in many repositories and switches
context constantly. Workstreams answers five questions at a glance:

- Which workstream is this work part of?
- What is unfinished?
- Where did it stop?
- What needs Tom now?
- Where does new work go?

Workstreams also keeps that organization current as work happens, without manual
"Analyze" or "Organize" runs.

Workstreams has four responsibilities:

1. **Organize** threads into workstreams (native BB sections) and keep them
   there.
2. **Route** new work: continue an existing thread, start a thread in a
   workstream, or start a new workstream.
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
| **Unsorted**     | Unsectioned roots. A safety valve that is kept near-empty.                                                                                                                                                      | Derived                                                       |

**Invariants.** Tests enforce each one.

- **I1. Exactly once.** Every visible, non-archived thread appears in exactly
  one workstream group (Unsorted and Dormant included). It nests under its
  parent when the parent is visible and active; otherwise it is a root. Orphans
  and cycles render deterministically. Needs you and Recent are overlays that
  repeat rows from the groups; they never replace them.
- **I2. Tree membership.** A tree's workstream is its root's section.
  Workstreams never writes `sectionId` on a child.
- **I3. Explicit moves only.** A filed thread moves only through one of these:
  - (a) placement at creation, by the router (intake or handoff);
  - (b) an explicit move by the user or an agent;
  - (c) auto-filing of an Unsorted root;
  - (d) an **evolution proposal**, accepted by the user or auto-applied under §9
    policy.

  Analysis alone never moves a thread; it only adds evidence. The one change it
  can lead to is a thread's title, under the retitle policy (§10.1). Every
  change records its provenance:
  `user | router | handoff | auto | proposal:<id> | bootstrap`.

- **I4. Placement is fixed at creation.** Project and environment are chosen
  once, at creation, and are always passed **explicitly**. Workstreams never
  relies on `project-default`.
- **I5. Section ownership.** Workstreams deletes only sections it created, and
  only when they are empty in every lifecycle and the user has confirmed.
- **I6. Freshness.** Derived data (recap, state, subject, drift, title) is keyed
  to the thread's revision. Stale data renders as _pending_, never as current.
- **I7. Journal.** Every mutation is written to the journal (§11.5), with undo
  wherever BB allows it.
- **I8. One projection.** The sidebar and the page render from one pure
  projection function over the same inputs.

## 5. Thread roles and injected behavior

Workstreams registers **no agent tools**. Agents use the `bb` CLI, which they
already use for everything else: BB's own spawn for delegation, and
`bb workstreams handoff` for out-of-scope work. Workstreams contributes only
short, per-thread instructions through `bb.agents.configure`. `configure` is
synchronous, and its context contains
`thread { id, title, parentThreadId, sourceThreadId }`, `project`,
`environment { path, branchName }`, `origin`, and `pluginMetadata`. It **does
not include `sectionId` or visibility** _(spike)_, so role and workstream come
from metadata plus a synchronous SQLite cache. Command details live in `--help`
and the generated `plugin-commands` skill, not in the instructions.

| Thread                      | Instructions (≤ 4096 characters)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task (top-level, visible)   | "You are a task thread in **‹workstream›** (‹one-line description›). Delegate separable subtasks to child threads with `bb thread spawn --parent-self --lifecycle-owner-thread "$BB_THREAD_ID"`, always choosing the environment explicitly: ‹shape guidance›. Then coordinate and integrate here. If the user asks for something outside this thread's task or workstream, don't do it here: pass their request verbatim to `bb workstreams handoff --request-stdin` and reply with the link it prints." |
| Delegate (child)            | "You are a delegated subtask of ‹parent›. Report results to it. Hand off out-of-scope requests with `bb workstreams handoff`. Don't spawn further threads."                                                                                                                                                                                                                                                                                                                                               |
| Hidden, side chat, internal | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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
  - `new-thread` and `new-workstream` act immediately (journaled, undoable);
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

One router serves four entry points:

1. **BB's native New thread composer.** A banner added with
   `app.composer.customize({ scopes: ["new-thread"], banners })` shows the
   proposed route while you type. A draft under about 20 characters is routed
   once typing pauses (about 900 ms) and shows only the decision; a longer one
   is routed on a 250 ms debounce. Every change cancels the routing call in
   flight: the banner sends the draft's key with each `route`, and a newer
   `route` or a `routeCancel` for that key aborts the model request.
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
   `experimental_NewThreadComposer` and previews server routing while the draft
   stays editable. Submitting acts on the current preview in the same composer.
   A workstream's ＋ explicitly selects that workstream and skips
   classification. Compact action and labelled destination controls allow
   correction of either choice; labelled Project and Environment controls stay
   visible. Each automatic field carries a solid yellow star. Manual fields
   survive edits and have an individual hollow-star revert, including keyboard
   Delete/Backspace and an Automatic menu option. No workstream is a deliberate
   unassigned destination, distinct from unresolved routing; creation requires a
   chosen or confidently inferred project. Existing-thread placement is locked
   and its execution settings apply; ignored creation controls are hidden.
   Pending, ambiguous and failed routes disable submission before draft
   clearing. The submit label names the current action: Create thread, Send
   message or Create workstream.
3. **`bb workstreams handoff`**, called by agents (§5).
4. **`bb workstreams new "<prompt>" [--workstream] [--project]`**, for scripts.

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

- **Always preview. ⏎ accepts.** A `continue` cannot be undone, and a thread's
  project cannot be changed after creation.
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

| Event                                        | Update                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Bootstrap                                    | Proposal reviewed once (§8)                                                                               |
| A user creates a section in BB               | The reconciler adds a record. The description is generated lazily.                                        |
| The router or a handoff creates a workstream | Section and record, with a description generated from the prompt                                          |
| A thread is filed or created                 | Deterministic evidence update                                                                             |
| Evidence changes materially                  | Lazy description refresh, **only when `descriptionSource` is `generated`**                                |
| The user edits a workstream                  | The edit always wins (`descriptionSource: user`)                                                          |
| A section is renamed or deleted in BB        | The reconciler mirrors the rename, or drops the record. Former members fall to Unsorted with suggestions. |
| A spin-out is accepted                       | The source description narrows, e.g. "… BB Recap and the Workstreams plugin have their own workstreams".  |

## 8. Keeping state current

**One-time bootstrap** (also available as `bb workstreams rebuild`). Target:
under 2 minutes, including review.

1. **Deterministic intake.** Read threads and sections, and build the
   parent/child thread trees. v1's change log identifies the filings v1 made
   automatically; those count as `auto` and are re-evaluated. Every other filing
   counts as `user`.
2. **Map proposal.** One model call proposes merges, renames, retirements,
   descriptions, and project associations.
3. **Review.** Tom reviews the map on one screen.
4. **Assignment.** Closed-set model calls, 8 threads per batch and 4 batches at
   a time, give each root a workstream, `new`, or `unsure`. This step may use a
   stronger fast model.
5. **Apply.** Preview the diff, then apply it as one journaled, undoable batch.

The bootstrap runs the §9 evolution engine with relaxed thresholds.

**Steady state.**

| Change                                                                                    | Signal                                                               | Reaction                                                                                       |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Thread created through intake or a handoff                                                | RPC or CLI call                                                      | Placed by the router (provenance `router` or `handoff`)                                        |
| Child created by any source                                                               | `thread.created`                                                     | No structural change. Analyze it on its first idle.                                            |
| Top-level thread created elsewhere (native composer without the banner, CLI, automations) | `thread.created`, then the first `thread.idle`                       | Respect a section that is already set. Otherwise classify it, then auto-file or suggest (§17). |
| Visible fork                                                                              | `thread.created` with `sourceThreadId`                               | Default to the source's workstream                                                             |
| User sends a message                                                                      | `message.dispatch` (observe and always `proceed`) or `thread.active` | Mark analysis pending. Clear any inferred "needs decision".                                    |
| Turn completes                                                                            | `thread.idle` (`lastAssistantText` included)                         | Per-thread analysis (§10), debounced about 5 s, at most 4 concurrent                           |
| Pending approval or question                                                              | `interaction.pending`                                                | Show in Needs you immediately                                                                  |
| Turn fails                                                                                | `thread.failed` / `turn.failed`                                      | Show an error indicator. No analysis.                                                          |
| Moves, retitles, reparents, section changes                                               | **None**, so the reconciler catches them                             | Record as provenance `user`, never override (a retitle locks the title, §10.1), update the map |
| Archive, unarchive, delete                                                                | Lifecycle events                                                     | Update views, re-analyze if stale, purge on delete.                                            |
| The plugin was offline                                                                    | Load                                                                 | Full reconcile, then analyze every thread whose revision is newer than its last analysis       |

**Reconciler.** A deterministic diff that calls no model. It runs on load, every
60 s while a client is connected, and on page focus. It pages through
`threads.list` and `threadSections.list`, compares them with plugin records, and
records user moves. It is idempotent.

## 9. Workstream evolution

The map evolves incrementally as work accumulates. Three kinds of change are
kept separate:

| Kind                 | Example                                       | Mechanism                                               |
| -------------------- | --------------------------------------------- | ------------------------------------------------------- |
| Thread drift         | One thread's work moves to another workstream | Per-thread drift flag, with Hand off / Move / Dismiss   |
| Map evolution        | A cluster in BB & plugins becomes BB Recap    | Workstream-level proposals                              |
| Classification noise | The model disagrees with itself               | Suppressed: membership is never re-derived turn by turn |

**Evidence.** Each root carries:

- a `subject`, chosen from the workstream's existing `subjects[]` when one fits;
- a deterministic `subjectKey` (the repo or package path from its own and its
  children's environments and PRs), which wins when present. A cached host probe
  resolves paths to repository identity (the remote URL plus the path inside the
  repository). That way the same package matches across every layout:
  - `~/Code/Repos/<repo>/<worktree>/…`
  - Workforest tasks: `…/_tasks/<parent>/<task>/…`
  - Workforest workspaces: `~/Code/Workspaces/<template>/<name>/<repo>/…`
  - BB managed worktrees:
    `~/.bb/plugins/environment-git-worktree/host-data/worktrees/<thread>-N/<repo>/…`

**Proposals.** Defaults use `responsive` sensitivity. `balanced` and
`conservative` are settings.

| Proposal         | Trigger                                                                                                                                                           | Effect                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Spin out         | Within one workstream, a subject has **≥ 2 roots** in the last 60 days (active or archived), and at least 1 is active. The router can also propose one at intake. | Create a section and record, move the selected roots, narrow the source description |
| Move to existing | A subject matches another workstream (name, alias, or subject key), with ≥ 1 thread                                                                               | Move the selected roots                                                             |
| Merge            | Small workstreams whose subjects overlap, or the router is repeatedly unsure between them, or the user repeatedly moves threads between them                      | Move all roots into the survivor. Delete the losing section only under I5.          |
| Dormant          | No active threads for 30 days                                                                                                                                     | View rule only: hidden from the sidebar and listed under Dormant on the page        |

**Surfacing.**

- A yellow **floating banner** appears on each affected thread. It is anchored
  below the thread header through `experimental_threadHeaderAction` and a portal
  _(spike: works)_.
  - Pending:
    `✦ This thread and 2 others look like BB Recap work. Spin out a BB Recap workstream?  [Spin out] [Review…] [Not now]`
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

- At most one open proposal per workstream, and at most 3 globally.
- A thread the user moved in the last 14 days is excluded.
- Every proposal is revalidated when it is shown and when it is applied.
- A model call only names and describes a proposal that has already crossed its
  threshold.

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
   - An Unsorted band, a Dormant fold, and a yellow dot on rows affected by a
     proposal.
   - Rows show BB's `indicator` glyph plus a work-state glyph (with a legend),
     provider icon, branch/PR, draft, shortcut pill, unread state, nesting,
     split drag, the keyboard DOM attributes, and an Archive button on hover.
   - Context menu: Move to workstream… · Rename · Pin · Read/unread · Archive ·
     Delete · Open parent.
2. **Workstreams page** (the Monday-morning view):
   - Workstreams ranked by attention, then by recency.
   - Each workstream lists "pick back up" rows: title · where it stopped · age.
   - Search with `/`.
   - Tabs for Map (the workstream editor) and Activity.
3. **Thread header:** a parent link (setting), the proposal pill, and the
   floating banner.
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
   - Links tie traces to what they explain: threads, journal entries, proposals,
     workstream descriptions, and organizing runs. Analysis results and routing
     decisions carry their own trace id, and a proposal links the analyses whose
     subjects raised it.
   - Each surface that shows a model's decision gets a small inspect button that
     opens a side pane with those calls: the thread header, the drift and
     proposal banners, the routing banner and New work, Activity entries, the
     organizing review, generated descriptions, Overview rows, and the sidebar
     row menu. The Activity log lists each call in place among the changes, with
     a one-line summary of what the model decided (or why it failed) and a
     "Model calls" filter. Debug-only Activity controls filter calls by kind and
     failures, show the count and cost of visible calls, load older traces, and
     clear traces without deleting journal entries. Model rows use a quiet
     surface tint and Model badge, and show an event name, subject, and labeled
     assessment, distinct from applied changes. Related threads use BB-style
     thread-reference pills with host-owned link navigation. Information buttons
     explain event and lifecycle terms on hover and keyboard focus. Model,
     duration, token usage, and cost appear under collapsed Technical details.
     Journal change status is separate from assessed thread state; raw JSON is a
     nested disclosure. There is no separate Debug tab; `debug` page links open
     Activity. `bb workstreams trace` prints recorded calls.
   - "Run again" sends a recorded prompt to its model again and records the
     answer as a replay of the original. A replay changes nothing Workstreams
     stores.
   - Tracing never changes behavior: the same prompt goes to the same model
     either way. Nothing is recorded while the setting is off. Retention: 7 days
     or 1,000 traces.

## 12. Storage

| Data                                                                                                                  | Store                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Workstream map, analysis cache, title ownership, journal and Activity log, proposals, reconciler cursor, debug traces | Plugin SQLite (`bb.storage.database()`) with migrations                  |
| Per-thread `{ kind, workstreamAtCreation, spawnedFrom, filedBy, filedAt, filedSectionId }`                            | Thread plugin metadata, namespace `workstreams`, readable by `configure` |
| Collapse state and UI preferences                                                                                     | Client local storage                                                     |

v1 tables are left untouched until cutover and are not read after bootstrap.

## 13. Architecture

```
bb-plugin-workstreams/
  src/domain/    tree · project (thread trees → groups and bands) · attention · rank · evolution · schemas   ← pure; most tests live here
  src/server/    index · map · journal · reconciler · analyzer (idle queue) · router · evolution-runner · inference/{host,pi,prompts} · rpc · cli · agents (configure instructions)
  src/app/       index · useWorkstreams (live hook + one state RPC + realtime) · sidebar/* · page/* · header/* (pill + floating banner) · composer/* (routing banner)
  tests/         domain (real exported snapshots) · server (mock SDK) · app (renderSlot)
```

- Use the current SDK (0.5.29 at the time of writing; v1 was pinned to 0.5.9).
- Keep to about 3K lines of code, excluding tests.

**Carried over from v1:**

- the isolated inference runner (`host.ts`), now a direct AI Gateway call
  (`gateway.ts`) with Pi's key: `pi --print --thinking off` sends
  `thinking: disabled`, which the gateway turns into full reasoning for Gemini
  3.1 Flash-Lite (3-10 s per routing call instead of ~1 s);
- bounded context and redaction (`context.ts`);
- the thread-tree builder (exact-once, orphans, cycles);
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
- Never install from uncommitted work.
- Rewrite the Workstreams plugin **in place**: same plugin id (`workstreams`),
  settings, and sidebar selection, developed on the `workstreams-v2` branch.
- Each phase gate is installed from that branch and fast-forwarded to `main`.
- Installing Phase 1 replaces v1 live, so v1's recaps and Needs-you inference
  are missing until Phase 2. Rollback is one command: install a v1 checkout by
  path.
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

| Phase | Scope                                                                                                                                | Gate                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 0     | Freeze v1 (`organize = suggest`, workers idle), worktree, spikes, this spec                                                          | Tom signs off                                                   |
| 1     | Deterministic core: thread trees and projection, sidebar, Unsorted, reconciler, page skeleton, parent link, journal                  | Exact-once tests on a real export. Screenshots. No model calls. |
| 2     | Analysis: idle queue, recap/state/subject, Needs you, eval harness                                                                   | Analysis within about 10 s of idle. Passes the eval.            |
| 3     | Bootstrap and evolution: map proposal, review, assignment, evolution engine, floating banner, Activity log                           | Live state organized in under 2 minutes. Undo works.            |
| 4     | Intake: router, native-composer banner, ＋ New, CLI `new`                                                                            | Routing eval on replayed real prompts                           |
| 5     | Task-thread behavior: `configure` instructions, `bb workstreams handoff`, drift flag; update tomdaleOS agent instructions separately | Handoff and delegate scenarios on throwaway threads             |
| 6     | Cutover: rename to `workstreams`, remove v1                                                                                          | A day of normal use                                             |

## 17. Decisions

**Decided by Tom.**

- Manager threads are replaced by task threads that delegate and hand off.
- Intake is opinionated: continue an existing thread, start a new thread, or
  start a new workstream.
- No manual or big-bang Analyze or Organize runs.
- The workstream map evolves incrementally with responsive thresholds (≥ 2 roots
  in 60 days, archived included) and is dialed down if it proves disruptive.
- Evolution proposals surface as a yellow floating banner at the top of affected
  threads, with minimal copy.
- The page carries an Activity log of every change and proposal, with timestamps
  and rationale.
- Delegation uses BB's own spawn, and handoff is the `bb workstreams handoff`
  CLI. Workstreams registers no agent tools.
- There is no default home project. Work with no code target goes to BB's
  personal project ("Don't work in a project") unless `homeProjectId` is set.
- Workforest workspaces (multi-repository roots with no root repo) are a
  first-class project shape (§3).
- The plugin is rewritten in place, keeping the same id, `workstreams`.
- The UI term for a section is **workstream**.
- Grouping workstreams into families is dropped for now.

**Defaults accepted by Tom (2026-09-29).**

| #   | Question                             | Default                                                                                                         |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| D1  | What is a workstream?                | A native section                                                                                                |
| D2  | Which intake entry points?           | Native-composer banner, plus ＋ New                                                                             |
| D3  | How is a route confirmed?            | Always preview. ⏎ accepts.                                                                                      |
| D4  | Default environments?                | Router-created task threads use the project **checkout**. Delegates follow the project-shape guidance (§3, §5). |
| D5  | Which threads get task instructions? | All visible top-level threads                                                                                   |
| D6  | Who owns a delegate's lifecycle?     | The task thread (archiving the task archives its delegates)                                                     |
| D7  | Which models?                        | A stronger fast model for the bootstrap assignment, and Flash-Lite for steady state (pending the eval)          |
| D8  | Threads created outside Workstreams? | Auto-filed at high confidence, journaled                                                                        |
| D9  | Evolution outside intake?            | Auto-apply with an Undo banner                                                                                  |
| D10 | Recent band?                         | Keep, de-duplicated against Needs you                                                                           |
| D11 | Titles?                              | Title untitled threads and retitle drifted ones, never overriding a title set elsewhere (§10.1)                 |
