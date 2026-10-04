# Catalog classification and live-derived organization

Workstreams retains product and feature identities in the Catalog separately
from the sections currently used for navigation. Catalog classification identifies
the product or feature a task concerns, and deterministic grouping derives
active navigation workstreams automatically.

## How it works

- **New work**: users select the most specific known Product or Feature from the
  Catalog, accept an automatic classification suggestion, or mark the task
  Unresolved. New work never solicits a destination workstream. On submission,
  the coordinator derives section navigation automatically.
- **Continuous derivation**: the coordinator monitors thread lifecycle events
  (new threads, turn completion, completion/resumption, archival) and Catalog edits.
  It classifies missing roots, derives active workstream groups deterministically,
  and syncs native BB sections.
- **Organize pane**: explains the current live projection with counts, member
  feature identities, derivation status/progress/error, and inline unresolved
  correction controls. Failures offer an immediate retry button.

## Capacity and contraction algorithm

Derived navigation follows a deterministic grouping algorithm (`deriveActiveEntityIds`):
1. **Partition by Product Roots**: threads are partitioned under their root Catalog product.
2. **Active vs. Completed Counts**: active tasks drive capacity pressure. Completed tasks
   exert 0 expansion pressure and are retained under their product root.
3. **Contraction Threshold**: products with active tasks $\le$ contraction threshold
   contract to their root workstream.
4. **Capacity Policy**: if active load exceeds capacity, the algorithm extracts child
   feature clusters until the parent's load is within capacity. Indivisible leaf features
   above capacity remain as exact overflow groups.
5. **Stability**: previously derived homes that continue to satisfy policy are preserved
   to avoid unnecessary navigation churn.

## Catalog maintenance

- **Catalog** is the retained hierarchy of known Products, Features, and subfeatures.
- Catalog items display their derived navigation home.
- Editing an entity (name, parent, metadata, merge) immediately triggers automatic
  derivation and updates the sidebar.
