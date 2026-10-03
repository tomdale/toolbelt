# Subject classification evaluation

Run `node eval/classification.ts` with AI Gateway authentication available to Pi. This opt-in evaluation makes paid model calls and does not change the Catalog or navigation. Fixtures are synthetic and contain no real product-specific routing rules.

`EVAL_MODEL` selects the model (default `google/gemini-3.8-flash`). `EVAL_OUTPUT` selects the JSON report path. `EVAL_COLD=1` removes known identities to test discovery. `EVAL_BASELINE` accepts a prompt text file with `__EVIDENCE__` replaced by the production Markdown input.

The 13 cases cover execution tools, repository context, scheduling mechanisms, sibling capabilities, misleading titles, schema work, symptom versus defect ownership, follow-up builds, display modes, shared SDK deliverables, shared infrastructure consumers, tools as actual owners, and unresolved requests.

Warm results compare the existing identity ID exactly. Cold results compare the proposed local-name ancestry exactly; this is a strict naming-and-hierarchy check, not a semantic ownership score. Reports retain expected paths and responses for manual review. A semantically reasonable synonym can fail the cold check.

## Observed results

On the tested prompt pair, warm Catalog matching scored 13/13 for both baseline and updated rules. This demonstrates coverage, not measured improvement.

Cold discovery remained inconsistent: the final updated prompt scored 1/13 on exact path matching. Most outputs identified plausible owners but changed feature names or flattened ancestry. The misleading-title case still inferred unrelated real-world scope, and the SDK case promoted the SDK to a root. Earlier baseline cold calls used a lower output budget and included truncated JSON, so their aggregate is not a fair accuracy comparison.

These rules clarify the intended contract. They do not establish reliable empty-Catalog discovery or eliminate the need for review. Model and prompt changes should rerun both warm and cold cases.
