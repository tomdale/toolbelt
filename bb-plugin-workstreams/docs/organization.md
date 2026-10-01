# Organizing workstreams

A workstream is a recognizable ongoing effort represented by a native BB
section. Organization is an explicit operation: open **Workstreams → Map →
Organize**, review the complete proposed map, then choose **Apply map**. Cancel
leaves membership and descriptions unchanged.

## One pass

The organizer snapshots visible, non-archived threads and considers all roots
together. Children supply bounded context and stay with their root. Inputs
contain titles, cached thread summaries, project names, existing scope
descriptions and aliases. No fresh per-thread summarization calls are required.
One tool-free model response supplies names, descriptions, aliases and an
assignment for every root; an empty inventory needs no model call.

Prefer distinct, recognizable homes over overlapping topic labels. Work on a
product stays together unless separate durable commitments materially improve
navigation. Implementation layers, temporary phases and isolated chores do not
justify extra homes by themselves. A single root with substantial child work can
still represent a commitment. Ambiguous or unrelated work belongs in Unsorted.

The pass accepts at most 500 roots, 500 existing sections and 300,000 characters
of serialized evidence. Per-thread text is bounded. An oversized inventory fails
explicitly rather than silently omitting threads. Model output must cover every
root exactly once, refer only to valid destinations, and avoid duplicate or
empty homes. Invalid output changes nothing.

## Preview and Apply

The preview lists the proposed homes with routing metadata and all assigned
roots, including roots that stay put. Moves identify their prior home and
rationale. Uncheck a move to keep the current placement. Renames and scope
metadata are reviewed as part of the whole map. User-authored descriptions are
preserved; the preview shows the scope that will actually apply.

Apply consumes the saved preview, not another model result. It revalidates
section names and metadata; a changed map requires a fresh preview. Threads
moved, hidden, archived, deleted or reparented since the preview are skipped.
Thread state is checked again immediately before each move. BB does not expose
conditional updates, so it cannot guarantee atomicity against external writes
between that final read and update. New sections are created only for moves
surviving preflight. Existing sections omitted from the result remain dormant
containers so archived history and native section IDs are preserved.

Activity records the application as one undoable batch, including descriptions
and aliases. Undo restores only values still matching the application;
intervening user changes are left alone. If application fails partway, completed
changes remain journaled and undoable.

## Between runs

The map stays fixed until another explicit organization or manual edit. Thread
creation through New work uses the previewed route. Other unassigned roots
remain Unsorted. Recaps, Needs-you, titles and snooze continue independently;
completing a turn does not move a thread or create a section.

New work classifies against populated homes using their names, descriptions and
aliases. It can continue a thread, start a thread in an existing home, or return
unsure. Only the user's explicit **Create workstream** choice permits a new
home; a model-generated unfamiliar name alone cannot create one. Dormant homes
remain selectable explicitly but are omitted from inferred routing.

## CLI

`bb workstreams rebuild` computes and saves a preview. Inspect the output or
open the Map tab. `bb workstreams rebuild --apply --run-id <startedAt>` applies
that saved preview without another inference; it fails if the reviewed run was
replaced or no preview exists. `--json` returns the complete state.
`bb workstreams undo <entry-id>` reverses a recorded application.
