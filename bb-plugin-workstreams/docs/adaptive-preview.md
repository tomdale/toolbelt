# Catalog classification and adaptive organization

Workstreams retains product and feature identities in the Catalog separately
from the sections currently used for navigation. Catalog classification is
primary for New work suggestions, and adaptive grouping is primary for
organization.

## How it works

- **New work**: recognizes specific known products and features independently of
  current workstreams using the Catalog classifier (`classify`). When typing pauses,
  a suggested workstream home is provided. A specific feature can be chosen while
  placed into a broader existing workstream home.
- **Organize**: classifies roots missing a stored subject against the Catalog, then
  sends concurrent task counts by product and feature to the organizing model (`regroup`).
  Classification uses opening and recent user requests, title, recap, and project
  context to identify the product being worked on. Stored classifications are
  reconsidered when requests, title, or project change; turn activity and recap
  refresh alone do not invalidate them. Explicit manual selections remain authoritative.
  Missing or stale classifications run with up to three concurrent calls using the
  Organizing model, which also handles the separate grouping step. Progress displays
  completed, cached, and unresolved classifications before switching to grouping.
  Cancel stops new calls and ignores late results.

The default preview capacity is six concurrent roots, with contraction at three
roots per product (configurable in Organize settings). An indivisible subject can
exceed capacity in its own group. Each independent task is counted once under its
specific product or feature, rather than sending full conversations to the model.
“Current” refers to ongoing work: archived threads and child workers do not
inflate counts. Known current completed assessments do not add navigation
pressure; unresolved and completed roots retain their existing homes.

## Catalog and Workstreams

**Catalog** is the retained hierarchy of known **Products**, **Features**, and
subfeatures, whether or not they have current tasks. Each identity has a name,
description, explicit parent link, and aliases. Compound names are display labels
derived from ancestry; the Catalog shows nesting, while flat selectors show full
paths. Open **Workstreams → Catalog** to browse and maintain it; search matches
contextual names, aliases, and descriptions. Browsing does not activate workstreams
or move threads. The tab provides explicit operations for creating, editing,
reparenting, and merging identities.

**Workstreams** are the current navigation groups. A specific Feature can be
recorded in the Catalog while its tasks appear in a broader Product workstream.
**Current tasks** means independently actionable task roots, not simultaneous
model execution or accumulated history. A **Suggested workstream** is the
composer's proposed placement, not an instruction to continue another thread.

## Retained knowledge and revision safety

Product and Feature identities, and each task's classification, survive later
workstream contraction. Preview generation stores classifications and Catalog
discoveries, but does not move live threads until Apply.

Every Catalog mutation (entity rename, reparent, merge, task assignment, or clear)
bumps `catalogRevision`. Any saved organizing proposal records the revision at
generation time; if any semantic edit occurs before Apply, the preview is marked
stale (`isStale: true`) and Apply is disabled until regenerated, preventing
applying outdated navigation groups.

Apply uses the existing journal, snapshot guards, and undo support. Catalog
discoveries and assignments are retained independently of undoing navigation changes.

## Deliberate limits

The Catalog supports one parent per identity, not arbitrary ownership graphs.
It has no ambient discovery from title generation, automatic pruning, or
autonomous restructuring. There is no background scheduler or automated Apply;
organizing and applying are always explicit user actions.
