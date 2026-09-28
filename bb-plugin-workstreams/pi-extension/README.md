# BB Pi in-thread side-quest prompt

This is an opt-in Pi extension prototype for BB threads using the Pi provider.
Pi's `input` event runs before the request enters the conversation; BB currently
does not expose a plugin composer hook that can ask a blocking user confirmation
and transfer the same unsent message. The extension therefore owns the prompt,
confirmation, and BB fork.

## Install for a throwaway test

The prototype is a local Pi package already installed into this user's Pi
settings. It applies only to Pi provider sessions with a BB_THREAD_ID. Enable or
disable the resource in Pi with `pi config` (packages list); remove it with
`pi remove ../../Code/Repos/toolbelt/bb-workstreams/bb-plugin-workstreams/pi-extension`.
This does not affect Claude/Codex threads or other Pi sessions that do not
expose BB_THREAD_ID. Do not use a global extension file for this behavior.

If Pi rejects the directory package form, install the entry point as a local
extension in Pi config or add its path explicitly with
`pi --extension /absolute/path/to/bb-plugin-workstreams/pi-extension/index.ts`.
Do not enable this globally until the throwaway test passes and the prompt
quality is acceptable.

The target BB Pi thread must have `BB_THREAD_ID` in its Pi environment, the `bb`
CLI must be on the same machine's PATH, and Pi must have Vercel AI Gateway
configured with `openai/gpt-4.1-mini`. The model request is one bounded,
tool-free, non-reasoning classification per eligible interactive/RPC user send.
If inference fails or says no, the extension passes the original request through
untouched.

## Behavior

- Compares a new interactive/RPC request to the active Pi session's user-message
  history. BB's Pi provider sends prompts through RPC with `followUp`, so those
  are included; steer and extension-generated input are skipped. Empty/oversized
  prompts, sessions with no prior topic, and unavailable Gateway auth are also
  skipped.
- Uses an 8-second request timeout, zero model retries, and bounded output. The
  cheap classifier should err toward no split.
- On a positive result, asks for confirmation before taking action. Declining
  keeps the request in the current thread.
- On acceptance, invokes `bb thread fork` at the current tip with the unsent
  request as the fork's first prompt. Since the hook runs before BB records this
  request, the fork ends at the prior turn by construction. The original remains
  the mainline; the fork is the side quest. BB forks keep the environment by
  default.
- If the CLI is unavailable or the fork fails, it warns and passes the request
  through the original thread. It never silently drops a request.

This is tested manually only on throwaway threads. A Pi extension is the working
mechanism because BB `message.dispatch` hooks can proceed, wait, or reject a
message, but cannot replace the destination or fork/re-submit it; rejecting
would also lose the original request unless the user manually re-enters it. Pi
exposes a pre-agent `input` transform/handled boundary and RPC-capable
confirmation, and BB exports `BB_THREAD_ID` to its Pi provider.

## Manual throwaway test

1. Create a throwaway BB Pi thread and send a starter request, e.g. "Add caching
   to the tiny sample app in this throwaway checkout."
2. Ensure the extension is enabled in that Pi session and Gateway auth resolves.
3. Send a follow-up that stays on topic; it should pass straight through without
   a confirmation.
4. Send clearly independent work, e.g. "Separately, make a small shell prompt
   timing tool in this checkout." Review the classifier's title/reason.
5. Decline once; verify the request continues in the original thread.
6. Repeat and accept; verify BB creates a fork titled for the new task and that
   its first request is the new prompt, while the original thread remains
   unchanged.
7. Test a failed/no-auth model call and confirm the request continues unchanged.
   Do not test this by forking or archiving a real user thread.

Unit contract coverage lives in `policy.test.ts`. The classifier prompt/parser
uses no locally stored transcript state and makes no changes to the thread
unless accepted.
