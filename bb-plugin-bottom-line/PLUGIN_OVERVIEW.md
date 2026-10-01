## A concrete handoff at every pause

Bottom Line gives agents three ways to hand control back: concrete questions or proposed next steps, requested artifacts, or an overall completion summary. Questions offer suggested answers and freeform input; artifact links open the files and pages the agent produced.

## Finish with a choice

`BottomLineFinish` places the completion summary above the composer with **Archive** and **Dismiss**. You choose whether to archive. Dismiss keeps the thread available to resume, and a fresh message clears the previous card.

`BottomLineAskQuestions` collects answers when input remains useful. `BottomLineDeliver` hands you one or more artifacts you requested. BB's Ask User Question and native question cards also satisfy the questions path.

## Bounded corrections

A turn without a handoff receives an automatic corrective continuation. The maximum defaults to three and is configurable from zero to ten. The count survives plugin reloads; a fresh message resets it. Hidden workers, side chats, failed and interrupted turns are excluded.

BB's SDK exposes completion as an observation rather than a veto, so the original response can appear before the corrective continuation. Tools become available when BB constructs the agent session. No external account, service, or credentials are required.
