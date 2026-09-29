# Workstreams

A context-switching view of active BB threads. Workstreams builds the complete
parent/child tree first, then groups each tree by its root thread's native BB
section assignment. A child's own section never splits it from its parent,
matching BB's built-in custom-section behavior. For unsectioned roots,
Workstreams uses an explicitly titled `— manager` thread, inferred product, or
project as a fallback for the entire subtree. No role is inferred from checkout
path or top-level position.

The page and analysis include active hidden helpers through the paged server SDK
inventory, excluding archived and deleted threads. The sidebar hook only
supplies host-visible rows, so hidden helpers are absent from the replacement
sidebar until BB exposes them (and their actions) through that hook. The sidebar
shows a live Recent strip and routes each visible Needs-you item to one owner.
The Workstreams page adds recaps and concise group summaries.

Analysis uses parallel, non-reasoning GPT-4.1 mini calls through Pi's existing
AI Gateway connection. Organize can split detected side quests, archive only
explicitly redundant completed threads, tidy titles, file threads into native BB
sections, and repair worker parentage when analysis identifies the right
manager. Changes are logged and undoable except for compaction.
