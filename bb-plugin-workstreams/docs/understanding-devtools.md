# Understanding developer tools

The Understanding workbench separates what the system currently believes from
the evidence it learned, the reconciliation that changed a belief, and the
context supplied to a particular decision. Open **Workstreams → Understanding**.

## Questions to investigate

| Question                                         | Where to start                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| What does the system believe about this product? | Accounts: search a name or capability, select an account, read its narrative and unresolved questions.            |
| Why does it believe that?                        | Follow account citations to source-linked observations, exact quotes, speaker, source date, and epistemic status. |
| What changed the interpretation?                 | Account revision history: compare before and after, inspect the synthesis call where retained.                    |
| Why wasn't relevant evidence retrieved?          | Retrieval lab: run a local query and inspect scores, matched terms, and inclusion/exclusion reasons.              |
| What did a particular model call actually see?   | Decisions or the model-call inspector: open its recorded retrieval snapshot and exact supplied context.           |
| Why isn't the system learning from a thread?     | Collection health: inspect cursor, backlog, dirty reconciliation state, and failure details.                      |

## Explore without changing memory

The retrieval lab uses the production retrieval algorithm against current
memory. Query and character-budget controls expose how candidate relevance and
budget affect the supplied context. It does not call a model, record a
production decision, or modify memory. Candidate diagnostics explain local
lexical matching rather than the model's internal reasoning. Results are
bounded; an omitted candidate may lie outside the search limit rather than lack
semantic relevance.

A production decision records its own retrieval snapshot before the model call.
That snapshot is not recomputed when accounts change. Use it to distinguish a
retrieval problem from a model interpretation problem. Explicit destination
choices bypass inferred routing and therefore need no retrieval snapshot. A paid
model-call replay uses the original prompt and stores a comparison trace; it
does not apply its answer to memory, placement, or account history.

## Follow provenance

Evidence retains its extraction trace ID when Debug mode recorded that call.
Account revisions retain the synthesis trace ID and before/after account
content. Model-call outcomes distinguish a validated response from changes
applied, a no-op, or a response discarded because the underlying evidence
changed.

History and retrieval snapshots are durable developer records independent of
Debug mode. Snapshot storage keeps the latest 1,000 decisions; page through
older retained decisions in the workbench or with `--before`. Account revisions
are retained until their sources are removed. Trace details still follow Debug
retention: an old provenance link can exist even when the model call has
expired, or be absent when the call was never recorded. The workbench does not
invent a replacement trace. Source links open the source thread; entry-segment
IDs identify the excerpt within it without claiming an unsupported
transcript-anchor link.

## CLI

```sh
bb workstreams understanding Recap --retrieve --budget 4000 --json
bb workstreams understanding --account <account-id> --json
bb workstreams understanding --evidence <observation-id> --json
bb workstreams understanding --decisions --trace <trace-id> --json
bb workstreams understanding --decisions --before <last-snapshot-id> --json
bb workstreams understanding --observe <thread-id> --json
```

All commands above except `--observe` are read-only. `--observe` performs
incremental collection and reconciliation, can make paid model calls, and
changes memory. Flags selecting different operations are mutually exclusive.

## Retention and privacy

Observations quote conversations and accounts summarize them. These are user
data, not public diagnostics. Redaction is best-effort, and a valid citation
establishes provenance rather than truth. Source deletion removes evidence and
invalidates citing accounts; dependent histories and retrieval snapshots are
removed or sanitized. Retained model traces linked to the removed evidence,
including replay descendants, are also deleted so developer tooling does not
become a second copy of deleted conversational facts. Clearing Debug traces does
not clear memory.

This preview does not automatically rebuild evidence after historical transcript
edits. Inspecting a current account is therefore different from verifying that
the underlying code or every source passage remains current. Autonomous code
investigation, user-question collection, embeddings, and semantic retrieval
evaluation are separate capabilities from these tools.
