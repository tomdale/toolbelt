# Incremental understanding (preview)

Workstreams retains grounded observations from conversations and reconciles them
into revisable, cross-thread accounts. The workstream map is one consumer of
these accounts: it is not the memory itself.

## Evidence and accounts

Extraction reads new conversational entries in chronological, bounded batches.
Observations describe meaningful product context, ownership, naming,
implementation boundaries, user intentions, and reported results in free-form
language. Each observation carries an exact excerpt and a source thread/entry
reference. Explicit user statements and assistant-reported results remain
distinguishable. Empty successful batches advance progress; failed extraction
leaves the batch available for retry.

Reconciliation combines relevant observations across threads into topical
accounts. Accounts cite stored evidence and retain unresolved questions. They
can describe unfamiliar situations without requiring a predefined catalog of
product transitions. A model-generated account is an interpretation of evidence,
not independent evidence and not verified code state.

Routing and per-thread analysis retrieve bounded, relevant accounts and
observations. They interpret product scope using that evidence while preserving
explicit destination choices and existing closed-set validation. This can affect
subject labels and drift suggestions; interpretation remains model-mediated, so
inspect consequential suggestions. Per-thread state and Needs you still come
from that thread's exchange. Accounts do not directly modify sections,
descriptions, aliases, or placements. Existing routing and evolution policies
continue to govern actions.

## Use

The preview defaults to manual operation. After building and loading this
version:

```sh
bb workstreams understanding --observe <thread-id> --json
bb workstreams understanding Recap --json
bb workstreams understanding Workstreams
```

`--observe` processes a bounded batch of a visible, unarchived, idle thread.
Repeat it to consume historical conversations. Inspect JSON for retained
observations, accounts, questions, and progress. Topic lookup is a local
retrieval operation, not an extra model call. Text output includes counts of
indexed, pending, and failing threads; JSON includes errors and backlog.
Manually collected evidence is available to routing and analysis even when
automatic collection is off.

Enable **Incremental understanding (preview)** in Workstreams settings to queue
evidence collection alongside each completed-turn analysis. Analysis reads the
latest available context without waiting for indexing. A rotating catch-up pass
also processes up to two idle threads per minute, so historical conversations
can accumulate without requiring more messages. Current threads are skipped;
failures back off for ten minutes. Collection and reconciliation share one
serial queue. Each pass can make up to three extraction calls and one
reconciliation call, additional to ordinary analysis. Extraction or
reconciliation failure is logged separately and does not prevent ordinary thread
analysis. Turning automatic collection off stops automatic model calls; it does
not erase retained evidence.

Use the existing Debug mode to inspect and replay extraction and reconciliation
calls. Debug traces have their own retention policy; grounded observations and
accounts are durable plugin data. Quotes and inputs are redacted before storage
or model use. Transcript excerpts remain an untrusted prompt-injection surface:
citations validate provenance, not truth or semantic correctness. Redaction is
best-effort: do not treat it as a guarantee that conversations containing
sensitive material can safely be indexed.

## Boundaries of this version

The system can preserve and reconcile evidence, and expose the questions it
cannot resolve. It does not autonomously inspect code, fetch missing transcript
passages on demand, or interrupt the user with questions. Retrieval uses bounded
local lexical relevance rather than embeddings. Repeated statements do not
become verified facts simply because several threads contain them. Source
deletion removes associated evidence and invalidates every account citing it.
Long conversational entries are split into source-linked segments. A missing
cursor or a timeline exceeding the bounded scan is reported as failed without
advancing progress. Historical text edits are not automatically reindexed;
source deletion is the supported removal boundary in this preview.

A useful evaluation is to express complementary facts in separate turns and
threads, then ask where a related task belongs. For example, one thread
establishes that Recap is separately developed; another establishes that its
implementation and interface are integrated into Workstreams. The account should
preserve the historical distinction, reflect the later evidence, and identify
any uncertainty about whether Recap remains independently developed. The routing
decision should reason from that evidence rather than treating two historical
names as proof of two current products.
