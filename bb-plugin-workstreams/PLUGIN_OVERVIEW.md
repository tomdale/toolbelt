# Workstreams

Workstreams organizes open BB threads into recognizable ongoing efforts.
A task concerns one **Product or feature** identity in the Catalog (or is
unresolved), while its thread occupies a **Workstream** (or is unfiled).
Identity and section placement are independent.

Click **Organize** to classify open threads against the Catalog and group
them adaptively based on concurrent task counts by product and feature, then
**Apply organization**. Any Catalog edit bumps revision, safely marking previews
stale until regenerated. Each workstream is a native BB section, and children
follow their root's section and inherit its Catalog identity.

The **Catalog** tab maintains all known products and features in an explicit
hierarchy with descriptions, aliases, and related tasks, and supports scoped
create, edit, reparent, and merge operations.

New work is BB's New thread composer with a Product or feature field and a
Workstream field. When you pause typing, it classifies the draft against the
Catalog and suggests one home. Suggestions can be disabled in New work
settings; when disabled, typing-pause requests return no suggestion and make no
model call. Nothing changes until you accept a suggestion or start the thread.

Each thread's agent ends its turns with a question card or a recap: complete, or
ready for review with Review steps naming what to check. The recap sits above
the composer with a dismiss ✕ and, once the work is done, Archive; its state
marks the thread in the sidebar.

The sidebar puts Up Next, the workstreams you prioritized, and Recent above the
other workstream groups; while a prioritized workstream has a thread waiting, Up
Next shows only those. On a phone, the Home screen shows the same Up Next block
over your threads grouped by workstream, in place of BB's flat Recent list. A
thread's title is its goal, set from its first request within seconds and kept
current as its objective changes; the sidebar, the heading above the thread, and
Activity all show that one name. Recaps, work state, and snooze stay current
independently of organization. Activity records changes with rationale and Undo,
including the organizing batch's placements and routing metadata. Manual changes
made elsewhere are respected. Workstreams' preferences are grouped by feature
and stored in plugin storage. Model choices use BB's provider/model picker:
gateway-backed models use a direct completion from the configured machine; other
provider models run in a hidden BB worker thread.
