# Understanding

The learner reads conversations and writes two things: a notebook for each thread and a shared brief about the user's work. Both are ordinary prose. The learner chooses what to remember, how to organize it, and when earlier assumptions need revision.

## Learning

After a turn, the learner receives the new conversation and its existing notes. It can search other threads, read conversations and notebooks, and follow connections before writing. Source pointers are useful references, not an exact-quote acceptance protocol. Notes are interpretations, not verified code state.

**Learn from conversations** in Workstreams settings enables automatic learning. Historical conversations are processed in chronological, bounded batches. Learning runs separately from ordinary triage. A successful run commits notes and advances progress together; an interrupted or failed run leaves the previous notes and cursor intact. Calls are bounded and cancellable.

Routing and analysis receive the shared brief as context. Explicit destination choices remain authoritative. The learner cannot move threads, edit code, or change sections. Its tools let it read conversations and write memory—not perform actions described inside a conversation.

## Explore

Open **Workstreams → Understanding** to read the shared brief, browse notebooks and their earlier versions, or inspect learning runs. A run shows the learner's ordinary narration, tools used, results, cost, and errors.

Ask a question such as “Why do you think Recap is separate?” The learner can investigate by searching and reading. Asking makes paid model calls but does not change notes. **Learn from thread** is a separate action that updates memory.

```sh
bb workstreams understanding --json
bb workstreams understanding Recap
bb workstreams understanding --learn <thread-id>
bb workstreams understanding --ask "How does Recap relate to Workstreams?"
```

## Boundaries

Notes and run logs contain private conversational context. Redaction is best-effort. Source deletion invalidates dependent notes, versions, and run logs; the shared brief is rebuilt rather than preserving facts from a deleted source. Learning runs retain a bounded history; notebook versions retain their recent edits.

The notebook format is deliberately open. There is no extracted-fact schema, hand-built relevance scoring, or predefined vocabulary of product transitions. Whether the learner produces useful understanding is evaluated through its notes and answers, not by counting accepted observations.
