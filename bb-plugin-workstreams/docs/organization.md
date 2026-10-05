# Organization

Workstreams derives BB sections from root threads' topics. The topic assignment is authoritative: moving a root in BB's sidebar is logged and reverted; assigning another topic changes its workstream. Delegates follow their root.

## Organizer pass

The organizer is deterministic and makes no model calls. After relevant fact or lifecycle changes it:

1. Reads visible, non-archived roots, stored topic assignments, and statuses.
2. Chooses workstream topics according to active-root counts, capacity, collapse threshold, and existing valid bindings.
3. Creates, renames, or removes topic-bound sections and files roots to match.
4. Logs outside section changes, then restores topic-derived membership.
5. Prunes discovered topics that have no assigned roots, workstream, or child topics.

A pass uses the service's serial queue so reconciliation and section mutations cannot interleave. Each pass that changes sections or membership is recorded as one Activity entry. Topic edits and assignments are recorded too. Undo is available where it can preserve the topic-only rule; the organizer restores derived membership when a later pass runs.

## Starting topics

A root spawned from another thread inherits that thread's topic. A root started from a workstream's ＋ inherits the bound topic. Otherwise Quick analysis of the first request supplies a topic or leaves the root Unfiled. Explicit composer choices have manual priority. Full analysis may replace an inherited topic only when it reports a scope shift.

## Topic tree

Topics provide a workstream's name, description, and aliases. Edit them in Topics or with `bb workstreams topics`; merges remain manual. Discovered topics are pruned only when unused and childless. Database names remain stable for migration compatibility.

## Observability

The Organization page reports organizer state and agent-report coverage. `bb workstreams organization` reads current state; `bb workstreams organization --rebuild` runs a fresh pass. `bb workstreams log` shows Activity, including a sidebar move and its automatic reversion.

The composer preview is Quick analysis, not an organization preview. See the [plugin specification](../SPEC.md) for the lifecycle contract.
