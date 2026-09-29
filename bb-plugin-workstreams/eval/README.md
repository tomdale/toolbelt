# Evaluation fixtures

Synthetic thread contexts for evaluating classification, recap, and drift
prompts (SPEC §10). They contain no real conversation data.

- `cases.json`, `holdout.json`: product/workstream identity and work state.
- `delegation.json`: manager, worker, and one-off threads that all live in one
  BB project; reproduces anchoring on the project name.
- `drift.json`: threads whose topic changes mid-conversation.

The evaluation runner is rebuilt with the analysis phase.
