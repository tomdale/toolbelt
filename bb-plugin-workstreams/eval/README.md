# Workstreams quality evaluation

Opt-in, paid AI Gateway calls using Pi's existing credentials. Fixtures are
synthetic, with explicit product ownership, inspired by observed failure modes;
they contain no private transcripts. No model calls run in `npm test`.

Run from the plugin directory with Node supporting TypeScript type stripping:

```sh
node --experimental-strip-types eval/run.mjs
EVAL_CASES=holdout.json node --experimental-strip-types eval/run.mjs openai/gpt-4.1-mini
EVAL_REVERSE=1 node --experimental-strip-types eval/run.mjs openai/gpt-4.1-mini
EVAL_BATCH=32 node --experimental-strip-types eval/run.mjs openai/gpt-4.1-mini
EVAL_OUTPUT=/tmp/workstreams-eval.json node --experimental-strip-types eval/run.mjs openai/gpt-4.1-mini
```

The default compares GPT-4.1 mini, GPT-4o mini, and GPT-4.1 nano sequentially,
with up to four parallel batches within a trial. All use thinking off, no tools
or ambient resources, and the production classification prompt/parser. No
retries or model fallback. A contract failure counts as a failed run, not a
partial success. Responses are included for diagnosis. For private real-thread
fixtures, use an absolute `EVAL_CASES` path and set `EVAL_OUTPUT` inside
`EVAL_PRIVATE_ROOT`; the runner then prints aggregate results only. Keep those
fixtures and reports in private thread storage, not this repository.

## Scoring

Each fixture declares acceptable product names before evaluation. Matching
ignores punctuation, whitespace and case. `firstCorrect` measures the classifier
output; `finalCorrect` measures the production-normalized output. The two can
differ if name normalization damages a correct assignment. Run order can be
reversed to expose batch/order sensitivity. `pairs` separately counts expected
same-product pairs recovered and unrelated pairs wrongly merged; a label
mismatch need not mean the partition is wrong. Recap correctness still requires
review.

The six holdout cases use unrelated project names and product/addon boundaries.
Keep them out of the production prompt. These are small regression sets, not a
general accuracy benchmark. Expected group identity does not score recap
truthfulness, title quality, cost, or latency under real workload.

## Recorded experiment

Gateway list prices at evaluation: GPT-4.1 mini $0.40/$1.60 per million
input/output tokens; GPT-4o mini $0.15/$0.60; GPT-4.1 nano $0.10/$0.40. Times
below are observed wall-clock times, including Pi startup, not latency
guarantees or billed-cost measurements.

| Design / model                                               | First pass                              | Final | Seconds |
| ------------------------------------------------------------ | --------------------------------------- | ----- | ------- |
| Thread reassignment pass / GPT-4.1 mini                      | 15/16                                   | 10/16 | 8.9     |
| Thread reassignment pass / GPT-4o mini                       | Contract failure: empty recap           | —     | 4.9     |
| Thread reassignment pass / GPT-4.1 nano                      | Contract failure: recaps >180 chars     | —     | 5.1     |
| Model-based name reconciliation / GPT-4.1 mini               | 15/16                                   | 15/16 | 8.7     |
| Model-based name reconciliation, reversed / GPT-4.1 mini     | 16/16                                   | 16/16 | 8.8     |
| Model-based name reconciliation, holdout / GPT-4.1 mini      | 6/6                                     | 5/6   | 6.0     |
| Typography-only normalization / GPT-4.1 mini                 | 16/16                                   | 16/16 | 6.1     |
| Typography-only normalization, holdout / GPT-4.1 mini        | Contract failure: missing/incorrect IDs | —     | 3.8     |
| Typography-only normalization, holdout repeat / GPT-4.1 mini | 5/6                                     | 5/6   | —       |

The holdout name-reconciliation error merged `ember-changeset` into `Ember`. The
last repeat's sole mismatch was `Ember Changeset addon` versus the predeclared
`ember-changeset`: recognizable, but not an accepted label; it is not silently
counted as correct. The earlier holdout contract failure is retained rather than
hidden by the repeat.

Decision: retain GPT-4.1 mini and remove the second model pass. Only normalize
case, spaces, underscores, and hyphens; never remove qualifiers or semantically
merge labels. This prevents a context-poor second pass from destroying correct
classifications and removes a paid call. It does not fix all first-pass errors,
output-contract failures, or semantic aliases across batches. Future work should
measure those directly rather than add an unconstrained reassignment pass.

## Follow-up reliability and granularity checks

Short batch-local IDs now replace real thread IDs in prompts; code validates
coverage and maps returned IDs back without relying on output order. This
addressed an observed live ID-contract failure. A subsequent 32-thread live run
completed, but still had semantic mistakes and over-specific labels.

With short IDs, the holdout scored 4/6: both Beacon threads were correctly kept
together as `Beacon incident management`, which is not a predeclared accepted
label. This is a naming mismatch rather than a product-identity confusion; the
strict score is retained.

One-thread-per-request was also tested, with four concurrent requests. It scored
16/16 on the main set in 10.7 seconds and 5/6 on holdout in 3.2 seconds. The
holdout mismatch split Beacon and Beacon Incident Management. In live history it
also invented BB expansions (Bit Bot, Bitbucket) and fragmented related work.
The product therefore retains batches of eight, not single-thread requests.

Gemini 2.5 Flash-Lite was attempted with thinking off, but Pi/Gateway rejected
the request because its default maxOutputTokens equaled the provider's exclusive
upper bound. It has no quality score; this was a transport/configuration
failure, not evidence about the model's classification ability. No credentials
or global Pi settings were changed to work around it.

The production improvement established here is removing damaging reassignment
and improving ID integrity—not solving all live semantic classification errors.

## Approved real-thread reference and initial-request experiment

A private frozen reference covers 32 real threads, with a user-approved
boundary: core BB features remain BB; independently developed plugins remain
separate; repository guidance belongs to its actual repository; current
substantive scope supersedes an old title. Seven boundary cases retain the
draft's recommended assignment and can be corrected by the user. Exact labels
remain a strict metric, not a claim that every alternative spelling is
semantically wrong.

Initial requests were found in BB events for all reference threads, including 11
with empty prompt history. Collection now reads the first three typed request
events to find the earliest text request, plus the last three prompts sorted
chronologically and the last assistant report. Sources are attributed,
deduplicated, bounded and redacted. The initial request is historical, not
authoritative over later explicit scope changes.

Same frozen data and GPT-4.1 mini, one run per variant (not a statistical
benchmark):

| Input / prompt                                 | Strict labels | Related pairs recovered / 39 | Unrelated pairs wrongly merged / 457 |
| ---------------------------------------------- | ------------- | ---------------------------- | ------------------------------------ |
| Recent prompts + report                        | 15/32         | 16                           | 31                                   |
| Add initial request, chronological attribution | 19/32         | 16                           | 11                                   |
| Revised current-scope/plugin boundary prompt   | 17/32         | 27                           | 25                                   |
| Same revised prompt, reversed order            | 17/32         | 11                           | 9                                    |

The context fix recovers otherwise missing identity. The boundary prompt fixes a
known conceptual error (standalone loader vs core SDK), but the mixed scores and
order sensitivity show unresolved classification quality. Synthetic cases still
score 16/16; a contradictory recap in that run also demonstrates why identity
scores cannot stand in for recap accuracy. Do not tune only to the synthetic
score.

A fresh live run using the new collector completed for 34 threads with no
collector warnings. It correctly recovered the interview collector's repository,
tomdaleOS instruction work, the standalone loader, and BB's browser-permission
work. It still fragmented BB Pi Provider and Workstreams labels and
over-weighted old topics in some long conversations. No claim of semantic
completion is made.

## Naming cleanup, checkout paths, and “needs you”

The frozen reference was re-run with each thread's checkout path (previously
null in the frozen cases; production always sends it). Four runs per variant,
two forward and two reversed, GPT-4.1 mini. Means are reported because single
runs vary by ±2 labels.

| Variant                                                         | Strict labels / 32 | Related pairs / 39 | Wrong merges / 457 |
| --------------------------------------------------------------- | ------------------ | ------------------ | ------------------ |
| One batch of 32 instead of four of 8 (single run)               | 10                 | 11                 | 5                  |
| Naming rules + descriptor cleanup, no paths (2 runs)            | 21                 | 27.5               | 33                 |
| + checkout paths, own-checkout plugins keep their name          | 19.75              | 21.25              | 23.25              |
| + named product beats repository; repository beats Unclassified | 19                 | 23.5               | 30.5               |
| + `needsYou` field (shipped)                                    | 20.5               | 23.75              | 24.25              |

Synthetic cases 16/16 and holdout 6/6 with the shipped prompt. A 32-thread run
costs about
$0.011 (≈23.5k tokens) and takes ≈4.5 s; a live 38-thread
run took 8.3 s, 6 calls (one retried contract failure), and $0.018.

One large batch was far worse: it produced long compound labels. Descriptor
cleanup is the largest single gain (e.g. “Sidebar Hierarchy Plugin”, “BB Recap
plugin”, `bb-plugin-fx-provider`). Wrong merges are dominated by single threads
landing in the large BB group, which counts many pairs each.

Remaining errors, by frequency: coordination and cross-repo threads falling back
to their checkout's project; loader SDK work filed under BB; Vercel Agent
threads named after a backend service or org path; interview transcript work
left Unclassified; and disputed reference boundaries (Agent configuration,
agentfile.link vs v0). “Needs you” was spot-checked on one run: plausible but
conservative (under-flags some blocked threads). Recap accuracy still needs
human review.
