# Workstreams for BB

Workstreams maintains BB threads' goals, topics, status, and activity. A root's **Topic** determines its **Workstream** (a native BB section); delegates use their root's topic and section. A sidebar move is logged and reverted. Change a root's topic to change its workstream.

## How it works

- **Quick analysis** runs on a draft while typing and on a new thread's first request. It returns a goal and topic; the matching preview is reused when that first request is sent. A quick topic files the thread immediately.
- **Full analysis** runs at turn end. It settles the goal and topic, and supplies recap, status, and needs-you only when the agent did not report.
- **Starting topics** inherit from a source thread or workstream's ＋. Otherwise Quick analysis classifies the first request or leaves it Unfiled. Explicit Topic picks are manual.
- **Organization** deterministically groups topics and syncs native sections after facts change; it makes no model calls. The Organization tab reports current state and agent-report coverage.
- **Topics** manages the topic tree. **Activity** records changes, outside moves and reversion, and model calls, with undo where supported.

Full analysis also observes product and feature names mentioned in its conversation excerpts, with product associations where supported. Observations accumulate per thread independently of topics, including while Debug mode is off. With Debug mode enabled, open **Observed names** in the thread header to see names, analysis-run counts, and first/last-seen times on hover. These observations persist beyond model-trace retention and are removed when the thread is deleted. Skipped analysis calls add nothing; existing history is not backfilled.

The recap tool's `goal` field remains unchanged for compatibility with running agent sessions.

## CLI

```sh
bb workstreams list [--json]
bb workstreams show <workstream> [--json]
bb workstreams organization [--rebuild] [--json]
bb workstreams log [--since 7d] [--external] [--json]
bb workstreams analyze [<thread>] [--json]
bb workstreams undo <entry-id>
bb workstreams trace [<id>] [--thread <id>] [--entry <id>] [--kind <kind>] [--json]
bb workstreams topics list|show|create|edit|reparent|merge …
bb workstreams thread show|assign|clear|reclassify …
```

Run `bb workstreams --help` for argument details.

## Settings

Quick analysis and Full analysis have separate model settings. The Quick analysis model remains available when typing suggestions are disabled because first-send analysis still uses it. Capacity and collapse threshold control grouping; other settings cover titles, sidebar, recaps, snooze, and display.

## Development

Build and verify in an isolated task worktree; deploy only from the canonical checkout.

```sh
npm ci
npm run typecheck
npx vitest run
npm run build
```

Then run the repository's `scripts/bb-plugin-smoke` against this package. Opt-in model evaluations are in [eval/README.md](eval/README.md); they make paid calls and are not part of the test suite. See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) and [Organization](docs/organization.md) for details.
