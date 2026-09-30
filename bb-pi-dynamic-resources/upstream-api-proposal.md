# BB Pi dynamic resource discovery: upstream proposal

## Decision

Do not reproduce Pi's package manager or extension loader in BB's Pi provider.
Pi 0.85.1 already exposes the final effective skill catalog over its public RPC
`get_commands` request, including package resources and paths added by
`resources_discover`. The BB provider-native-root contract can represent every
result as an original-path `skill-file` root.

One Pi provenance field is insufficient for a correct implementation:
resources returned by `resources_discover` are currently assigned
`sourceInfo.scope: "temporary"` regardless of whether the contributing
extension is user- or project-scoped. BB requires every resolved native root to
be classified as `origin: "user" | "project"`. Guessing from path location is
incorrect because either kind of extension can return any absolute path.

## Smallest provider-side design after the Pi fix

In `provider-pi`'s existing `resolveNativeRoots({ cwd })` host handler:

1. Start the configured Pi executable in RPC mode at `cwd` (or a safe user-only
   cwd for a null workspace), with `--no-session` and no extra resource paths.
   Use the provider's existing executable override and child-process environment
   sanitization. The helper must answer/cancel `extension_ui_request` dialogs
   and be terminated deterministically after the response or timeout.
2. Send `get_commands` only after RPC startup has completed. Pi has already
   loaded settings, reconciled packages, loaded extensions, fired
   `session_start`, fired `resources_discover`, and rebuilt its resource catalog
   before it accepts this request.
3. Keep entries with `source === "skill"` and a non-empty absolute
   `sourceInfo.path`.
4. Convert each entry to:

   ```ts
   {
     path: command.sourceInfo.path,
     origin: command.sourceInfo.scope, // user | project after Pi fix
     shape: "skill-file",
     fallbackName: command.name.slice("skill:".length),
   }
   ```

5. Drop unresolved `temporary` entries with a bounded diagnostic rather than
   misclassifying them. Deduplicate by canonical path while retaining the first
   result, then call `experimental_filterResolvedNativeRoots`.
6. Keep BB's existing declared Pi roots. They are cheap cold fallbacks and cover
   standard roots if the helper fails. BB's daemon deduplicates discovered skill
   files by real path, so returning Pi's final catalog beside those roots does
   not stage or rewrite anything.

The existing BB contracts need no extension:

- `experimental_nativeRootsHostContract` is called per host and workspace and
  accepts up to 256 resolved skills.
- `shape: "skill-file"` preserves the exact Pi-owned `SKILL.md` path and supports
  a fallback name without changing frontmatter.
- The same resolved root set feeds both `host.list_skills` (Skills page) and
  `host.list_commands` (composer autocomplete). A selected Pi skill already
  becomes `/skill:<name>` in the Pi bridge.

If Pi can load more than BB's 256-root limit, the provider should preserve Pi's
order and warn when the public BB filter truncates the result.

## Required Pi API correction

Make the provenance of resources returned by `resources_discover` reflect the
contributing extension's load scope.

Today `AgentSession.buildExtensionResourcePaths()` creates metadata equivalent
to:

```ts
{
  source: `extension:${basename(extensionPath)}`,
  scope: "temporary",
  origin: "top-level",
  baseDir: dirname(extensionPath),
}
```

Instead, each `emitResourcesDiscover()` result should carry the contributing
extension's `SourceInfo`, and `buildExtensionResourcePaths()` should preserve at
least:

- `scope`: `user`, `project`, or `temporary` from the extension;
- `origin`: `package` or `top-level` from the extension;
- `baseDir`: the extension/package base directory;
- a stable source label (the package source may remain the source for package
  extensions; an additional `contributedBy` field may identify the extension).

No new RPC method is required if Pi guarantees that `get_commands` returns this
corrected `sourceInfo` and the original resource file path. A dedicated
`get_resources` method would only duplicate the skill subset needed here.

Suggested Pi regression matrix:

1. user Pi package contributes `skills/` convention resource;
2. project Pi package contributes a `pi.skills` manifest resource;
3. user extension returns an external skill file/directory from
   `resources_discover`;
4. project extension returns an external skill file/directory;
5. package extension returns a dynamic skill;
6. duplicate paths preserve Pi's winner and exact file path;
7. disabled package resources do not appear;
8. `get_commands` reports `sourceInfo.scope` as `user`/`project` for cases 1–5,
   never `temporary` except a genuinely temporary CLI extension.

## Why alternatives are rejected

- Parsing Pi settings/package manifests in BB duplicates install paths,
  package filters, precedence, trust, npm wrappers, git reconciliation,
  autoload deltas, ignore files, symlink rules, and future Pi changes.
- Looking only under `.pi/{npm,git}` misses local packages, manifest globs,
  filters, dependencies exposed through manifests, and dynamic resources.
- Inferring origin from an absolute resource path confuses ownership/trust with
  path containment.
- Copies, staged skill trees, and frontmatter rewriting break original paths and
  are unnecessary because BB supports `skill-file` roots directly.
- Sharing state with the provider bridge would require private lifecycle
  coupling. The host resolver and bridge are distinct host-artifact entrypoints;
  the public contract is a self-contained host RPC call.
