# Organization behavior and notebook supervision

The supervisor considers the current workstream map, live root tasks, recaps,
thread notebooks, and shared understanding. A workstream is a coherent ongoing
effort, not necessarily a separate product. A busy product can have several
useful workstreams when its recurring areas are distinct enough to improve
navigation.

## Behavior contract

| Capability                 | Preserved behavior                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spin out                   | Create a workstream only when a surviving group of roots needs it. The supervisor identifies the group from semantic context.                                            |
| Move and merge             | Target existing workstreams; validate root/source/target IDs and membership before mutation.                                                                             |
| Ask or auto                | `evolution=ask` creates pending proposals; `auto` applies eligible changes with a visible Undo notice.                                                                   |
| Undo and activity          | Changes use the existing journal and batch application; Undo restores placements and applies to child trees.                                                             |
| Dismiss and acknowledgment | Dismiss/Undo suppress repeated suggestions; acknowledgment hides the applied notice.                                                                                     |
| Manual authority           | Recent user/external moves are protected. User-written descriptions define intended scope. Explicit destination choices bypass inferred routing.                         |
| Reviewed organization      | Map review, assignment preview, manual opt-in changes, skip/cancel, and `rebuild` remain available.                                                                      |
| Unsorted and forks         | Confident assignments can file unplaced roots; manual Unsorted choices remain untouched; visible forks follow the source effort.                                         |
| Other features             | Aliases/descriptions, dormant display, drift, triage, titles, routing, recaps, snooze, and debug inspection remain separate consumers of the existing product contracts. |

## Memory purpose

Notebooks capture the user's goals, product meaning, decisions, outcomes,
uncertainty, and the rationale behind work. Agent instruction files and skills
govern operating procedure. Learning preserves meaningful expectations but
refers to authoritative instructions rather than duplicating
build/install/commit checklists. Existing notebooks receive a purpose review as
the learner revisits them.

## Compatibility boundary

The subject-count detector and its archived-root counting cache are replaced by
notebook-driven reasoning. Repeated-suggestion suppression is based on changed
evidence, not accumulation of two more subject labels. Sensitivity controls how
cautiously and frequently the supervisor considers meaningful changes.

The `cutover` command and runtime readers of historical state/banner tables are
retired. An append-only database migration converts recognizable historical
automatic placements into current provenance and then drops those unused tables.
Existing migration IDs stay unchanged; current journal, placement, notebook,
recap, and user-authored map data remain.

Removal of the obsolete cleanup command is intentional, not a lost organization
capability: installation performs its cleanup automatically. Protocol schemas
bound proposed actions and preserve safe application; they do not dictate what
the model can learn or how it must describe the user's reality.
