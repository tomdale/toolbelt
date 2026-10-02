import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { fetchSource, parseSource, type ResolvedSource } from "./source.ts";
import { readRegistry, upsertPlugin } from "./registry.ts";
import { stageNamespacedSkills } from "./skills.ts";
import type {
  ClaudeMarketplaceManifest,
  ClaudePluginManifest,
  ClaudePluginSource,
  InstalledPlugin,
} from "./types.ts";

/**
 * Install every plugin advertised by a source and record it in the registry.
 *
 * A source may be a single plugin (a `.claude-plugin/plugin.json` at its root,
 * or a bare `skills/` directory) or a marketplace listing several plugins. We
 * resolve each plugin down to the concrete skill and command paths pi can load,
 * because pi's resource loader wants directories to scan, not manifest fields
 * to interpret.
 */
export function installFromSource(spec: string): InstalledPlugin[] {
  const source = parseSource(spec);
  const repoRoot = fetchSource(source);
  const discovered = discoverPlugins(repoRoot, source, spec);

  if (discovered.length === 0) {
    throw new Error(
      `No Claude plugins found in ${spec}. Expected a .claude-plugin/marketplace.json, ` +
        `a .claude-plugin/plugin.json, or a skills/ directory.`,
    );
  }

  const installed: InstalledPlugin[] = [];
  for (const plugin of discovered) {
    installed.push(upsertPlugin(plugin));
  }
  return installed;
}

/**
 * Re-discover registered local plugins so Pi sessions see edits in their
 * source repositories without requiring an explicit reinstall. Remote plugins
 * remain unchanged until the user explicitly installs or updates them.
 */
export function refreshLocalPlugins(): void {
  const registry = readRegistry();
  const refreshed = new Set<string>();
  for (const plugin of registry.plugins) {
    let source: ResolvedSource;
    try {
      source = parseSource(plugin.source);
    } catch {
      continue;
    }
    if (source.kind !== "local" || refreshed.has(source.path)) continue;
    refreshed.add(source.path);

    try {
      for (const candidate of discoverPlugins(source.path, source, plugin.source)) {
        const expected = registry.plugins.find((p) => p.name === candidate.name);
        // Refresh may replace an installed record, but must not resurrect a
        // plugin removed or explicitly reinstalled while discovery was running.
        if (expected) upsertPlugin(candidate, expected);
      }
    } catch (error) {
      console.warn(`Could not refresh local Claude plugin ${plugin.name}: ${(error as Error).message}`);
    }
  }
}

function registrySource(source: ResolvedSource, spec: string): string {
  return source.kind === "local" ? source.path : source.label ?? spec;
}

function discoverPlugins(repoRoot: string, source: ResolvedSource, spec: string): InstalledPlugin[] {
  const marketplacePath = join(repoRoot, ".claude-plugin", "marketplace.json");
  const marketplaceText = existsSync(marketplacePath) ? readFileSync(marketplacePath, "utf8") : "";
  const marketplace = parseJson<ClaudeMarketplaceManifest>(marketplaceText);

  if (marketplace?.plugins?.length) {
    const results: InstalledPlugin[] = [];
    for (const entry of marketplace.plugins) {
      const pluginRoot = resolvePluginRoot(repoRoot, entry.source);
      if (!pluginRoot) continue;
      results.push(
        buildInstalledPlugin({
          root: pluginRoot,
          fallbackName: entry.name,
          description: entry.description,
          marketplace: marketplace.name,
          marketplaceText,
          source: registrySource(source, spec),
        }),
      );
    }
    return results;
  }

  // No marketplace: treat the source root as a single plugin.
  return [
    buildInstalledPlugin({
      root: repoRoot,
      fallbackName: undefined,
      source: registrySource(source, spec),
    }),
  ];
}

/**
 * Resolve a marketplace entry's `source` to a directory. Only local (in-repo)
 * sources are resolved here; external git/github plugin sources are cloned
 * separately.
 */
function resolvePluginRoot(repoRoot: string, source: ClaudePluginSource | undefined): string | null {
  if (source === undefined) return repoRoot;

  if (typeof source === "string") {
    return resolveWithin(repoRoot, source);
  }

  if (source.source === "local" || source.source === undefined) {
    return resolveWithin(repoRoot, source.path ?? ".");
  }

  // github/git object sources: clone the referenced repo, then treat its root
  // as the plugin root.
  const url = source.url ?? (source.repo ? `https://github.com/${source.repo}` : undefined);
  if (!url) return null;
  return fetchSource(parseSource(url));
}

function resolveWithin(repoRoot: string, relative: string): string {
  const resolved = isAbsolute(relative) ? relative : resolve(repoRoot, relative);
  return existsSync(resolved) ? resolved : repoRoot;
}

function buildInstalledPlugin(args: {
  root: string;
  fallbackName?: string;
  description?: string;
  marketplace?: string;
  marketplaceText?: string;
  source: string;
}): InstalledPlugin {
  const manifestPath = join(args.root, ".claude-plugin", "plugin.json");
  const manifestText = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
  const manifest = parseJson<ClaudePluginManifest>(manifestText);
  const name = manifest?.name ?? args.fallbackName ?? basename(args.root);

  // Skills are staged under a `<plugin>-`-namespaced copy so they never collide
  // with global skills or other plugins. pi scans the staging root, not the
  // originals.
  const sourceSkillDirs = resolveSkillDirs(args.root, manifest);
  const stagedSkillDir = stageNamespacedSkills(name, args.root, sourceSkillDirs, [
    manifestText,
    args.marketplaceText ?? "",
    JSON.stringify([args.fallbackName, args.description, args.marketplace]),
  ]);

  return {
    name,
    displayName: manifest?.displayName,
    description: manifest?.description ?? args.description,
    version: manifest?.version,
    source: args.source,
    marketplace: args.marketplace,
    root: args.root,
    skillDirs: stagedSkillDir ? [stagedSkillDir] : [],
    commandPaths: resolveCommandPaths(args.root, manifest),
    installedAt: new Date().toISOString(),
  };
}

/**
 * Skill directories to scan. Per the Claude spec, a manifest `skills` field
 * *adds to* the default `skills/` scan rather than replacing it, and a lone
 * `SKILL.md` at the plugin root is itself a single skill when there is no
 * skills directory.
 */
function resolveSkillDirs(root: string, manifest: ClaudePluginManifest | null): string[] {
  const dirs = new Set<string>();

  const defaultDir = join(root, "skills");
  if (isDir(defaultDir)) dirs.add(defaultDir);

  for (const rel of toArray(manifest?.skills)) {
    const resolved = resolve(root, rel);
    if (isDir(resolved)) dirs.add(resolved);
  }

  if (dirs.size === 0 && existsSync(join(root, "SKILL.md"))) {
    dirs.add(root);
  }

  return [...dirs];
}

/**
 * Command paths become pi prompt templates. A manifest `commands` field
 * replaces the default `commands/` scan; otherwise the default directory is
 * used when present.
 */
function resolveCommandPaths(root: string, manifest: ClaudePluginManifest | null): string[] {
  if (manifest?.commands !== undefined) {
    return toArray(manifest.commands)
      .map((rel) => resolve(root, rel))
      .filter((p) => existsSync(p));
  }

  const defaultDir = join(root, "commands");
  return isDir(defaultDir) ? [defaultDir] : [];
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}
