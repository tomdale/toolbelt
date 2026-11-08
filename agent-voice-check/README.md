# voicecheck

Catches the turns of phrase the `agent-voice` skill forbids, in one command,
for about a fortieth of a cent.

```sh
voicecheck draft.md          # a file
git log -1 --format=%B | voicecheck   # a commit message
cat reply.md | voicecheck --json      # for a script
voicecheck --selftest        # prove the gate still agrees with the fixtures
```

Exit codes: `0` clean, `1` findings, `2` the check could not run. `--quiet`
prints nothing and returns the code, which is what a pre-commit hook wants.

## How it decides

A deterministic pass splits the text into sentences and keeps the ones
carrying a known phrase (`rather than`, `gets no X at all`, `carries the`,
`deliberately`, `evidence`, `honest`, `this page`, and the rest). That pass is
free and names which phrase fired.

One AI Gateway decision call then asks `openai/gpt-6-luna-decisions` two
closed-set questions per candidate: whether the sentence uses one of the seven
devices at all, and which of the five voice problems it has. A sentence is
reported when the gate puts at least `--threshold` probability on "problem".
The gate exists because a regex cannot tell a component's label from a finding's
certainty icon, and the model costs about $0.00004 per sentence.

Measured on this machine on 518 sentences from recent BB pi sessions, read by
hand. Four strata, because the sampling decides the answer:

| stratum | sentences | violations | reach the gate | precision | recall |
| --- | --- | --- | --- | --- | --- |
| enriched (phrase candidates) | 70 | 30 (43%) | 99% | 0.46 | 1.00 |
| natural (random, mixed dates) | 148 | 2 (1.4%) | 8% | 0.22 | 1.00 |
| pre-skill (random, before this standard) | 150 | 3 (2.0%) | 11% | 0.15 | 0.67 |
| post-skill (random, the week after) | 150 | 4 (2.7%) | 19% | 0.12 | 0.75 |

The two random strata decide how much to trust everything else. Ordinary agent
replies run at 2-3% violations with or without the standard, and at that
prevalence the tool flags five to eight sentences for every real one. It is a
prompt to look, not a verdict, and on a long document the review it asks for is
real work.

The tics concentrate in one register: explaining a design, justifying a choice,
reporting a review. Status reports and enumerations, which are most of what
agents write, are nearly free of them. A document in that explanatory register
is where the enriched row applies and where the tool earns its keep.

The post-skill rate is not lower than the pre-skill rate. Two samples of 150
sentences cannot separate 2.0% from 2.7%, and that week's prose included this
project's own vocabulary, so the standard and the checker have not measurably
changed ordinary replies.

Ranking by gate score times phrase reliability is what makes the short list usable:

| shortlist | violations found | precision |
| --- | --- | --- |
| top 5 | 5 of 32 | 1.00 |
| top 8 | 7 of 32 | 0.88 |
| top 16 | 14 of 32 | 0.88 |

Read the list from the top and stop when the lines stop being real.

The natural sample came from sessions recorded while this standard was being
written and applied, so it very likely understates the violation rate in prose
written without it.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--json` | off | Findings as JSON, with line, sentence, problem, confidence, matched phrase, fix, cost and duration |
| `--threshold` | 0.5 | Probability of "problem" a sentence needs to be reported |
| `--top` | 10 | Findings printed; `--all` lifts the cap |
| `--max-candidates` | 24 | Sentences sent to the model in one call; the rest fall back to the phrase pass |
| `--no-model` | off | Phrase pass only, free and instant, noisier |
| `--quiet` | off | No output, exit code only |
| `--selftest` | off | Run the curated fixtures through the gate and report agreement |
| `--model` | `openai/gpt-6-luna-decisions` | Any AI Gateway decision model |

Needs `AI_GATEWAY_API_KEY`. Without it the phrase pass still runs and says so
on stderr.

## The five problems

Taken from the `agent-voice` skill: `subject` (the subject is something other
than the work), `writer` (the sentence is about the writer's confidence or
candor), `claim` (it corrects an objection nobody raised), `reader` (it
asserts importance or tours the document), `shape` (padding whose rhythm
carries it).

## What was tried and did not help

Each was measured on the cross-validated corpus, and each is a technique the
literature recommends for small models:

| Technique | Result |
| --- | --- |
| kNN few-shot: retrieve the nearest labeled violations and clean sentences per candidate | a wash once the query sentence was excluded from the retrieval pool; an earlier perfect score was leakage |
| Escalate the 0.30-0.70 band to a language model as adjudicator | a wash under 3-fold cross-validation, and 2-3x the cost |
| One binary question per device instead of one gate question | clearly worse: recall@8 fell from 0.40 to 0.33, because each narrow question lost the context the gate question carries |
| Self-consistency by resampling | the decision model is deterministic, so repeats return the same probabilities |

What did help was writing the clean cases into the criteria sheet, a gain the
tool no longer claims because those allowances are gone and ranking by measured phrase reliability, since
the patterns differ wildly: every abstract-verb and candor word audited was a
real violation, while `instead of` was right 22% of the time.

## The eval

`evals/corpus.jsonl` holds 45 sentences taken from recent BB pi sessions, read
against the `agent-voice` skill and labeled. `evals/run.py` sweeps the
threshold and reports precision, recall, F1 and every mistake, which is how 0.50
was chosen. The corpus is where the tool's real weakness shows: the phrase pass
reaches every violation it is asked about, and the gate is what costs precision,
mostly on legitimate contrasts ("wrapped rather than rethrown bare") that look
like the manufactured ones.

Add a sentence to the corpus whenever the tool is wrong in the wild. A mistake
that stays in the corpus keeps the threshold grounded in real prose.

## No exclusions

The checker reports every device it can find. A quoted label, a component name
from the document's schema, a blockquote, and a line the document marks as a bad
example all still reach the gate, and the reader of the report decides which
lines were justified uses.

That choice costs precision and buys honesty. Measured on the 518-sentence
corpus, excluding quoted spans and declared identifiers read as precision 0.42
with no measurable recall gain; without any exclusion it is precision 0.33,
recall 0.95. The excluded cases were worth two to three findings on the
reply-block design document and every one of them was a judgement its author was
better placed to make than the checker.

It also removes the escape hatch. With quoted strings stripped, `the shape is a
rail "rather than" a bullet list` came back clean, and so did `It is
"deliberately" quieter` and `Three "honest" caveats`. A required check whose
subject can silence it by punctuation is worth less than a noisy one.

## Known limits

A document that lists the devices trips the checker on its own examples, and a
document that quotes one reports it. Prefilter patterns decide which sentences
the model ever sees, so a device with no pattern (a turned-down closer, a
paragraph of hedge sentences) is reported only when its sentence happens to trip
another pattern. Long documents are capped at
`--max-candidates` model questions; raise it for a full pass.
