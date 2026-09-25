# Workstreams for BB

All your active threads, grouped by the project or product they concern. Open
**Workstreams** in the sidebar (`/plugins/workstreams/home`).

- Every visible, non-archived thread appears, including idle threads. The list
  is paginated, not limited to recent activity.
- Before analysis, threads are grouped by their BB project.
- **Analyze threads** reads each thread's title, project/repository, checkout
  path, initial text request from BB's event log, last three prompts in
  chronological order, and last assistant response. Initial intent is explicitly
  historical; later substantive scope changes take precedence. Excerpts are
  deduplicated and bounded (up to 2,400 initial-request characters, 1,500 per
  recent prompt, and 2,500 from the assistant report). It does not read files,
  tool output, external history, GitHub, or Linear. A separate one-line-per-
  request timeline (with event seqs) feeds side-quest detection.
- Up to four batches of eight threads are classified concurrently with their
  conversation context. Short request-local IDs are mapped back to BB thread IDs
  in code. Code strips packaging descriptors from group names (“Foo plugin”,
  `bb-plugin-foo`, “BB - feature”) and normalizes case, spaces, underscores, and
  hyphens. It keeps product qualifiers (“BB Recap”) and never semantically
  merges labels.
- Each thread gets a short inferred title, a recap of where it stands (at most
  180 characters; longer ones are clipped), and a work state: needs decision,
  ready for review, blocked, in progress, or done. The first two count as “Needs
  you”. Runtime status appears only when it matters (running, error) and is
  never used as evidence of work state.
- The screen is a one-line-per-thread list with the work state in a left column:
  larger groups first, one-thread groups folded into “Other groups”,
  Unclassified before them, done work dimmed. Group chips jump between groups; a
  “Needs you” filter and search (`/`) cover inferred and original titles,
  recaps, projects, and groups. Clicking a row opens the thread.
- Results appear together when analysis completes and survive reloads. Rows are
  marked “Not analyzed” (new), “Updated since analysis”, or “Not refreshed”. A
  failed batch is retried once; if it still fails, those threads keep their
  earlier result marked “Not refreshed” and the rest of the run is saved. If
  every batch fails, previous results are unchanged. A running analysis shows
  progress and can be cancelled. The footer reports the last run's time, calls,
  tokens, and Gateway cost.

## Inference

Uses **GPT-4.1 mini** (`openai/gpt-4.1-mini`) through **Vercel AI Gateway**,
using Pi's existing authentication on the analysis machine. This is a
non-reasoning model; no fallback to an expensive default.

Pi runs in print/JSON mode (for token usage and cost) with tools, extensions,
skills, prompt templates, context files, project approval, and session
persistence disabled. Prompts go through stdin, not process arguments. Calls
time out after two minutes. No BB worker threads are spawned. Plugin shutdown
aborts in-flight host calls.

With one connected machine, selection is automatic. With multiple machines, set
**Analysis machine ID** in Workstreams settings to the machine with Pi and AI
Gateway configured. The `pi` executable must be on that machine's host-worker
PATH. No new credentials are stored by this plugin.

Analysis is manual. Thread excerpts are sent to the selected model; common
credentials are redacted on a best-effort basis, not a guarantee. Recaps reflect
conversation evidence, not independently verified code state. Only the latest
classification results are persisted; excerpts are not stored by the plugin.

## Side quests and organizing

A side quest is a thread that began on one product and was steered, partway
through, onto a different one. A separate per-thread pass reads the request
timeline and reports the mainline product, the side-quest product, titles for
both, the seq of the first side-quest request, and a confidence. Each thread is
checked twice; high confidence requires both checks to agree on the split point.
Drifted threads are grouped under the side quest.

**Organize** (button or `bb workstreams organize`) changes threads:

- Splits high-confidence side quests: forks the thread just before the side
  quest (reusing its environment, titled after the mainline, filed in the
  mainline's section, seeded with a note linking back), renames the original
  after the side quest, and compacts it. BB can't truncate a thread or fork
  inside turns delivered from another thread, so the fork ends at the last
  forkable request before the split. Medium-confidence side quests get a
  one-click **Split** on their row instead.
- Renames messy titles (raw prompts, URLs, truncation) to the inferred title.
- Files every classified thread into a section named after its group, creating
  sections as needed.

With **After analysis** set to `auto` (the default), organize runs after each
analysis; `suggest` only offers splits and the Organize button. Threads that
changed since analysis are skipped. Every change is logged under “Changes made
by Workstreams” with **Undo**: undo archives the fork and restores the title or
section. Compaction cannot be undone.

No task tracking, priorities, external collectors, or editable workstream
database. Legacy workstream data is left untouched but is no longer used.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
bb plugin reload workstreams
```

- `server.ts`: active-thread inventory, bounded context collection, analysis
  orchestration, latest-result persistence.
- `context.ts`: bounded, attributed initial/recent context and redaction.
- `model.ts`: inference prompts, result validation, concurrency and display
  grouping.
- `host.ts` / `pi.ts`: isolated, tool-free Pi inference via AI Gateway and its
  JSON output parsing (shared with the eval runner).
- `drift.ts`: side-quest detection; `organize.ts`: organize planning and the
  change log.
- `app.tsx` / `app.css`: grouped thread overview.
- `scripts/screenshot.sh`: replays a frozen context file and screenshots desktop
  and mobile widths.
- `eval/`: opt-in paid model comparison with synthetic regression and holdout
  cases; see [evaluation instructions and results](eval/README.md).

CLI: `bb workstreams list` shows the inventory, latest results, and change log;
`analyze`, `cancel`, and `organize` match the buttons.

For iteration, `bb workstreams export /abs/private.json` freezes live thread
context, and `bb workstreams fixture /abs/private.json` replays such a file (or
`eval/*.json`) in the real UI instead of live threads, with separate results and
a log of planned, never performed, organize actions. `fixture off` returns to
live threads. Keep exports in private storage: they contain conversation
excerpts.

Unchanged classifications are not reused between runs: every analysis
reclassifies every active thread, so there is no stale cache to force past.
