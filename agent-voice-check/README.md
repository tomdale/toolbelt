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
The gate exists because a regex cannot tell "the chip carries a label" from
"the finding carries its certainty in an icon", and the model costs about
$0.00004 per sentence.

Measured on this machine: 15/15 on `fixtures.jsonl` at threshold 0.45
(flagged sentences score 0.61–1.00, clean ones 0.01–0.24), 339 ms and $0.0010
for the fixture run, 232 ms and $0.0004 for a ten-sentence document.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--json` | off | Findings as JSON, with line, sentence, problem, confidence, matched phrase, fix, cost and duration |
| `--threshold` | 0.45 | Probability of "problem" a sentence needs to be reported |
| `--top` | 10 | Findings printed; `--all` lifts the cap |
| `--max-candidates` | 24 | Sentences sent to the model in one call; the rest fall back to the phrase pass |
| `--no-model` | off | Phrase pass only, free and instant, noisier |
| `--quiet` | off | No output, exit code only |
| `--selftest` | off | Run the fixtures through the gate and report agreement |
| `--model` | `openai/gpt-6-luna-decisions` | Any AI Gateway decision model |

Needs `AI_GATEWAY_API_KEY`. Without it the phrase pass still runs and says so
on stderr.

## The five problems

Taken from the `agent-voice` skill: `subject` (the subject is something other
than the work), `writer` (the sentence is about the writer's confidence or
candor), `claim` (it corrects an objection nobody raised), `reader` (it
asserts importance or tours the document), `shape` (padding whose rhythm
carries it).

## Known limits

Sentences quoting a tic without a `Wrong:` prefix are reported, so a document
that lists the devices trips the checker. Prefilter patterns decide which
sentences the model ever sees, so a device with no pattern (a turned-down
closer, a paragraph of hedge sentences) is reported only when its sentence
happens to trip another pattern. Long documents are capped at
`--max-candidates` model questions; raise it for a full pass.
