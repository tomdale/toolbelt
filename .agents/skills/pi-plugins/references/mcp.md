# MCP and Pi

Pi 0.79.1 does not natively discover or configure MCP servers and has no MCP manifest/config surface. Do not copy Claude Code/Codex `.mcp.json`, `mcp_servers`, or MCP hook assumptions into a Pi package.

## Adapter strategies

1. **Wrap an MCP client in an extension.** Add a maintained MCP client as a runtime `dependency`, connect during `session_start` or on demand, register each useful operation with `pi.registerTool()`, translate TypeBox schemas and results, and close transports in `session_shutdown`. Pass `ctx.signal` into cancellable calls and expose errors as normal tool results.
2. **Wrap an MCP server/CLI as a normal custom tool.** Use `node:child_process` or HTTP from an extension and return Pi tool content/details. Keep credentials in environment/config, not prompts or source.
3. **Use a separate MCP bridge.** Run an external adapter that exposes the needed service through HTTP/CLI, then keep the Pi extension a thin client.

Representative shape:

```ts
export default function (pi: ExtensionAPI) {
  let client: Client | undefined;
  pi.on("session_start", async () => { client = await connect(); });
  pi.registerTool({
    name: "search_docs", label: "Search docs", description: "Search the adapter",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, { query }, signal) {
      const result = await client!.callTool({ name: "search", arguments: { query } }, { signal });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  });
  pi.on("session_shutdown", async () => { await client?.close(); client = undefined; });
}
```

The exact `Client` API depends on the selected MCP library; the Pi-facing API above is the stable extension boundary, not built-in MCP support. Validate/limit tool inputs, avoid exposing an entire unreviewed server automatically, and clearly label remote/network side effects. Packages can distribute this adapter using `pi.extensions`, but package installation does not make MCP native.
