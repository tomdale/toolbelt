# Workstreams

A context-switching view of active BB threads. Workstreams groups threads by
product or project, and can use an explicitly titled `— manager` thread as the
heading for that product group. Descendants nest under their parent. Threads
without a manager use their inferred product, assigned BB section, or project as
a grouping fallback. No special role is inferred from a thread's checkout path
or top-level position.

The sidebar includes active hidden helper threads and excludes archived threads.
It shows a live Recent strip and routes each Needs-you item to one owner. The
Workstreams page adds thread recaps and concise group summaries.

Analysis uses parallel, non-reasoning GPT-4.1 mini calls through Pi's existing
AI Gateway connection. Organize can split detected side quests, archive only
explicitly redundant completed threads, tidy titles, file threads into native BB
sections, and repair worker parentage when analysis identifies the right
manager. Changes are logged and undoable except for compaction.
