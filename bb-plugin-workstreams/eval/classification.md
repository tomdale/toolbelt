# Topic classification evaluation

Run `node eval/classification.ts` with AI Gateway authentication available. This
opt-in evaluation makes paid model calls and does not modify topic assignments
or workstreams. Fixtures are synthetic; production has no fixture-specific rules
or synonym tables.

`EVAL_KIND=quick` selects the actual Quick prompt, schema, and parser; the
default is Full analysis. Quick combines synthetic requests into one opening
request and does not evaluate temporal behavior. `EVAL_MODEL` selects the model,
`EVAL_REASONING_LEVEL` selects effort, `EVAL_OUTPUT` selects the report,
`EVAL_COLD=1` removes known topics, `EVAL_REPETITIONS` repeats cases, and
`EVAL_HOLDOUT=1` selects reserved variants. Reports retain raw responses and
usage even on parser failures, expected paths, mode, split, repetitions,
durations, cost, and p95 latency. Invalid responses fail and produce a nonzero
exit status.

Cases cover product and capability ownership, repositories, scheduling, sibling
capabilities, misleading titles, schema work, symptom versus defect ownership,
follow-up work, display modes, shared SDK deliverables, infrastructure
consumers, and unresolved requests. Holdouts test misleading titles and explicit
ancestry.

The specificity cases test work on one capability of a broad topic with no topic
for that capability: the answer is a new topic beneath the broad one. Work on
the broad topic as a whole, or a task naming no capability, keeps the broad
topic. The new-topic cases test the tree they carry, so cold runs skip them.

The lookalike cases carry their own topic tree, with a pane topic filed under an
unrelated app whose description fits the request. The request names its owner.
When the platform's own plugin topic exists beside the pane, it is the expected
topic. When it does not, the answer is a new topic outside the app's subtree;
choosing the pane, the app, or no topic fails, and a proposal is anchored as
production anchors it. These cases test the tree they carry, so cold runs skip
them.

Warm acceptance requires the expected existing topic. Cold acceptance checks
owner, capability, and ordered ancestry against evaluation-only synonyms;
more-specific descendants are permitted. Exact local-name path matching is
reported separately. Scores do not evaluate invented descriptions or guarantee
extra descendants are useful.

Rerun public and holdout splits after changing a prompt or model. Do not treat
exact-match failures as a semantic error rate or a successful hierarchy score as
proof descriptions are grounded.
