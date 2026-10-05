# Topic classification evaluation

Run `node eval/classification.ts` with AI Gateway authentication available. This opt-in evaluation makes paid model calls and does not modify topic assignments or workstreams. Fixtures are synthetic; production has no fixture-specific rules or synonym tables.

`EVAL_MODEL` selects the model, `EVAL_OUTPUT` selects the report, `EVAL_COLD=1` removes known topics, `EVAL_REPETITIONS` repeats cases, `EVAL_HOLDOUT=1` selects reserved variants, and `EVAL_BASELINE` supplies a baseline prompt with a `__EVIDENCE__` placeholder. Reports retain raw responses, expected paths, mode, split, and repetitions. Invalid responses fail.

Cases cover product and capability ownership, repositories, scheduling, sibling capabilities, misleading titles, schema work, symptom versus defect ownership, follow-up work, display modes, shared SDK deliverables, infrastructure consumers, and unresolved requests. Holdouts test misleading titles and explicit ancestry.

Warm acceptance requires the expected existing topic. Cold acceptance checks owner, capability, and ordered ancestry against evaluation-only synonyms; more-specific descendants are permitted. Exact local-name path matching is reported separately. Scores do not evaluate invented descriptions or guarantee extra descendants are useful.

Rerun public and holdout splits after changing a prompt or model. Do not treat exact-match failures as a semantic error rate or a successful hierarchy score as proof descriptions are grounded.
