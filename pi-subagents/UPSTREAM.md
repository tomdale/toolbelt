# Upstream

This directory is a patched copy of `@tintinweb/pi-subagents`.

- Source: https://github.com/tintinweb/pi-subagents
- Base commit: `c83dd82cf4a15077f90d03d6381d824f42da0099` ("Fix/179 startup errors
  (#219)", package version 0.15.0)
- License: MIT, copyright tintinweb (see `LICENSE`)
- Omitted from the copy: `.github/` and `media/` (CI config and the README
  demo assets, which the README loads from the upstream repository)

## Local changes

Two commits by Tom Dale on top of the base, originally made in a fork at
https://github.com/tomdale/pi-subagents:

1. `7eb4256` fix: make non-isolated agent mode explicit. The `Agent` tool and
   the nested-agent tool accept `isolation: "none"` alongside `"worktree"`;
   `"none"` runs in the current working directory. Strict tool-calling models
   can then name the default instead of omitting the field. Upstream later
   added `"off"` for the same purpose (0.17.0).
2. `bf23579` fix: deny foreign orchestration tools to subagents. Subagents
   never inherit `workflow` or `workflow_control` from pi-dynamic-workflows,
   at either the registry gate or the active-tool renarrow, so one `Agent` call
   cannot fan out into a workflow run. The `Agent` tool description also tells
   the caller to describe the task rather than the delegation plan. Upstream
   0.19.0 has no equivalent deny rule.

To move to a newer upstream release, rebase these two changes onto it (the
second one is the one that matters), then rerun `npm run lint`,
`npm run typecheck`, and `npm test`.
