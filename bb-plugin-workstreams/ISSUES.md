# Workstreams issues

This list distinguishes confirmed defects from SDK limitations and intentional
behavior. Resolved defects belong in regression tests and Git history, not an
open bug list. Paths below are relative to this package.

## Open limitations

### Provider-worker generation controls and telemetry

**Evidence:** `src/server/inference/worker.ts`, `src/server/index.ts`, and the
released SDK 0.6.5 `ThreadSpawnArgs` / `ThreadOutputResponse` types.

Non-Gateway models run in hidden BB threads. The spawn API has no output-schema
or output-token-limit fields, and `threads.output` returns text only. Responses
are parsed and validated, but generation cannot be constrained in the same way
as a direct Gateway call. Usage, cost, and reasoning metadata are unavailable;
worker traces use `usage: null`, not fabricated zero usage.

**Workaround:** Use a Gateway model for constrained Quick analysis and reported
usage. The requested completion API is recorded in the repository's
[BB SDK wishlist](../docs/bb-sdk-wishlist.md#plugins-call-the-users-ai-service-and-model-catalog).
Do not infer total spend from the sum of reported costs when worker calls exist.

### User-selected colors

**Evidence:** `src/domain/spinner.ts`, `src/app/settings/SpinnerSettings.tsx`,
and `src/domain/workstreamHue.ts`.

Custom colors accept any valid hex value, including low-contrast choices.
Workstream hues are stable hashes, not a perceptually spaced palette; two
workstreams can have similar hues. Labels and status text remain necessary;
color is not an identity or status guarantee.

### Best-effort redaction

**Evidence:** `src/domain/redact.ts`.

Regex masking covers common credential shapes, not every possible secret. It is
not an access-control or data-loss-prevention boundary. Inspect diagnostic
exports before sharing; don't put secrets in prompts. Provider processing
policies apply to conversation excerpts sent for analysis.

## Audit findings that are not defects

- **Completed roots in grouping:** Completed roots count toward the contraction
  threshold just like other visible roots, so finishing work never regroups a
  product; see `tests/server/grouping-regressions.test.ts`.
- **Nested Up Next / archive destinations:** Up Next contains only roots, so
  delegates cannot become separate archive destinations in that band. See
  `tests/domain/upNext.test.ts` and `tests/domain/archiveNavigation.test.ts`.
- **Projection defaults:** The pure forest projection has no stored analysis
  input, so its default attention predicate can only inspect native pending
  interactions. App and CLI callers supply the shared `needsAttention` rule.
- **Archive suggestion withdrawal:** `useArchiveSuggestion` deliberately treats
  drafting a continuation as declining Archive for that recap. Clearing the
  draft does not restore it; a new recap can offer Archive again. This behavior
  is explicitly covered in `tests/app/recap-card.test.tsx`. The thread header
  and context menu remain available for deliberate archive actions.
- **Human labels versus JSON states:** “Working” / “needs you” are prose;
  `in_progress` / `needs_decision` are serialized work states. Runtime `error`
  is a BB thread status, not an inferred `WorkState` value.
- **Short labels:** “On update” is the compact version of “Until it updates”;
  “New threads” names a settings section while “New work…” is an action. These
  are not separate features or state values.
- **Snooze dates:** A weekday rule is always a future day: Saturday at 9 AM
  chosen on a Saturday means next Saturday. Use a Today rule or Custom for the
  current day.
- **Activity compatibility values:** Old proposal action/link kinds remain
  readable because retained Activity rows and traces can still use them.
- **Retitle enablement checks:** Re-checking title settings after awaited SDK
  work protects against a setting change during the request, not redundant
  validation.

## Regression coverage for confirmed defects

- Topic edit refresh and retry: `tests/app/catalog.test.tsx`.
- Topic dialog name, description, and alias limits:
  `tests/app/topic-dialog-limits.test.tsx`.
- Activity debug filters and empty states: `tests/app/activity-debug.test.tsx`.
- Overview search counts: `tests/app/page.test.tsx`.
- Setting-save errors and title-lock copy: `tests/app/settings.test.tsx`.
- Snooze rules, preset repair, and valid custom snoozes:
  `tests/domain/snooze.test.ts`, `tests/app/custom-snooze-dialog.test.tsx`,
  `tests/app/snooze-settings.test.tsx`.
- Question answer limits and attachment availability: `tests/app/question/`.
- Sidebar ordering/drop affordances and shared band preferences:
  `tests/app/drop.test.ts`, `tests/app/sidebar.test.tsx`.
- CLI JSON, bounded output, diagnostics, and topic-repair titles:
  `tests/server/cli-topics.test.ts`, `tests/server/service.test.ts`,
  `tests/server/trace.test.ts`, `tests/server/reclassification.test.ts`.
- Shared attention rules and response validation: `tests/domain/status.test.ts`,
  `tests/domain/analysis.test.ts`, `tests/domain/recap.test.ts`.
- Unknown worker usage: `tests/server/worker.test.ts`.
- Bounded inspector history explicitly reports truncation:
  `tests/app/inspector-limit.test.tsx`.
