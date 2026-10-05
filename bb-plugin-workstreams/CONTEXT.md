# Workstreams

Workstreams keeps open BB threads' topics, goals, statuses, and activity current, and groups roots into native BB sections derived from their topics.

## Language

**Thread**: A BB thread; the UI's unit of work. _Avoid_: task, conversation

**Root**: A visible, non-archived thread with no visible active parent; the unit Workstreams organizes. Delegates use its topic and workstream. _Avoid_: task thread, top-level task

**Delegate**: A child thread created for separable work. _Avoid_: subtask, child task

**Topic**: One topic-tree entry representing a product or capability, with a description and aliases. _Avoid_: entity, subject, identity, Catalog entry, product or feature

**Topic tree**: Every topic Workstreams knows, whether or not a thread uses it. _Avoid_: Catalog, corpus

**Topic assignment**: A root's topic or no topic, with its source and automatic-classification basis. _Avoid_: task identity, canonical assignment, subject

**No topic**: A root whose assignment names no topic. _Avoid_: unresolved, unclassified

**Workstream**: A BB section bound to one topic. _Avoid_: group, home, navigation group

**Unfiled**: Roots without a topic and therefore without a workstream. _Avoid_: unsorted

**Organizer**: The deterministic process that syncs topic-derived workstreams and membership. _Avoid_: coordinator, regroup

**Organization**: The page tab showing organizer state. _Avoid_: Organize tab

**Goal**: What a thread is for; written as its title. _Avoid_: inferred title

**Quick analysis**: Fast analysis of a draft or first request, returning a goal and topic.

**Full analysis**: Turn-end analysis that settles a goal and topic, and fills recap/status only when the agent did not report.

**Status**: How the latest turn ended: needs you, review, blocked, working, done, or error. _Avoid_: work state, completed

**Agent recap**: An agent's report for its latest turn. Its `goal` field remains the contract used by running sessions.

**Activity**: The log of changes Workstreams made or observed, with undo where supported. _Avoid_: journal (in the UI)

**Launch settings**: Project and environment choices for a new thread. _Avoid_: placement
