# Analysis evaluation

`run.ts` runs the production per-thread analysis prompt and parser
(`src/domain/analysis.ts`, SPEC §10) against fixtures, through Pi's AI Gateway,
and scores the results. It is opt-in and never part of `npm test`.

```sh
node eval/run.ts                              # both candidate models
node eval/run.ts google/gemini-3.1-flash-lite # one model
EVAL_OUTPUT=/tmp/eval.json node eval/run.ts   # also write per-case results
```

## Fixtures

All committed fixtures are synthetic. A fixture's `project` field records
provenance only; it is never sent to the model.

- `cases.json`, `holdout.json`: product identity (`expected` subject names).
- `delegation.json`: manager, worker, and one-off threads that share one BB
  project; guards against anchoring on the project.
- `state.json`: one case per work state (`expectedState`).
- `drift.json`: threads whose latest request moved to another product (`drift`
  set) and healthy threads (`drift: null`).

The private reference set (32 real threads with approved subject labels) lives
in BB thread storage, never in this repository. Run it with:

```sh
EVAL_PRIVATE=<private cases.json> EVAL_PRIVATE_ROOT=<private dir> \
EVAL_OUTPUT=<private dir>/eval.json node eval/run.ts
```

The runner refuses a private fixture unless `EVAL_OUTPUT` is inside
`EVAL_PRIVATE_ROOT`.

## Modes

- **Cold:** the thread has no workstream. Scores `subject` against `expected`
  (strict, ignoring case and punctuation; `null` matches `Unclassified`),
  pairwise grouping, and `state`.
- **Warm:** the thread is filed under its product (or, for a side quest, its
  original product) and offered every other fixture product as a drift target.
  Scores drift detection on side quests and high-confidence false alarms on
  healthy threads. Only high-confidence drift is surfaced to users.

## Pass bar

A prompt or model change ships only if it meets every line:

| Metric                                       | Bar          |
| -------------------------------------------- | ------------ |
| Valid JSON                                   | all cases    |
| Subjects, `cases` + `holdout` + `delegation` | ≥ 24/28      |
| Subjects, private reference set              | ≥ 20/32      |
| `state.json` states; needs-decision recall   | ≥ 10/11; 3/3 |
| Drift detected on side quests                | ≥ 3/4        |
| High-confidence drift false alarms           | ≤ 5%         |
| Median call latency                          | ≤ 4 s        |

## Current result (2026-09-29, prompt at the Phase 2 commit)

| Model                          | Public subjects | Private | State | Drift | False alarms | Median | Cost/call |
| ------------------------------ | --------------- | ------- | ----- | ----- | ------------ | ------ | --------- |
| `google/gemini-3.1-flash-lite` | 26/28           | 20/32   | 11/11 | 3/4   | 2/50         | 3.6 s  | ~$0.0015  |
| `openai/gpt-4.1-mini`          | 21/28           | 15/32   | 10/11 | 0/4   | 1/50         | 1.2 s  | ~$0.0004  |

Gemini 3.1 Flash-Lite passes and is the default. GPT-4.1 mini is faster and
cheaper but misses the private subject bar and drift detection.
