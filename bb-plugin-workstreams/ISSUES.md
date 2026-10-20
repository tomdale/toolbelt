# Workstreams Plugin — Issues, Bugs, Inconsistencies, and UX Audit

Findings from an exhaustive review of `bb-plugin-workstreams` across UI surfaces
(`src/app/*`), server and CLI (`src/server/*`), and domain logic
(`src/domain/*`).

---

## 1. Functional Bugs

### 1.1 Topic edits in the `Topics` tab do not refresh the list when `serverCatalog` is populated

- **Location:** `src/app/page/Catalog.tsx:45-67`,
  `src/app/page/Catalog.tsx:114-117`
- **Problem:** `Catalog` computes
  `activeCatalog = serverCatalog && serverCatalog.entities.length ? serverCatalog : localCatalog`.
  When any topic dialog (`CreateEntityDialog`, `RenameEntityDialog`,
  `ReparentEntityDialog`, `MergeEntityDialog`, `EditMetadataDialog`) succeeds,
  `handleActionSuccess()` calls `load()`, which fetches the updated catalog via
  RPC into `localCatalog`. However, whenever `serverCatalog` is non-empty (the
  normal state after initial bootstrap), `activeCatalog` ignores `localCatalog`
  and continues rendering the stale `serverCatalog` until a separate realtime
  `changed` event updates the parent store. The `Retry` button (`attempt` state)
  also only refreshes `localCatalog`.
- **Impact:** Creating, renaming, moving, merging, or editing a topic can leave
  the `Topics` tab showing stale rows until an external server-state refresh
  arrives.

### 1.2 Double-clicking a workstream header in the sidebar toggles collapse twice instead of renaming

- **Location:** `src/app/sidebar/ThreadList.tsx:719-730`,
  `src/app/sidebar/ThreadList.tsx:948-953`,
  `src/app/sidebar/ThreadList.tsx:1465-1469`,
  `src/app/sidebar/GroupMenu.tsx:1-13`
- **Problem:** `WorkstreamGroup` renders a `<button>` with
  `onClick={group.total > 0 ? toggle : undefined}` and
  `onDoubleClick={onRename}`. Manual workstream renaming was removed
  (`GroupMenu.tsx` is now a pass-through and no caller passes `onRename`), so
  double-clicking a header fires two `click` events that collapse and
  immediately re-expand the workstream while `onDoubleClick` is `undefined`.
- **Impact:** Double-clicking a workstream header produces a visual flicker
  (collapse then expand) and does nothing useful.

### 1.3 Settings changes in `FeatureSettings` silently swallow save failures and keep invalid optimistic state

- **Location:** `src/app/settings/FeatureSettings.tsx:13-18` vs.
  `src/app/prefs.ts:60-77`
- **Problem:** `useFeaturePrefs().update` calls
  `void save(patch).catch(() => {})`, discarding errors without surfacing an
  alert, whereas `SnoozeSettings.tsx:21-26` surfaces save failures in a
  `role="alert"` banner.
- **Impact:** If `setPrefs` fails or rejects a patch, the user receives no
  feedback that their setting change failed.

### 1.4 Disabling Debug mode while Activity model-call filters are active hides Activity entries with no visible control to reset

- **Location:** `src/app/page/Activity.tsx:149-153`,
  `src/app/page/Activity.tsx:222-240`, `src/app/page/Activity.tsx:341-355`
- **Problem:** `showCalls`, `action === "model-call"`, `callKind`, and
  `failuresOnly` are stored in component state while the filter controls that
  toggle them are conditionally rendered only when `debug` is true. If a user
  filters by `Model calls` or `Failures only` in Debug mode and then turns Debug
  mode off, the controls disappear while the state remains active.
- **Impact:** Activity log entries can remain hidden or filtered until the
  component unmounts or another visible filter is changed.

### 1.5 Non-gateway provider models silently drop `outputSchema` (structured output) and `maxTokens`

- **Location:** `src/server/index.ts:121-184`,
  `src/server/inference/worker.ts:44-105`, `src/server/model.ts:443`
- **Problem:** When the user selects a non-gateway BB provider model for Quick
  analysis or Full analysis, `complete()` routes to `completeWorker()`
  (`src/server/index.ts:184`), which ignores `outputSchema` and `maxTokens`. In
  addition, `Inference.call` (`src/server/model.ts:443`) passes `undefined` for
  `maxTokens` on every call. Furthermore, `runWorker` returns
  `{ input: 0, output: 0, cost: 0 }` and `reasoning: null`
  (`src/server/inference/worker.ts:97-100`).
- **Impact:** The documented guarantee that Quick analysis is schema-constrained
  (`SPEC.md` §6, `README.md`) holds only for AI Gateway models, not for BB
  provider worker models; traces and cost totals in Debug mode also report `0`
  tokens and `$0.0000` for worker-backed calls.

### 1.6 `CustomSnoozeDialog` ignores the user's configured `Mornings start at` (`morningHour`) setting

- **Location:** `src/app/snooze/CustomSnoozeDialog.tsx:41-43`
- **Problem:** When opening `Pick a date and time…`, the dialog initializes its
  input with `wakeTime("tomorrow", Date.now())!` without passing
  `snoozePrefs.morningHour`, so it always defaults to `9:00 AM` tomorrow even
  when the user configured `Mornings start at` to another hour (e.g. `6 AM` or
  `11 AM`).
- **Impact:** Inconsistent default wake hour between preset snoozes and the
  custom snooze dialog.

### 1.7 `deriveProductGroups` can leave a child group over capacity without splitting its grandchildren

- **Location:** `src/domain/regroup.ts:184-265`
- **Problem:** In `deriveProductGroups`, the greedy loop (`regroup.ts:222-244`)
  splits an over-capacity parent by activating its positive-count direct
  children in descending subtree-count order and breaks as soon as the parent's
  own residual load fits within `capacity`. If one of those newly activated
  child groups itself exceeds `capacity` (and has children of its own), the
  outer `while` loop (`regroup.ts:207`) only continues if it finds an
  over-capacity group that has unselected positive-count children, and
  `deriveActiveEntityIds` never re-runs `isGroupingValid` on the derived output.
- **Impact:** Deep topic hierarchies (3+ levels) with concentrated active load
  can edge-case into groupings that `isGroupingValid` considers invalid.

### 1.8 Two different implementations of the "completed-only residual group" fold-back rule

- **Location:** `src/domain/regroup.ts:132-142` vs.
  `src/domain/regroup.ts:151-162`
- **Problem:** When total active roots for a product are within `capacity`,
  `regroup.ts:132-142` checks whether `occupiedHomes.size < 2` using only
  `prevProductActive` (the previous active grouping). If the previous grouping
  was contracted to the root (`prevProductActive` has size 1),
  `occupiedHomes.size` is always `< 2`, which immediately returns `[root.id]`
  even when current counts across subtopics would otherwise be evaluated.
- **Impact:** Stickiness to a previously contracted root overrides fresh split
  evaluation whenever total active threads remain `<= capacity`.

### 1.9 `projectWorkstreams` default `needsYou` callback omits `needs_decision` analysis results

- **Location:** `src/domain/project.ts:136` vs. `src/domain/status.ts:60-68`
- **Problem:** `projectWorkstreams` defaults its `needsYou` option to
  `(thread) => thread.hasPendingInteraction`, whereas the domain rule in
  `status.ts:60-68` defines `needsYou` as
  `thread.hasPendingInteraction || (view.kind === "current" && view.analysis.state === "needs_decision")`
  (and the app client adds unread `done`/`review` threads at
  `src/app/useWorkstreams.ts:46-49`).
- **Impact:** Callers that rely on `projectWorkstreams`'s default `needsYou` (or
  don't include the app's unread `done`/`review` rule, such as
  `src/server/cli.ts:222`, which uses `status.ts` `needsYou` without the app's
  unread rule) can compute different `Up Next` / `needsYou` counts than the
  sidebar UI.

### 1.10 Archive navigation skips archived descendants in group order, but not in Up Next order

- **Location:** `src/domain/archiveNavigation.ts:10-19` vs.
  `src/domain/archiveNavigation.ts:39-57`
- **Problem:** `nextThreadAfterArchive` explicitly walks `parentThreadId` links
  to skip descendants of the archived root thread
  (`archiveNavigation.ts:45-49`), because archiving a root puts away its
  delegate subtree. However, `nextUpNextThreadAfterArchive`
  (`archiveNavigation.ts:10-19`) only filters
  `row.thread.id !== archivedThreadId` and does not skip descendants of
  `archivedThreadId`.
- **Impact:** Archiving a root thread from a recap card while one of its
  delegates is in `projection.needsYou` can navigate the user directly into an
  orphaned child of the thread they just archived.

---

## 2. Inconsistencies Between Code, UI Copy, CLI, and Documentation

### 2.1 `"Keep titles current"` setting description contradicts actual outside-edit title locking

- **Location:** `src/app/settings/FeatureSettings.tsx:186-192` vs.
  `src/domain/titles.ts:29-51, 74-106`, `README.md`, `SPEC.md` §3
- **Problem:** The UI setting description for **Keep titles current** says:
  > _"Title new threads promptly and update titles to follow their current
  > substantive focus. **Includes titles you edit; turn this off to keep them
  > fixed.**"_ In reality, `observeTitle` (`src/domain/titles.ts:38-49`) locks
  > any title renamed outside Workstreams
  > (`locked: record.locked || renamedElsewhere`), and `retitleDecision`
  > (`src/domain/titles.ts:89`) refuses to overwrite locked titles
  > (`reason: "manual"`). Both `README.md` ("Outside title edits retain
  > ownership until cleared") and `SPEC.md` §3 ("Automatic titling preserves
  > outside title edits until the title is cleared") state the opposite of the
  > setting copy.
- **Impact:** Users are told that their manual title edits will be overwritten
  unless they disable automatic titling altogether.

### 2.2 `bb workstreams trace` outputs an obsolete CLI command to enable Debug mode

- **Location:** `src/server/cli.ts:562`
- **Problem:** When no model traces are recorded, `bb workstreams trace` prints:
  > ``No model calls recorded. Debug mode records them: `bb plugin config workstreams set debug true`.``
  > Workstreams no longer reads declarative BB plugin config after its one-time
  > legacy migration (`src/server/index.ts:59`); `advanced.debug` is stored in
  > Workstreams' own `prefs` table (`ws_meta` key `"prefs"`) and updated via the
  > `setPrefs` RPC.
- **Impact:** Running the suggested
  `bb plugin config workstreams set debug true` command does not enable Debug
  mode.

### 2.3 Status vocabulary mismatch (`working` vs. `in_progress`, and `"waiting to working"` in `SPEC.md`)

- **Location:** `CONTEXT.md:35`, `SPEC.md:21`, `SPEC.md:82` vs.
  `src/domain/analysis.ts:36-41`, `src/domain/recap.ts:502-517`,
  `src/domain/presentation.ts:63-70`
- **Problem:**
  - `CONTEXT.md` and `SPEC.md` list the status values as
    `needs you, review, blocked, working, done, or error` and `SPEC.md:82`
    states _"Agent recap states map complete to done, review to review, and
    waiting to working."_
  - In code, the `WorkState` enum is
    `["needs_decision", "review", "blocked", "in_progress", "done"]`,
    `reportedStatus` maps `waiting` to `"in_progress"`, and `presentation.ts`
    labels `in_progress` as `"In progress"` (while `error` is a BB runtime
    thread status, not a `WorkState`).
- **Impact:** CLI `--json` consumers, trace inspectors, and developers reading
  `SPEC.md` see conflicting state names (`working` / `needs you` vs.
  `in_progress` / `needs_decision`).

### 2.4 Prompt vs. validator length limit mismatch for `needsYou` (`80` vs. `120` characters)

- **Location:** `src/domain/analysis.ts:322` vs. `src/domain/analysis.ts:402`
- **Problem:** `STATUS_FIELDS` in `analysis.ts:322` instructs the model that
  `needsYou` must be _"at most 80 characters"_, while the response parser
  (`analysis.ts:402`) clips and accepts up to `120` characters (`clipped(120)`).

### 2.5 Recap mention length accounting vs. rendering mismatch (`@project:` and `@section:`)

- **Location:** `src/domain/recap.ts:43` vs. `src/domain/recap.ts:597`
- **Problem:** `visibleLength()` (`recap.ts:43`) counts `@thread:`, `@project:`,
  and `@section:` mentions as compact chip tokens when validating recap text
  length limits, but `recapSegments()` (`recap.ts:597`) only tokenizes
  `@thread:` mentions into UI chips; `@project:` and `@section:` render as raw
  literal text.

### 2.6 Activity snooze preset has two different user-facing names (`"Until it updates"` vs. `"On update"`)

- **Location:** `src/domain/snooze.ts:27` vs. `src/domain/snooze.ts:193`
- **Problem:** The `activity` snooze preset is labeled **"Until it updates"** in
  menus and settings, while `shortWake()` renders **"On update"** in Snoozed row
  trailing labels on the same screen.

### 2.7 `"New threads"` settings section title vs. `"New work"` everywhere else

- **Location:** `src/app/index.tsx:174` (`title: "New threads"`,
  `id: "new-work"`) vs. `src/app/page/Page.tsx:145` (`"New work…"`),
  `src/app/sidebar/ThreadList.tsx:1510` (`"New work in ${group.name}"`)
- **Problem:** The feature is named **New work** across the sidebar and
  Workstreams page, but its settings section is titled **New threads**.

### 2.8Glossary terms banned by `CONTEXT.md` still appear in docs and UI strings

- **Location:** `CONTEXT.md:13-27` vs. `docs/organization.md:52, 63`,
  `SPEC.md:69, 139-142`, `README.md:15`,
  `src/app/settings/FeatureSettings.tsx:252`, `src/server/cli.ts:709`
- **Problem:**
  - `CONTEXT.md` bans **"Catalog"** / **"Catalog entry"**, but
    `docs/organization.md:52` uses the heading `## Reviewing catalog repairs`
    and `SPEC.md` refers to `catalog definitions` / `catalog changes`.
  - `CONTEXT.md` bans **"task"**, but `bb workstreams topics show <topic>`
    prints `Assigned tasks: N` (`src/server/cli.ts:709`) and CLI error codes
    still use `catalog_entity_not_found`, `catalog_create_failed`, etc.
  - `CONTEXT.md` bans **"subtask"**, which previously appeared in `README.md`
    and still appears in `src/app/goalContext.ts:14` and
    `src/app/StickyGoalHeader.tsx:579`.

### 2.9 Code comments reference non-existent `SPEC.md` sections and missing `docs/bb-sdk-wishlist.md`

- **Location:**
  - `src/domain/project.ts:2, 6, 7, 203` (`SPEC I8`, `SPEC I2`, `SPEC I1`,
    `SPEC §10`)
  - `src/domain/analysis.ts:80, 463` (`SPEC §11.6`, `SPEC §8`)
  - `src/domain/trace.ts:2` (`SPEC §11.6`)
  - `src/server/journal.ts:8` (`SPEC §9`)
  - `src/app/header/ArchiveHeaderAction.tsx:16`,
    `src/server/composed-drafts.ts:8` (`docs/bb-sdk-wishlist.md`)
- **Problem:** `SPEC.md` in `bb-plugin-workstreams` only has sections `1–6` and
  numbered invariants `1–8`; it has no `I1`/`I2`/`I8` or `§8`–`§11.6`. In
  addition, comments in `ArchiveHeaderAction.tsx` and `composed-drafts.ts` point
  to a plugin-local `docs/bb-sdk-wishlist.md` (the wishlist file actually lives
  at the repository root `../docs/bb-sdk-wishlist.md`).

---

## 3. User Experience (UX) & Accessibility Issues

### 3.1 Cross-workstream thread drag-and-drop highlights the target workstream and then silently does nothing

- **Location:** `src/app/sidebar/drop.ts:55-59`,
  `src/app/sidebar/ThreadList.tsx`
- **Problem:** Workstreams intentionally prevents moving a root thread to
  another workstream by dragging (because a root's workstream is derived from
  its topic). However, dragging a thread over another workstream still
  highlights the target group (`dropGroupId`) as if it is a valid drop target,
  and releasing the pointer silently snaps the thread back with no toast,
  tooltip, or explanation of how to move it (by changing its Topic).

### 3.2 Phone Home screen `Up Next` renders delegate threads flat without hierarchy or parent context

- **Location:** `src/app/home/UpNextBlock.tsx:60-73`, `src/app/home/HomeRow.tsx`
- **Problem:** In the sidebar, `Up Next` folds delegates under their parents by
  default. On the Phone Home screen, `UpNextBlock` renders every returned row
  via `HomeRow` at default `depth = 0` without a `disclosure` prop or parent
  indicator, so a delegate waiting on the user appears indistinguishable from a
  root thread.

### 3.3 Phone Home screen omits the pinned indicator on pinned root threads

- **Location:** `src/app/home/HomeRow.tsx` vs. `src/app/sidebar/Row.tsx`
  (`showPin`)
- **Problem:** Pinned threads sort to the top of their workstream on both the
  sidebar and the Phone Home screen, but `HomeRow` never renders a pin icon,
  leaving no visual explanation for why a older pinned thread is at the top of a
  workstream on phones.

### 3.4 Overview search filters thread rows but leaves workstream header counts unfiltered

- **Location:** `src/app/page/Page.tsx:107-118`, `src/app/page/Page.tsx:288-295`
- **Problem:** Typing a query in the `Overview` tab filters `group.rows`, but
  `WorkstreamCard` still displays the unfiltered `group.total` and
  `group.needsYou` counts in the card header.

### 3.5 Activity tab shows `"No activity yet."` when active filters match zero entries

- **Location:** `src/app/page/Activity.tsx:438-440`
- **Problem:** When entries exist in the journal but none match the selected
  workstream, action, `Needs review`, `Outside changes`, or `Failures only`
  filters, the UI renders `"No activity yet."` instead of
  `"No matching activity."`

### 3.6 `AskUserQuestion` freeform input has no client-side character limit or non-project attachment hint

- **Location:** `src/app/question/question-form.tsx:73-79, 238-256, 294-298`,
  `src/server/questions/contracts.ts:16-17, 86-96`
- **Problem:**
  - The server rejects freeform answers longer than `4,096` characters, but the
    client `<textarea>` has no `maxLength` or character counter; exceeding
    `4,096` characters fails only on submit with a generic
    `"Could not send your answer."` message.
  - When a thread has no `projectId` (personal context), the file-attachment `+`
    button is disabled without a tooltip or explanation that attachments require
    a project.
  - Selecting a radio option after typing an `"Other…"` response deselects
    `"Other…"` and omits the typed text from the submitted payload without
    warning.

### 3.7 Drafting a message while a recap card is visible permanently suppresses the Archive suggestion for that recap

- **Location:** `src/app/archive/useArchiveSuggestion.ts:9-12, 51`
- **Problem:** `declined` is a module-level `Set<string>` mutated during render
  (`if (recapId && continuing && !busy) declined.add(recapId)`). If the user
  types a single character in the composer while a completed recap is visible
  and then deletes their draft without sending, that `recapId` remains in
  `declined` for the rest of the session and the **Archive** button never
  reappears.

### 3.8 Archived band in grouped mode repeats the workstream name on every row instead of showing age

- **Location:** `src/app/sidebar/ThreadList.tsx:896-902`,
  `src/app/sidebar/useBandOptions.ts:27`
- **Problem:** The Archived band defaults to `Group by workstream`
  (`grouped: true`), which already places rows under a workstream heading, yet
  `contextOf` still puts the workstream name in every row's trailing column in
  place of the relative age.

### 3.9 CLI UX and output gaps

- **Location:** `src/server/cli.ts`
- **Problems:**
  - `bb workstreams undo <entry-id>` (`cli.ts:557-572`) is the only CLI command
    that lacks a `--json` option.
  - `bb workstreams topics preview` (`src/server/reclassification.ts:74`,
    `src/server/cli.ts:606`) sets `title: threadId` when `previewTopic` throws
    an error, printing a raw UUID instead of the thread's title on error rows.
  - `bb workstreams show <workstream>` (`cli.ts:300`) silently truncates at
    `200` rows (`group.rows.slice(0, 200)`) in both human and `--json` output
    with no truncation indicator or `hasMore` field.
  - `bb workstreams log --since <duration>` (`cli.ts:359-362`) filters by
    `since` _after_ `journal.list({ limit })` applies `--limit` (default `50`),
    so `--since 7d` silently omits entries within the 7-day window whenever more
    than 50 newer entries exist.
  - `bb workstreams analyze` (`cli.ts:424`) appends
    `Last error: ${analyzer.lastError}`, which is a single global string from
    any earlier thread failure and may be unrelated to the threads just queued.
  - `bb workstreams thread show <delegate-id>` (`cli.ts:980-983`) prints both
    the root's provenance (`Source: set by you`) and
    `Follows parent: @thread:<root-id>`, conflating root assignment provenance
    with delegate inheritance.

### 3.10 Minor accessibility gaps

- **Location:** `src/app/sidebar/Row.tsx:230`,
  `src/app/settings/ui.tsx:105-133`,
  `src/app/settings/SpinnerSettings.tsx:236-246`, `src/domain/spinner.ts:79-92`
- **Problems:**
  - The sidebar parent-thread disclosure chevron (`ws-disclosure` in
    `Row.tsx:230`) is `14px × 14px`, well below the recommended `44px` touch
    target size.
  - Custom spinner and track hex colors (`#rrggbb`) have no contrast check
    against the sidebar background (`spinner.ts:79-92`).
  - `Stepper` (`settings/ui.tsx:105-133`) updates its `<output>` value without
    `aria-live`, so keyboard arrow adjustments are not announced by screen
    readers.

---

## 4. Dead Code & Leftover Artifacts

| File / Symbol                                           | Reference                                                                                                 | Details                                                                                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/sidebar/GroupMenu.tsx`                         | Lines `1–13`                                                                                              | No-op pass-through component returning `{children}`; its `onRename`, `onNewThread`, and `priority` props are unused.                |
| `src/app/composer/RoutePicker.tsx`                      | Lines `1–9`                                                                                               | Unused 9-line component from an earlier composer design; never imported.                                                            |
| `src/app/sidebar/useBandOptions.ts`                     | Lines `53–71` (`useBandOptions`)                                                                          | Exported hook has no callers; `ThreadList.tsx:66-90` duplicates its `localStorage` read/write logic inline.                         |
| `src/app/composer/new-work.ts` & `NewThreadRouting.tsx` | `new-work.ts:83-90` (`composerSummary`), `new-work.ts:353` (`NewWorkContext`), `NewThreadRouting.tsx:152` | `composerSummary` is never called; `NewWorkContext` is provided by `NewThreadRouting` but never consumed via `useContext`.          |
| `src/app/composer/route-picker.css`                     | Lines `41–48`, `58`, `88`, `115`, `136–238`                                                               | Dead CSS rules for the removed two-chip `"route"`/`"split"` composer variants and `.ws-route-sheet` / `.ws-route-tabs` phone sheet. |
| `src/app/styles.css`                                    | Lines `887–907`, `917–928`                                                                                | Dead `[data-ws-workstream-control]` and `ws-spark-pulse` CSS rules for the removed destination-workstream composer picker.          |
| `src/server/service.ts`                                 | Lines `61` and `100`                                                                                      | `retitle()` checks `if (!this.titlesEnabled())` twice with identical conditions before and after computing `retitleDecision`.       |
| `src/domain/trace.ts` & `src/server/journal.ts`         | `trace.ts:42` (`"proposal"` link kind), `journal.ts:8` (`"proposal"` action)                              | Leftover vocabulary from the retired proposals system (`ws_proposal` table was dropped in `src/server/db.ts`).                      |
