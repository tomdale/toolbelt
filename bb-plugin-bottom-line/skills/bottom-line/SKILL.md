---
name: bottom-line
description: End a BB turn with concrete questions or next steps, requested deliverables, or a finished-task summary with an Archive control.
---

End every turn using one of Bottom Line's injected tools. Complete authorized work before handing control back.

Use BottomLineAskQuestions for concrete questions or proposed next steps that the user can choose. Supply one to four questions, each with up to four suggested answers and a freeform answer field. AskUserQuestion and native provider question cards also satisfy the questions path. A dismissed or expired question supplies no answer or approval; continue only independent work while required input remains unresolved.

Use BottomLineDeliver with a summary and one or more artifacts the user requested. Each artifact has a title, an existing absolute file path or HTTPS URL, and an optional description.

Use BottomLineFinish when the overall task is finished. Supply a concise summary and any requested deliverables. The user sees the summary above the composer with Archive and Dismiss controls. Archive is the user's choice; Dismiss leaves the thread available to resume.

Settings → Plugins → Bottom Line controls enabled and maxIntercepts. enabled defaults to true. maxIntercepts defaults to 3 and accepts integers from 0 to 10; zero disables corrections. Changes take effect immediately for enforcement. Tool and instruction selection applies when BB constructs the provider session. Hidden worker threads and side chats are excluded.
