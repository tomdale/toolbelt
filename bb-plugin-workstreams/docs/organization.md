# Organization

Workstreams derives BB sections from root threads' topics. The topic assignment
is authoritative: moving a root in BB's sidebar is logged and reverted;
assigning another topic changes its workstream. Delegates follow their root.

## Organizer pass

The organizer is deterministic and makes no model calls. After relevant fact or
lifecycle changes it:

1. Reads visible, non-archived roots, stored topic assignments, and statuses.
2. Chooses workstream topics according to visible-root counts, capacity,
   collapse threshold, and existing valid bindings.
3. Creates, renames, or removes topic-bound sections and files roots to match.
4. Logs outside section changes, then restores topic-derived membership.
5. Prunes discovered topics that have no assigned roots, workstream, or child
   topics.

A pass fingerprints both policy and facts, validates its topic/policy plan
before mutations, and uses the service's serial queue so reconciliation and
section mutations cannot interleave. Superseded plans schedule a fresh pass.
Capacity and contraction changes trigger organization immediately. Every
visible, non-archived root counts toward capacity, including completed roots.
Within capacity, a split is retained only when at least two groups have visible
roots. A previously contracted group stays contracted until capacity requires
splitting; completion alone does not change its grouping. Persistent collapse
preferences use stable topic IDs and synchronize mounted surfaces and windows
independently of automatic grouping. In the tiered sidebar (any workstream
focused), revealing and expanding the other workstreams is temporary per-view
state; hiding and revealing that block starts it collapsed. Each pass that
changes sections or membership is recorded as one Activity entry. Topic edits
and assignments are recorded too. Undo is available where it can preserve the
topic-only rule; the organizer restores derived membership when a later pass
runs.

## Starting topics

A root spawned from another thread inherits that thread's topic. A root started
from a workstream's ＋ inherits the bound topic. Otherwise Quick analysis of the
first request supplies a topic or leaves the root Unfiled. Explicit composer
choices have manual priority. Automatic Full analysis may replace an inherited
topic only when it reports a scope shift. Explicit user approval of a repair
plan can also correct an inherited assignment; that correction has Full
provenance and remains eligible for future automatic updates.

## Topic tree

Topics provide a workstream's name, description, and aliases. Edit them in
Topics or with `bb workstreams topics`; merges remain manual. Discovered topics
are pruned only when unused and childless. Database names remain stable for
migration compatibility.

## Reviewing topic repairs

A preview accepts up to 100 roots. With larger sets, use
`bb workstreams topics preview <thread-id>` followed by
`bb workstreams topics apply <plan-id>` for each root you want to repair.

Use Organization → Preview topic repairs, or
`bb workstreams topics preview [thread] --json`, after changing topic
definitions. Preview uses production evidence and parsing but changes no
assignments, titles, or status. Review the before/after paths, then apply with
the button or `bb workstreams topics apply <plan-id>`. Manual topics are
excluded. Plans expire after 30 minutes and reject topic-definition changes;
apply skips newer thread evidence or corrections and consumes each reviewed row
once. Temporary SDK read failures retain unprocessed rows for retry with the
same plan ID. A completed apply consumes the plan. A new preview replaces the
previous preview.

## Observability

The Organization page reports organizer state, active and completed counts,
visible-root grouping pressure, capacity and contraction policy, and
agent-report coverage. `bb workstreams organization` reads current state;
`bb workstreams organization --rebuild` runs a fresh pass. `bb workstreams log`
shows Activity, including a sidebar move and its automatic reversion.

The composer preview is Quick analysis, not an organization preview. See the
[plugin specification](../SPEC.md) for the lifecycle contract.
