# Bottom Line

A BB plugin that gives every turn a concrete handoff: questions or next steps, requested deliverables, or a finished-task summary with an **Archive** button.

The plugin injects three tools:

- `BottomLineAskQuestions`: one to four concrete questions or proposed next steps, with suggested answers and freeform input. BB's `AskUserQuestion` and native question cards also count.
- `BottomLineDeliver`: a summary and one or more requested artifacts, with clickable file paths or HTTPS links.
- `BottomLineFinish`: the overall task's completion summary and optional artifacts, shown above the composer with **Archive** and **Dismiss**. Archiving requires a user click and an idle thread with no queued messages.

Dismiss leaves the conversation available to resume. A fresh message clears the previous card. Question cancellation supplies no answer or approval.

## Enforcement

Bottom Line observes `thread.idle`, checks the completed turn's handoff, and sends an agent-only corrective continuation if one is missing. **SDK 0.6.5 has no completion veto hook: the original final response can appear before redirection.** This plugin does not prevent publication of the original response.

Corrections are deduplicated by completion sequence. The counter persists in plugin SQLite and resets on fresh input; the correction's own dispatch preserves it. Corrections carry an epoch checked by `message.dispatch`, so intervening input invalidates a stale correction. Hidden workers, side chats, failed/interrupted turns, busy threads, and threads with queued messages are excluded. Threads must have resolved Bottom Line's tool configuration to participate.

## Settings

Configure in Settings → Plugins → Bottom Line or `bb plugin config bottom-line`:

- `enabled`: defaults to `true`. Controls tool selection and corrections.
- `maxIntercepts`: integer from 0 to 10, default `3`. Maximum corrective continuations per handoff; `0` disables automatic corrections. When exhausted, a composer notice explains that the thread can be resumed manually.

Enforcement reads setting updates immediately. BB applies changed tool and instruction sets when constructing the next provider session.

## CLI completion

Existing sessions can record completion through their shell tool with `bb bottom-line finish --summary "Task complete."`. This shows the same Archive and Dismiss controls and satisfies the completed turn's handoff. The command defaults to the invoking thread; outside a thread, supply `--thread <thread-id>`. Use `--summary-stdin` for a summary from standard input. Summaries accept 1–4000 characters. Injected tools become available when BB constructs a provider session.

## Development

Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` in this directory. The plugin uses only public Plugin SDK APIs and has no external services or credentials.
