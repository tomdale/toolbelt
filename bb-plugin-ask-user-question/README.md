# Ask User Question (Toolbelt)

A standalone fork of BB's built-in Ask User Question plugin. Required user input is collected through question cards with meaningful suggested answers and an always-available freeform answer. Agents receive affirmative guidance to call `AskUserQuestion` when input is required to proceed, including providers that supply their own native question tool.

The plugin-owned tool accepts 1–4 questions, each with 0–4 suggestions. An empty `options` array opens a freeform-only question; a single meaningful suggestion is also valid. Recommendations appear first with `(Recommended)` in the label. Single-select suggestions may include concrete artifact previews.

Cards show **Awaiting your answer**. Submission failures keep the entered answer and show a retryable error. Dismissal, expiry, and display errors leave the required decision unresolved; agents may continue only independent work. Forms expire after one hour, the maximum allowed by BB's interaction API. BB delivers successful answers to the waiting agent and resumes it.

## Development

```sh
npm install
npm test
npm run typecheck
bb plugin build
```

The package ID is `toolbelt-ask-user-question`: BB reserves `ask-user-question` for its built-in source. Both plugins register the tool name `AskUserQuestion`, so enable only one:

```sh
bb plugin disable ask-user-question
bb plugin install /Users/tomdale/Code/Repos/toolbelt/main/bb-plugin-ask-user-question --yes
```

Tool sets and instructions apply when a provider session is next constructed. Existing sessions retain their original configuration; use a fresh thread for verification. Providers advertising native user questions keep their native tool and schema; the fork contributes behavioral guidance without a duplicate tool.

To restore the built-in implementation:

```sh
bb plugin disable toolbelt-ask-user-question
bb plugin enable ask-user-question
```

Recap and Workstreams independently suppress their composer recap banners while the current thread has a pending interaction. They retain stored recap and dismissal state. The question form owns the next action until it is resolved.

## Provenance

Forked from `plugins/ask-user-question` in the BB checkout at commit `6985929d87beec798022b18a41179e36cb8ac86c`. UI components are vendored from that checkout's plugin registry, so this package uses only public SDK interfaces and package-local imports. The upstream MIT license is included in `LICENSE`.
