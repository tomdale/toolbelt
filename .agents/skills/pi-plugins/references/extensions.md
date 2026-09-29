# Pi extensions

Pi 0.79.1 extensions are TypeScript/JavaScript modules loaded by `jiti`. There is no plugin manifest: export a default factory receiving `ExtensionAPI`.

## Locations and testing

- Global auto-discovery: `~/.pi/agent/extensions/*.ts` or `~/.pi/agent/extensions/*/index.ts`.
- Project auto-discovery: `.pi/extensions/*.ts` or `.pi/extensions/*/index.ts` (only after project trust).
- Settings can add `extensions` files/directories; packages can declare them under `pi.extensions`.
- Quick test: `pi -e ./extension.ts` (or `pi --extension ...`). Put an auto-discovered extension in place and use `/reload` to reload it.

Extensions execute with the Pi process's full permissions. Review source before loading third-party code.

## Representative shape

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => ctx.ui.notify("Loaded", "info"));
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => ctx.ui.notify(`Hello ${args || "world"}`, "info"),
  });
  pi.registerTool({
    name: "greet", label: "Greet", description: "Greet a person",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, input) {
      return { content: [{ type: "text", text: `Hello, ${input.name}!` }], details: {} };
    },
  });
}
```

Useful API includes `pi.on`, `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerProvider`, `appendEntry`, and session/model controls. `ctx` provides `ui`, `cwd`, `mode`, `hasUI`, `signal`, `sessionManager`, `modelRegistry`, and `isProjectTrusted()`. Guard dialogs/TUI-only operations with `ctx.hasUI`/`ctx.mode === "tui"`; use `ctx.signal` for nested abortable work.

Use `@earendil-works/pi-coding-agent` types, `typebox` schemas, `@earendil-works/pi-ai` utilities, and `@earendil-works/pi-tui` components. Runtime dependencies belong in `dependencies`; core Pi packages should generally be `peerDependencies` (see packages reference).

## Lifecycle overview

Startup: `project_trust` (global/CLI extensions), `session_start`, then `resources_discover`. Prompt processing: `input`, expansion, `before_agent_start`, `agent_start`, messages/turns/provider hooks/tool hooks, `agent_end`, then `agent_settled`. Session replacement emits `session_before_switch`/`session_before_fork`, `session_shutdown`, and a new `session_start`/`resources_discover`.

Other events include `context`, `before_provider_headers`, `before_provider_request`, `after_provider_response`, `session_before_compact`, `session_compact`, `session_before_tree`, `session_tree`, `model_select`, and `thinking_level_select`. See hooks.md for interception rules.

## Resource contribution

```ts
pi.on("resources_discover", async () => ({
  skillPaths: ["./skills"], promptPaths: ["./prompts"], themePaths: ["./themes"],
}));
```

An async factory is awaited before `session_start`, resource discovery, and provider registrations are flushed. Do not start watchers/processes/sockets in the factory: start them from `session_start` or on demand and close them in an idempotent `session_shutdown` handler.

## UI and rendering

`ctx.ui.select/confirm/input/editor` prompt users; `notify`, `setStatus`, `setWidget`, `setTitle`, and `setEditorText` integrate with the UI/RPC. `ctx.ui.custom()` and custom component factories are TUI-only. Tools may implement `renderCall`, `renderResult`, and `onUpdate` for richer output. Keep non-interactive modes functional.
