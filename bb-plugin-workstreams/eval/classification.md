# Subject classification evaluation

Run `node eval/classification.ts` with AI Gateway authentication available to Pi. This opt-in evaluation makes paid model calls and does not change the Catalog or navigation. Fixtures are synthetic; production routing has no fixture-specific rules or synonym tables.

`EVAL_MODEL` selects the model (default `google/gemini-3.8-flash`). `EVAL_OUTPUT` selects the JSON report. `EVAL_COLD=1` removes known identities. `EVAL_REPETITIONS` repeats each case; `EVAL_HOLDOUT=1` selects three request variants reserved until after candidate tuning. `EVAL_BASELINE` accepts a prompt text file whose `__EVIDENCE__` placeholder receives production Markdown. Calls have three-worker concurrency, a four-minute deadline, and the same output budget for baseline and candidate.

The main 13 cases cover tools, repositories, scheduling mechanisms, sibling capabilities, misleading titles, schema work, symptom versus defect ownership, follow-up builds, display modes, shared SDK deliverables, shared infrastructure consumers, tools as actual owners, and unresolved requests. The holdout variants test misleading titles and explicit SDK/recap ancestry.

Warm acceptance requires the expected existing ID. Cold acceptance checks owner, capability, and ordered required ancestry against evaluation-only synonyms. More-specific descendants are permitted. Exact local-name path matching is reported separately. These metrics do not evaluate invented details in descriptions or guarantee every extra descendant is useful. Reports retain raw responses, expected paths, mode, split, and repetitions for inspection. Invalid responses fail.

## Controlled observations

Using the same model, fixtures, budgets, and semantic scorer, two main cold runs accepted baseline 18/26 and final candidate 25/26. Two holdout runs accepted baseline 0/6 and candidate 4/6. Known-Catalog matching passed 13/13 for the candidate. These are small-sample observations, not a reliability guarantee. The scorer's Actions/Automation runs alternatives were added during diagnosis and applied equally to both controlled runs; they were not independently frozen before tuning.

The candidate explicitly separates owner, capability and subcapability; preserves evidenced intermediate parents; prioritizes request scope over titles; and distinguishes named tool products from a product's SDK feature. Tested misleading recap titles and detached SDK ancestry improved. Remaining errors included an invented Displays parent, question-and-answer naming outside the accepted alternatives, and unsupported real-world product descriptions. The description hallucinations are not counted by hierarchy acceptance and remain a genuine limitation.

Rerun both splits and warm matching after changing prompt or model. Do not use exact-match failures alone as a semantic error rate, or successful hierarchy checks as proof that descriptions are grounded.
