# Evaluation

`node eval/classification.ts` evaluates topic classification against synthetic topic trees. `EVAL_MODEL` selects a model, `EVAL_OUTPUT` selects the report, `EVAL_COLD=1` removes known topics, `EVAL_REPETITIONS` repeats cases, `EVAL_HOLDOUT=1` selects reserved variants, and `EVAL_BASELINE` supplies a baseline prompt with `__EVIDENCE__`. Reports retain raw responses, expected paths, mode, split, and repetitions. Fixtures are synthetic and production has no fixture-specific rules.

When changing the classifier prompt or model, compare warm known-topic matching and cold hierarchy choices. A successful hierarchy score does not prove descriptions are grounded; inspect raw responses and unsupported ancestry.

## Quick and Full analysis

`node eval/run.ts [model ...]` runs opt-in analysis evaluations against supported synthetic fixtures. Private reference fixtures and outputs belong in private storage; the runner enforces the configured private output root. Evaluation does not perform request routing or continuation decisions.
