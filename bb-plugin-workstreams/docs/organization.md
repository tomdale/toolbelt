# Live-derived workstreams organization

A workstream is a recognizable ongoing effort represented by a native BB
section. Workstreams are **always derived automatically** from active task
identities in the Catalog. Navigation syncs automatically to BB native sections
without manual placement or preview/apply staging.

## How live derivation works

The system operates continuously through a coordinated automatic lifecycle:

### 1. Classification

Roots missing a fresh stored subject are classified against the Catalog using
the `classify` model. Inputs contain the thread title, recap, project context,
and relevant user requests.
Explicit manual selections (`provenance: manual`) remain authoritative and are
never overwritten by automatic classification. Missing or stale classifications
run with bounded concurrency. Manual unresolved tasks persist as explicit null
assignments.

### 2. Deterministic regrouping

Once active roots have assignments, the coordinator groups them
deterministically using `deriveActiveEntityIds` from `domain/regroup.ts`:

- **Partition by product roots**: Entities are grouped under their top-level Catalog product (`parentId === null`).
- **Group capacity**: Maximum active tasks per workstream (default: 6). Leaf feature identities above capacity may stand as indivisible leaf groups.
- **Contraction threshold**: At or below this product task count (default: 3), navigation contracts to the broad product root workstream.
- **Active count vs. completed retention**: Only active (non-completed) roots drive capacity and expansion pressure. Completed tasks exert 0 expansion pressure and remain navigable under their product root.
- **Stability**: Existing active workstream homes are preserved when they continue to satisfy capacity and coverage constraints.
- **Unresolved tasks**: Tasks with unresolved identities map to Unfiled (`sectionId: null`) and are surfaced in `state.unresolved`.

## Organize pane

The **Workstreams → Organize** pane explains the current live projection:

- **Status and progress**: Live state (`idle`, `classifying`, `deriving`, `syncing`, `failed`), progress metrics, and error reporting with a **Try again** retry action.
- **Counts summary**: Active tasks, active workstreams, unresolved tasks, and completed tasks retained.
- **Derived workstreams**: Current workstreams with active and total counts, member tasks, feature identities, and derivation reasons.
- **Unresolved correction**: Dedicated section listing unfiled unresolved tasks with inline product/feature assignment controls. Correcting an identity immediately updates navigation.
- **Rebuild**: Explicit action to re-run full derivation across all active threads.

## Catalog and derived navigation

The **Catalog** is the retained hierarchy of known Products and Features.
Workstream navigation groups are derived from Catalog structure:
- Catalog entries label their current navigation home as derived.
- Editing the Catalog (renaming, reparenting, merging) automatically updates navigation.
- Task identity corrections (assigning or clearing a product/feature) trigger immediate derivation.
