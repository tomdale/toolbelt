# Subagents in Pi

Pi 0.79.1 has no native subagent registry or built-in subagent tool. The installed example is an extension/package pattern: discover agent markdown definitions, then spawn isolated `pi` subprocesses with `node:child_process`.

## Agent definitions

The example uses `~/.pi/agent/agents/*.md` for user agents and `.pi/agents/*.md` for project agents. A definition has frontmatter and a system prompt:

```markdown
---
name: scout
description: Fast repository reconnaissance
tools: read,grep,find,ls,bash
model: claude-haiku-4-5
---

Inspect the repository and return compressed, actionable findings.
```

The example parses `name`, `description`, optional comma-separated `tools`, and `model`; project agents override same-name user agents when both scopes are enabled. By default it only discovers user agents. `agentScope: "project" | "both"` enables project definitions and interactive confirmation is recommended because prompts are repo-controlled.

## Extension pattern

The example at `examples/extensions/subagent/` registers a `subagent` custom tool. Its modes are single (`agent` + `task`), parallel (`tasks`), and chain (`chain`, with `{previous}` substituted). It invokes:

```ts
const args = ["--mode", "json", "-p", "--no-session"];
if (agent.model) args.push("--model", agent.model);
if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
args.push(`Task: ${task}`);
spawn("pi", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
```

A robust implementation parses JSON-lines `message_end`/tool-result events, forwards stderr, propagates an `AbortSignal` (SIGTERM then SIGKILL fallback), cleans temporary prompt files, caps parallel work, and reports exit/stop errors. The example limits parallel tasks to 8 and concurrency to 4. It can instead invoke the current script via `process.execPath` when appropriate.

## Security and context

Subprocesses are isolated in context/session, not sandboxed: they retain OS permissions. Use `--no-session` for ephemeral delegated work and explicit `--tools`/`--model`/cwd. Do not enable project agents automatically in untrusted repositories; confirm or require project trust. This entire workflow is extension behavior, not native Pi behavior, and can differ from other subagent packages.

Source examples: `examples/extensions/subagent/README.md`, `index.ts`, `agents.ts`, and `agents/*.md`.
