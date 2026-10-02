# Catalog classification and adaptive previews

Workstreams can retain product and feature identities separately from the sections currently used for navigation. The experiments are opt-in; neither option starts a background organizer.

## Enable the experiments

In Workstreams settings:

- **New work → Catalog classification (experimental)** identifies a specific known subject independently of current groups. A subject can be placed under an existing broader group. This path does not suggest thread continuation and leaves project/environment selections unchanged.
- **Organize → Adaptive preview (experimental)** classifies roots missing a stored subject, then sends current task counts by product and feature to the selected organizing model. Review the proposal and use Apply to change sections or placements.

The default preview capacity is six concurrent roots, with contraction at three roots per product. These values are configurable experimental policy, not a guarantee of human navigation quality. An indivisible subject can exceed capacity in its own group. Each independent task is counted once under its specific product or feature, rather than sending its full conversation to the organizing model. “Current” refers to ongoing work, not simultaneous model execution: archived threads and child workers do not inflate these counts. Known current completed assessments do not add navigation pressure; unresolved and stale assessments are counted conservatively.

## Catalog and Workstreams

**Catalog** is the retained set of known **Products** and **Features**, whether or not they have current tasks. Open **Workstreams → Catalog** to browse it; search matches contextual names, aliases, and descriptions. Browsing does not activate workstreams or move threads.

**Workstreams** are the current navigation groups. A specific Feature can be recorded in the Catalog while its tasks appear in a broader Product workstream. **Current tasks** means independently actionable task roots, not simultaneous model execution or accumulated history. A **Suggested workstream** is the composer's proposed placement, not an instruction to continue another thread.

## Retained knowledge

Existing sections seed exact Catalog identities without guessing relationships from colon-separated names. Classification can propose a specific identity and an explicit known parent. Product and Feature identities, and each task's classification, survive later workstream contraction. Opening the workstream chooser also exposes known products/features and retained aliases. Selecting an inactive feature can use its broader existing home while preserving the selected subject.

Preview generation can store classifications and corpus discoveries, but does not move live threads. Apply uses the existing journal, snapshot guards, and undo support. Corpus discoveries are retained independently of undoing navigation changes.

## Deliberate limits

The minimal corpus supports one parent per identity, not arbitrary ownership graphs. It has no ambient discovery from title generation, automatic pruning, or autonomous restructuring. Previously stored thread subjects are not continuously reassessed. The legacy organizer and intake behavior remain available when their respective experiments are disabled.

Workstreams does not inject task/delegate execution roles or project-shape guidance. Question and recap configuration remains available; execution guidance belongs to the owning repository or environment plugin.
