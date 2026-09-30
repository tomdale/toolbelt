# Analysis evaluation

`run.ts` runs the production per-thread analysis prompt and parser
(`src/domain/analysis.ts`, SPEC §10) against fixtures, through the production AI
Gateway client (`src/server/inference/gateway.ts`, Pi's key), and scores the
results. It is opt-in and never part of `npm test`.

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
  healthy threads. Only high-confidence drift is surfaced to users. Also scores
  how often a new title is suggested for side quests and for healthy threads
  (many fixture titles are deliberately outdated, so a healthy retitle is not
  necessarily wrong; read `healthyRetitledIds`).
- **Untitled:** `cases` and `state` threads with no title, shown to the model as
  BB's placeholder (the opening words). Every one should get a title.

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
| Untitled threads titled                      | ≥ 25/27      |
| Median call latency                          | ≤ 4 s        |

## Current result (2026-09-29, prompt at the Phase 2 commit)

| Model                          | Public subjects | Private | State | Drift | False alarms | Median | Cost/call |
| ------------------------------ | --------------- | ------- | ----- | ----- | ------------ | ------ | --------- |
| `google/gemini-3.1-flash-lite` | 26/28           | 20/32   | 11/11 | 3/4   | 2/50         | 3.6 s  | ~$0.0015  |
| `openai/gpt-4.1-mini`          | 21/28           | 15/32   | 10/11 | 0/4   | 1/50         | 1.2 s  | ~$0.0004  |

Gemini 3.1 Flash-Lite passes and is the default. GPT-4.1 mini is faster and
cheaper but misses the private subject bar and drift detection.

With the `title` field (Gemini 3.1 Flash-Lite, public sets, two runs): subjects
26/28 and 24/28, state 11/11, drift 3/4 and 2/4 (the unchanged prompt scored
3/4, 3/4, and 2/4 over three runs), false alarms 1/19, untitled threads titled
27/27 and 26/27, side quests retitled 3/4, median 3.8 s and 3.7 s. Placing
`title` after `drift` in the output matters: listed before it, the model
retitled side quests instead of flagging them (drift 1/4).

## Routing (`route.ts`)

`node eval/route.ts [model ...]` runs the intake router prompt
(`src/domain/router.ts`, SPEC §6) on `route.json`: synthetic workstreams, active
threads, and prompts labeled with the expected outcome (continue a thread, new
thread in a workstream, new workstream). A private replay built from real first
messages, labeled with the workstream each thread lives in, runs with
`EVAL_ROUTE=<replay.json>` under the same private-output rule.

Scores: outcome, exact target, and workstream (the work landed with the right
workstream, whether by continuing or starting a thread).

Result (2026-09-29):

| Model                          | Synthetic target | Replay workstream | New workstreams | Median |
| ------------------------------ | ---------------- | ----------------- | --------------- | ------ |
| `google/gemini-3.1-flash-lite` | 9/10             | 15/19             | 0               | 2.7 s  |
| `openai/gpt-4.1-mini`          | 8/10             | 9/19              | 0               | 1.2 s  |

Most replay misses are prompts filed under tomdaleOS that the router sends to BB
& plugins; several of those filings are ones the bootstrap would also move.

Without reasoning (2026-09-30, the direct gateway client; the rows above ran
through `pi --print --thinking off`, which made Gemini reason):

| Model                          | Synthetic target | Replay workstream | New workstreams | Median |
| ------------------------------ | ---------------- | ----------------- | --------------- | ------ |
| `google/gemini-3.1-flash-lite` | 9/10             | 16/19, 17/19      | 0               | 0.9 s  |
| `google/gemini-2.5-flash-lite` | 10/10            | 11/19, 13/19      | 1-2             | 0.7 s  |
| `meta/llama-4-scout`           | 8/10             | 12/19, 12/19      | 0               | 0.6 s  |
| `openai/gpt-4.1-mini`          | 9/10             | 12/19, 12/19      | 0               | 1.1 s  |

Analysis without reasoning (Gemini 3.1 Flash-Lite, public sets, three runs):
subjects 23/28, 25/28, and 26/28; state 11/11; needs-decision recall 3/3; drift
3/4; false alarms 1/19; untitled threads titled 27/27; median 0.8-0.9 s. The
private reference set was not re-run.

Cheaper and faster candidates (2026-09-30, routing). `:disabled` means the
request sends `thinking: disabled`: DeepSeek, GLM, and Nemotron reason unless
told not to (Nemotron: ~12 s and 4K tokens per call), the opposite of Gemini,
which reasons only when told not to. Synthetic and replay columns are two runs
each; Gemini and GLM have two more replay runs.

| Model                                    | Synthetic target | Replay workstream | Unsure (replay) | Median     |
| ---------------------------------------- | ---------------- | ----------------- | --------------- | ---------- |
| `google/gemini-3.1-flash-lite`           | 9, 9             | 16, 16, 16, 17    | 0               | 0.85-0.95s |
| `zai/glm-5.3-flash:disabled`             | 10, 10           | 14, 16, 14, 13    | 0-1             | 0.65 s     |
| `google/gemini-3.5-flash-lite`           | 9, 8             | 15, 14            | 0               | 0.8 s      |
| `amazon/nova-2-lite`                     | 9, 9             | 12, 12            | 1-2             | 0.7 s      |
| `deepseek/deepseek-v4-flash:disabled`    | 10, 9            | 12, 10            | 1-2             | 0.6-0.9 s  |
| `spacexai/grok-4.1-fast-non-reasoning`   | 10, 10           | 11, 12            | 0               | 0.65 s     |
| `spacexai/grok-4.20-non-reasoning`       | 10, 10           | 11, 11 (3 new ws) | 0               | 1.3 s      |
| `alibaba/qwen3-next-80b-a3b-instruct`    | 5, 6             | 11, 11            | 1               | 0.9 s      |
| `meta/llama-4-maverick`                  | 8, 8             | 7, 8              | 0               | 0.55 s     |
| `amazon/nova-lite`                       | 10, 10           | 7, 7              | 6-7             | 0.7 s      |
| `nvidia/nemotron-3.5-lightning:disabled` | 5, 6             | 7, 7              | 5               | 0.45 s     |
| `amazon/nova-micro`                      | 9, 9             | 5, 4              | 7-8             | 0.5 s      |

GLM 5.3 Flash is the only close alternative: faster and about half the cost, and
better on analysis subjects (26/28, 27/28), but behind on routing and below the
analysis bar on drift (2/4, 1/4) and untitled titling (26/27, 21/27). Gemini 3.1
Flash-Lite stays the default. Qwen 3.7/3.8 (including Qwen3.8-27B on every
provider), Mistral, Gemma 4, and Mercury are blocked by this team's AI Gateway
provider settings and were not evaluated.
