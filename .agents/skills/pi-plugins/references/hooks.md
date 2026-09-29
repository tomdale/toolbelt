# Pi lifecycle hooks

Pi has no separate hooks manifest. A hook is an extension listener registered with `pi.on(event, handler)`. Handlers run in extension load order; return values are event-specific and async handlers are awaited where applicable.

## Blocking and rewriting

```ts
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && event.input.command.includes("rm -rf")) {
    const ok = ctx.hasUI && await ctx.ui.confirm("Dangerous command", "Allow?");
    if (!ok) return { block: true, reason: "Blocked by user" };
  }
});

pi.on("tool_result", async (event) => ({
  content: event.content, details: event.details, isError: event.isError,
}));
```

- `tool_call` is blocking and can mutate `event.input` in place; mutations affect execution, chain in load order, and are not revalidated.
- `tool_result` can patch `content`, `details`, and/or `isError`; patches chain before execution-end/final result messages.
- `input` returns `{ action: "continue" }`, `{ action: "transform", text, images? }`, or `{ action: "handled" }`. It sees raw input before skill/template expansion; extension commands are checked first. The first `handled` wins; transforms chain.
- `context` returns replacement messages (the event is a safe deep copy).
- `message_end` may return a replacement message, preserving its role.
- `before_agent_start` can return a persistent `message` and/or replacement `systemPrompt` (later handlers see the chained prompt).
- `before_provider_headers` mutates headers; string adds/overrides and `null` deletes. `before_provider_request` returns a replacement payload; `after_provider_response` observes status/headers before stream consumption.
- `session_before_switch`, `session_before_fork`, `session_before_compact`, and `session_before_tree` can return `{ cancel: true }`; compaction/tree can instead provide custom summaries.
- `project_trust` must return `{ trusted: "yes" | "no" | "undecided" }`; first yes/no wins, and `remember: true` persists it.

## Event selection

- Startup/resources: `project_trust`, `session_start`, `resources_discover`.
- Sessions: `session_info_changed`, `session_before_switch`, `session_before_fork`, `session_shutdown`, `session_compact`, `session_tree`.
- Agent: `before_agent_start`, `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_start/update/end`, `context`.
- Provider: `before_provider_headers`, `before_provider_request`, `after_provider_response`.
- Tools/bash/input: `tool_execution_start/update/end`, `tool_call`, `tool_result`, `user_bash`, `input`.
- Model: `model_select`, `thinking_level_select` (notification-only; return values ignored).

`agent_end` can be followed by retry, compaction, or follow-up; use `agent_settled` when Pi will not continue automatically. In parallel tool mode, preflight/tool-call hooks run source-order, updates and results can interleave, and final tool-result messages retain assistant source order.

## Safe design

Check `ctx.hasUI` before prompts and `ctx.mode` before TUI-only APIs. Use `ctx.signal` for fetch/model/process work. Start long-lived resources from `session_start` or on demand, not the factory; close them idempotently in `session_shutdown`. Keep hooks fast, narrowly scoped, and fail safely: do not accidentally block all tools or leak secrets into logs/context. Project-local hooks/extensions are trust-gated and run with full process permissions.
