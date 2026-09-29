import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import type { InstalledPlugin, Registry } from "./types.ts";

/**
 * pi's global agent directory. We intentionally mirror pi's own convention
 * (`~/.pi/agent`) rather than importing a path helper, because this data must
 * live outside any single pi package install: the registry survives package
 * updates and is shared by both the extension and the CLI.
 *
 * CONFIG_DIR_NAME is `.pi` for the stock build; rebranded distributions differ,
 * so callers may override the base via the PI_CLAUDE_PLUGINS_DIR env var.
 */
const CONFIG_DIR_NAME = ".pi";

export function loaderHome(): string {
  const override = process.env.PI_CLAUDE_PLUGINS_DIR;
  if (override) return override;
  return join(homedir(), CONFIG_DIR_NAME, "agent", "claude-plugins");
}

export function reposDir(): string {
  return join(loaderHome(), "repos");
}

function registryPath(): string {
  return join(loaderHome(), "registry.json");
}

export function readRegistry(): Registry {
  const path = registryPath();
  if (!existsSync(path)) return { version: 1, plugins: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Registry;
    if (!parsed || !Array.isArray(parsed.plugins)) return { version: 1, plugins: [] };
    return { version: 1, plugins: parsed.plugins };
  } catch {
    // A corrupt registry should not brick every session. Start fresh; the next
    // install rewrites it.
    return { version: 1, plugins: [] };
  }
}

export function writeRegistry(registry: Registry): void {
  mkdirSync(loaderHome(), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify(registry, null, 2) + "\n", "utf8");
}

/** Add or replace a plugin by name, then persist. */
export function upsertPlugin(plugin: InstalledPlugin): Registry {
  const registry = readRegistry();
  const next = registry.plugins.filter((p) => p.name !== plugin.name);
  next.push(plugin);
  const updated: Registry = { version: 1, plugins: next };
  writeRegistry(updated);
  return updated;
}

/** Remove a plugin by name, including its staged skill copies. Returns whether anything was removed. */
export function removePlugin(name: string): boolean {
  const registry = readRegistry();
  const removedEntries = registry.plugins.filter((p) => p.name === name);
  const next = registry.plugins.filter((p) => p.name !== name);
  const removed = removedEntries.length > 0;
  if (!removed) return false;

  writeRegistry({ version: 1, plugins: next });
  // Staged skill copies live under this loader's home; the fetched repo clone
  // is left in the cache so a later reinstall is cheap.
  const stageRoot = join(loaderHome(), "skills");
  for (const entry of removedEntries) {
    for (const dir of entry.skillDirs) {
      if (dir.startsWith(stageRoot)) rmSync(dir, { recursive: true, force: true });
    }
  }
  return removed;
}
