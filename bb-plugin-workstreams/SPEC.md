# Workstreams specification

Workstreams keeps BB threads useful at a glance by maintaining each root's goal, topic, status, and activity, then deriving native BB workstreams from topics. See [Organizing workstreams](docs/organization.md) for the organizer's detailed behavior.

## 1. Concepts and invariants

| Concept | Definition | Owner |
| --- | --- | --- |
| **Thread** | A BB thread; the unit named in the UI | BB |
| **Root** | A visible, non-archived thread with no visible active parent; the unit Workstreams organizes | Derived from BB links |
| **Delegate** | A child thread created for separable work; it uses its root's topic and workstream | BB parent link |
| **Topic** | An entry in the topic tree, representing a product or capability | SQLite topic tables |
| **Topic assignment** | A root's topic or no topic, with its source and automatic-classification basis | SQLite topic fact |
| **Workstream** | A BB section bound to a topic | BB section and SQLite binding |
| **Unfiled** | Roots without a topic and therefore without a workstream | Derived |
| **Goal** | What a thread is for; Workstreams writes it as the title | BB title and title metadata |
| **Status** | The latest state: needs you, review, blocked, working, done, or error | Question, report, error, or Full analysis |
| **Organization** | The page tab showing current organizer state | Derived |
| **Activity** | Changes Workstreams made or observed | SQLite journal |

Invariants:

1. A root's topic determines its workstream. A sidebar move is recorded and reverted; assign another topic to change workstream.
2. Delegates inherit their root's topic and section.
3. The organizer reads stored facts and makes no model calls.
4. Quick analysis supplies a new thread's initial goal and topic. Full analysis settles the goal and topic at turn end and fills recap/status/needs-you only when the agent did not report.
5. Topic sources have priority `manual` > `inherited` > `full` > `quick`. An inherited topic changes only when Full analysis reports a scope shift.
6. Automatic changes and observed outside changes are recorded in Activity, with undo where supported.
7. The bound topic supplies a workstream's name, description, and aliases.
8. The agent recap tool's `goal` field remains its current contract for compatibility with running sessions.

## 2. Starting topics

A new root takes the first applicable topic: a topic selected in the composer (`manual`); the topic of a source thread when forked, spawned, or started from that thread (`inherited`); the topic bound to the workstream's ＋ (`inherited`); otherwise the result of Quick analysis on the first request (`quick`), or no topic. Delegates use their root's assignment.

Quick analysis runs on a composer draft to preview a goal and topic. The matching result is reused on first send; otherwise the sent text is analyzed. A quick topic files the thread immediately.

## 3. Full analysis and status

At turn end, Full analysis receives requests, the latest reply, prior goal and topic, project context, the topic tree, and an agent report when available. It returns goal, topic, and scope shift. Only without a report does it supply fallback recap, status, and needs-you. Full analysis runs after a substantive new request; a Workstreams status-check turn runs it only if no report was made. Failed turns are marked error without analysis.

Topic application respects source priority: manual never changes; inherited changes only on scope shift; full replaces quick and updates full; quick applies only before a stronger source. Goal retitling preserves externally edited titles and applies only current results; accepted title changes have no time-based limit.

Question cards and agent reports precede analysis fallback for status. Agent recap states map complete to done, review to review, and waiting to working. Fresh user input clears the prior recap. Recap reminders remain configurable.

## 4. Organization

The organizer runs after relevant facts change. It groups topics using active-root counts and capacity, binds BB sections to topics, files roots accordingly, records outside moves and reverts them, and prunes unused discovered topics. Mutations run through the serialized service queue and are journaled.

The Organization page shows current organizer state, workstreams, counts, and agent-report coverage. `bb workstreams organization [--rebuild]` reports or rebuilds the projection. Topics are managed in the Topics tab or with `bb workstreams topics …`.

## 5. Composer, storage, and architecture

The BB composer exposes a Topic picker and Quick analysis preview. It has no destination-workstream choice. A selected topic is manual; Automatic uses Quick analysis. A workstream's ＋ seeds its topic.

SQLite stores topics, topic assignments, workstream bindings, analysis, title ownership, agent reports, questions, traces, reconciler snapshots, preferences, and Activity. Migrations retain the established topic-table names and remove obsolete placement, drift, and project-shape state.

`src/domain/` owns classification, status, grouping, and projections. `src/server/quick.ts` performs Quick analysis; `analyzer.ts` performs Full analysis; `topics.ts` persists topics; `organizer.ts` derives membership; `preview.ts` serves composer previews. The app uses the RPC schemas in `contract.ts`; the CLI uses the same services.

## 6. Settings and CLI

Quick analysis and Full analysis have separate model settings. The Quick analysis model remains available when typing suggestions are disabled because first-send analysis still uses it. Capacity and collapse threshold configure grouping; existing title, sidebar, recap, snooze, and display preferences remain.

The CLI uses `topics`, `thread`, and `organization` vocabulary. See `bb workstreams --help` for current commands.
