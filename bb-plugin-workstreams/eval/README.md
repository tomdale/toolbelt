# Evaluation

Evaluations make paid AI Gateway calls and never apply their results to plugin
facts. Keep private reference fixtures and outputs outside the public
repository.

## Classification contracts

Run `node eval/classification.ts` for Full analysis, or
`EVAL_KIND=quick node eval/classification.ts` for the actual Quick prompt,
output schema, and parser. Quick flattens a synthetic case's requests into one
opening request; it does not measure conversation trajectories or the production
repair retry.

- `EVAL_MODEL`: model ID; default `google/gemini-3.8-flash`
- `EVAL_KIND`: `full` or `quick`
- `EVAL_REASONING_LEVEL`: explicit gateway effort; Quick defaults to `none`,
  Full to provider default
- `EVAL_OUTPUT`: JSON report path; default `/tmp/classification-eval.json`
- `EVAL_COLD=1`: remove known topics
- `EVAL_REPETITIONS`: repeat each case 1–20 times
- `EVAL_HOLDOUT=1`: use reserved cases

Reports retain responses and usage even on validation failures, with expected
paths, classification mode, repetitions, duration, cost, and p95 latency. The
runner exits nonzero when any case fails. Invalid identities fail rather than
being normalized into guessed topic IDs.

Compare warm main and holdout runs, cold hierarchy choices, and repetitions when
changing a prompt or model. Measure latency against the 15-second first-send
budget. A small perfect synthetic run is not a production accuracy estimate. See
[classification.md](classification.md) for scoring limitations.

## Identity trajectories

`node eval/identity.ts` evaluates establishment, refinement, subtask stability,
and an explicit user pivot through Full analysis and the identity-transition
policy. `EVAL_MODEL` defaults to `openai/gpt-6-luna-fast`; `EVAL_OUTPUT`
defaults to `/tmp/identity-eval.json`. The runner preserves raw outputs and
exits nonzero on a failed transition.

## Status fixtures

`node eval/run.ts [model ...]` runs analysis evaluations against supported
synthetic fixtures. Private fixture/output paths must satisfy the runner's
configured private storage policy.
