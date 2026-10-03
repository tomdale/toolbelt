# Organizing workstreams

A workstream is a recognizable ongoing effort represented by a native BB
section. Organization is an explicit operation: open **Workstreams →
Organize**, review the proposed organization, then choose **Apply
organization**. Cancel leaves membership and descriptions unchanged.

## Two-stage adaptive organization

Rather than a single whole-tree prompt, the organizer runs in two distinct
stages:

### 1. Classification

Roots missing a fresh stored subject are classified against the Catalog using
the `classify` model. Inputs contain the thread title, recap, project context,
and relevant user requests.
Explicit manual selections (`provenance: manual`) remain authoritative and are
never overwritten by automatic classification. Missing or stale classifications
run with up to three concurrent workers. Progress reports completed, cached,
and unresolved tasks before proceeding.

### 2. Regrouping

Once all active roots have canonical assignments, the organizer groups them
adaptively using `regroup`. It counts active, non-completed tasks per product
and feature in the Catalog and selects active navigation homes based on:

- **Group capacity**: maximum current tasks per workstream (default: 6). Tasks
  concerning one indivisible feature may exceed capacity in their own group.
- **Contraction threshold**: at or below this product task count (default: 3),
  previews return to a broad product group rather than fragmenting.

Completed roots (`state: "done"`) and child workers do not inflate these counts.

## Truthful reasons and retention

The preview displays specific canonical product/feature identities independently
of target workstreams, with truthful reasons explaining each assignment:

- **Specific feature grouped broadly**: `Classified as <Feature>; grouped under <Workstream>.`
- **Explicit manual assignment**: `Manually assigned to <Feature>; grouped in <Workstream>.`
- **Completed task retained**: `Completed task; retained in <Workstream>.`
- **Unresolved task retained**: `Unresolved identity; retained in <Workstream>.`
- **Unfiled unresolved task**: `Unresolved identity; remains unfiled.`

Unresolved threads in existing workstreams retain their homes rather than
being dumped into unfiled.

## Revision safety and stale preview invalidation

Organize previews capture `catalogRevision` at generation time. Any Catalog
mutation — entity creation, renaming, reparenting, merging, task assignment, or
clearing an identity — increments `catalogRevision`.

When `catalogRevision` advances:
- The saved preview is marked stale (`isStale: true`).
- The UI displays an invalidation banner and disables the **Apply** button.
- Users are prompted to **Regenerate** the preview against the updated knowledge.
- Calling `bootstrap.apply` on a stale preview safely rejects with a `UserError`,
  preventing applying outdated grouping proposals.

## Preview and Apply

The preview lists the proposed workstreams with routing metadata and all assigned
roots, including roots that stay put. Uncheck a move to keep the current placement.
User-authored descriptions are preserved.

Apply consumes the saved preview, not another model result. It revalidates
section names and metadata; threads moved, hidden, archived, deleted or reparented
since the preview are skipped. New sections are created only for moves surviving
preflight.

The preview also lists unused homes for removal: completely empty sections, or
archived-only sections whose newest archive is over 24 hours old. Hidden
non-archived threads block removal. Apply rereads every member and rechecks the
24-hour rule.

Deleting a home preserves its threads and leaves its archived members unassigned.
Undo recreates the name and routing metadata, then restores eligible archived
members and roots moved by the batch. Activity records the application as one
undoable batch.

## Steady state

Between organizing runs, membership stays fixed while recaps, attention
indicators, titles, and snooze stay current independently.
