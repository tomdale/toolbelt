# Subagents

Use subagents for independent, bounded work that benefits from parallelism or would otherwise fill the main thread with noisy exploration, test output, logs, or summaries. Prefer one main agent for requirements and integration; use workers for isolated research, review, test, or implementation tasks.

Do not parallelize overlapping writes without explicit coordination. Parallel write-heavy work increases merge conflicts and coordination cost.

## Delegation prompt

Ask directly for delegation unless applicable `AGENTS.md` or skill instructions already require it. State the independent task boundaries, whether to wait for all agents, the result format and evidence expected, and whether workers may edit (including ownership boundaries).

```text
Spawn one subagent for each review area: security, test gaps, and maintainability.
Do not edit files. Wait for all results, then summarize findings by area with
file references and severity.
```

Subagents return summaries to the main agent, preserving the main thread for decisions and final synthesis.

## Runtime model

Subagents inherit the parent task's sandbox policy, tool access, and live permission or approval overrides. A custom agent may set defaults, but the parent turn's live runtime choices take precedence. In non-interactive flows, operations needing fresh approval fail and surface back to the parent.

Use `/agent` in an interactive CLI session to inspect or switch agent threads. Ask Codex to steer, stop, or close agents as needed.

Each subagent consumes its own model and tool work; use them only when parallel work materially improves speed or quality.

## Custom agents

Codex includes `default`, `worker`, and `explorer`. Define a personal agent in `~/.codex/agents/<name>.toml` or a project agent in `.codex/agents/<name>.toml`.

```toml
name = "reviewer"
description = "Review code for correctness, security, and missing tests."
developer_instructions = """
Review code like an owner.
Report evidence and do not modify files.
"""
```

Custom agent files are configuration layers for spawned sessions. They can set normal Codex configuration such as `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, and `skills.config`. Unset options inherit from the parent.

Use narrow roles with clear instructions and a limited tool surface. A custom name overrides a built-in agent with the same name.

## Limits

Global limits belong in `config.toml`:

```toml
[agents]
max_threads = 6
max_depth = 1
```

- `max_threads` limits concurrently open agent threads; default `6`.
- `max_depth` limits nested delegation; default `1`, allowing the root to spawn children but preventing child fan-out.
- Keep `max_depth = 1` unless recursive delegation is specifically needed.
- `job_max_runtime_seconds` sets the default worker timeout for `spawn_agents_on_csv`.
- `interrupt_message` controls whether interrupted agent turns receive a model-visible interruption message.

## Source

- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Subagents: custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents)
