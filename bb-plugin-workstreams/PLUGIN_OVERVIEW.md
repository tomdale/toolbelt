# Workstreams

A context-switching view of visible, active BB threads. Workstreams builds the
complete parent/child tree first, then groups each tree by its root thread's
native BB section assignment. A child's own section never splits it from its
parent, matching BB's built-in custom-section behavior. For unsectioned roots,
Workstreams uses an explicitly titled `— manager` thread, inferred product, or
project as a fallback for the entire subtree. No role is inferred from checkout
path or top-level position.

The page and analysis use the paged server inventory of visible, non-archived,
non-deleted threads. Hidden helpers and Workstreams' internal workers are not
analyzed or automatically organized. The replacement sidebar uses BB's
visible-only sidebar hook, so hidden helpers are absent there as well. It shows
a live Recent strip and routes each Needs-you item to one owner. The page adds
recaps and concise group summaries.

Analysis uses parallel, non-reasoning GPT-4.1 mini calls through Pi's existing
AI Gateway connection. Organize can split detected side quests, archive only
explicitly redundant completed threads, tidy titles, file threads into native BB
sections, and repair worker parentage when analysis identifies the right
manager. Changes are logged and undoable except for compaction.
