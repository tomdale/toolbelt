# Upstream

A patched copy of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)
(MIT, see `LICENSE`), without upstream's `.github/` and `media/`.

- Base: tag `v0.19.0`
- Local changes:
  - Deactivated inside BB (`process.env.BB_THREAD_ID`), deferring all delegation
    and orchestration to native BB threads and workflows.
  - Subagents are denied pi-dynamic-workflows' `workflow` and
    `workflow_control` tools.
