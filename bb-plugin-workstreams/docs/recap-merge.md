# Fold Recap into Workstreams

## Goal

One source of truth for what each thread is doing. Today Workstreams'
per-thread analysis (sidebar marker, Needs you, archive eligibility) and the
separate Recap plugin (composer recap card) summarize the same thread with
different models and routinely disagree. Example: a thread shows the "ready
for review" marker, but its recap never says what to review. That happens
because Workstreams' `needsYou` is only filled for `needs_decision`, never for
`review` or `blocked`.

After this change Workstreams owns both the classification and the recap. The
recap card is the one place at the bottom of the thread that explains status
and offers the next action, including Archive.

No data migration: existing recaps are regenerated. The upstream Recap project
is not a concern; `bb-plugin-recap/` is removed at the end.

## Two tiers

### Triage: after every turn, fast model, small input
- Input: the new turn (latest user request and last assistant message), the
  previous recap's Goal and first Latest line as context, and the title,
  workstream, and known subjects. Not a rebuilt history window.
- Output: `state`, `next` (the action line, see below), `subject`, `title`,
  `drift`, and a one-line `recap` for the CLI and routing prompts.
- Drives the sidebar marker and second line, Needs you, archive eligibility,
  drift proposals, titles, and routing context.
- Replaces today's analysis call.

### Recap: after a configurable quiet period, stronger model, full transcript
- Runs every time the thread has been quiet for N seconds (configurable), and
  always produces a fresh recap. There is no staleness check.
- A new turn during the wait resets the timer. A new turn while a recap call
  is in flight **cancels** that call through `AbortSignal` (already plumbed
  through `model.ts`, the host, and the gateway; aborted calls are not traced).
- Keep Recap's minimum-user-turns threshold.
- Input: a trimmed transcript built with Recap's builder (`buildConversationText`:
  drops tool noise and host notices, keeps head and tail), capped far below
  Recap's current 120k chars (tune against evals), plus the thread's current
  todo plan as input only, and triage's `state` and `next` as **fixed
  inputs** that the recap must not contradict.
- Output: Goal, Latest (1–3), Open (0–3), Done (0–3).

## The `next` line

When the state is `needs_decision`, `review`, or `blocked`, triage writes a
short imperative or waiting phrase, about 40 characters or fewer:
"Review the Activity page redesign", "Choose between A and B",
"Waiting on CI for #412". Null otherwise.

- The recap's first Latest line is this same text, in fuller form when useful.
- Sidebar rows show it as a color-coded second line (colors follow state; no
  line for in_progress or done). Prototype two variants, "augment" (keep the
  marker and Needs you grouping, add the line) and "replace" (the line
  replaces the marker), and let the user choose.
- It replaces `needsYou` everywhere (Needs you, Activity, CLI).

## Recap card (a Workstreams composer banner)

- Header: Goal.
- Body: Latest (action first when present), then Open and Done, collapsed to
  header plus 1–2 lines by default with an expand toggle. Blocked appears only
  in the body, as a Latest line.
- Archive: an "Archive" button on the header row, only when archive eligibility
  holds (the existing `ArchiveSuggestions` rules and dismissal). Remove the
  composer toolbar `ArchiveCard` action.
- If the thread is opened before a fresh recap exists, show the previous recap
  body with the current triage `next` line on top.
- No Regenerate button.
- Visibility follows Recap's current rule (thread scope, not the inline message
  editor), plus hidden while the thread runs and while the user types a
  continuation.

## Todo plans

`pendingTodos` on the BB timeline only carries first-party provider plan
steps; the Pi `todo` plan used with `bb-plugin-todo` is not in it.
`bb-plugin-todo/snapshot.ts` rebuilds that plan from successful tool calls.

- Rebuild the same snapshot in Workstreams (share or port the logic).
- Use it, together with `pendingTodos`, for archive eligibility. Today Pi
  threads with unfinished todos can be offered for archive.
- Use it as recap input so the recap never calls work done while todos are
  pending. Open and Done stay model-generated; they are **not** taken from the
  todo list (the lists track different things).

## Prompts and tokens

- Each prompt section is produced by a small render function that writes only
  what the model needs, with a character cap. Never serialize domain objects
  into prompts. Record this rule in `SPEC.md`.
- Both outputs use labeled lines instead of JSON, like Recap's current format
  (`Goal:`, `Latest:`, `Open:`, `Done:`; triage `State:`, `Next:`,
  `Subject:`, `Title:`, `Recap:`, `Drift: <workstream|new name> (<confidence>)`).
- Rewrite Recap's long rules block for the shared model; keep what the evals
  show matters.
- Also replace the JSON array of other workstreams in the drift instruction
  (`analysis.ts`) with markdown lines.

## Settings (Workstreams settings section)

- Triage model and Recap model, each using `ProviderModelPicker` as Recap does
  today.
- Recap quiet period (seconds) and minimum user turns.
- Recap card layout (compact or expanded) and a card on/off toggle.
- Not carried over: custom recap prompt, Recap concurrency and cleanup
  settings, the Recap header button.

## Other entry points

- Command palette: "Workstreams: refresh recap for this thread".
- CLI: `bb workstreams recap <thread>` prints the full recap.

## Steps

Commit after each step with tests passing.

1. Triage/recap split: schemas, labeled-line prompts and parsers, render
   functions, `next` replacing `needsYou`. Run `eval/` on triage to confirm
   state accuracy holds with the smaller input; compare recap quality on the
   fast model versus Recap's current model (`codex/gpt-5.6-luna`). Report
   findings before moving on.
2. Recap scheduler: quiet-period timer, cancellation, minimum turns, storage.
3. Pi todo snapshot in Workstreams; wire into archive eligibility and recap
   input.
4. Recap card UI with Archive; remove the toolbar `ArchiveCard`.
5. Sidebar second line, both variants behind a setting, for the user to choose.
6. Settings (model pickers, quiet period, layout), command palette, CLI.
7. Remove `bb-plugin-recap/`, update `README.md` and `SPEC.md`, and tell the
   user to uninstall the Recap plugin.

## Measured baseline (last 7 days, this machine)

| | Calls | Model | Input | Output | Time |
|---|---|---|---|---|---|
| Workstreams analysis | 190 | gemini-3.1-flash-lite | ~5.4k chars (max 8.3k) | ~260 chars | ~2.1 s |
| Recap | 101 | codex/gpt-5.6-luna | up to 120k chars | ~335 chars | not logged |

Traces live in `~/.bb/plugins/workstreams/data.db` (`ws_trace`); stored
recaps in `~/.bb/plugins/bb-recap/data.db` (`recaps`).
