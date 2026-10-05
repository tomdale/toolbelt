# Workstreams

Workstreams keeps BB threads' goals, topics, status, and activity current, then derives native BB workstreams from each root's topic.

## Phases

- **Quick analysis** runs on a composer draft or first request and returns a goal and topic. A matching composer result is reused when the first request is sent.
- **Full analysis** runs at turn end, settles the goal and topic, and supplies recap and fallback status only when the agent did not report.
- **Organization** deterministically syncs workstreams and membership from topic assignments without model calls. Sidebar moves are logged and reverted; changing a topic changes the workstream.
- **Activity** records automatic and observed changes, with undo where supported.

A thread spawned from another thread inherits its topic; a thread created from a workstream's ＋ inherits that workstream's topic. Otherwise Quick analysis classifies its first request or leaves it Unfiled. Explicit composer choices are manual.

The sidebar includes Up Next, Recent, workstream groups, snooze, and archive views. The **Organization** page shows current derived state; **Topics** manages the topic tree; **Activity** shows changes and model calls. Settings separate the Quick analysis and Full analysis models.

The recap tool's `goal` field remains unchanged for compatibility with running agent sessions.

See [README.md](README.md) for usage and [SPEC.md](SPEC.md) for the product contract.
