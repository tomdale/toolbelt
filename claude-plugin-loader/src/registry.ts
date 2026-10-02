import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";

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

function writeRegistry(registry: Registry): void {
  const temporary = mkdtempSync(join(loaderHome(), ".registry-"));
  try {
    const path = join(temporary, "registry.json");
    writeFileSync(path, JSON.stringify(registry, null, 2) + "\n", "utf8");
    renameSync(path, registryPath());
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Serialize the entire registry read-modify-write, not the snapshot build. */
function withRegistryLock<T>(operation: () => T): T {
  mkdirSync(loaderHome(), { recursive: true });
  const lock = join(loaderHome(), "registry.lock");
  const deadline = Date.now() + 5_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        // Never reclaim by age: a paused writer could resume and overwrite a
        // newer registry. An interrupted writer's lock needs explicit removal.
        throw new Error(`Registry is locked at ${lock}; if no loader is writing, remove the lock and retry`);
      }
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function samePlugin(a: InstalledPlugin, b: InstalledPlugin): boolean {
  return JSON.stringify({ ...a, installedAt: undefined }) ===
    JSON.stringify({ ...b, installedAt: undefined });
}

function discoveryPath(name: string): string {
  return join(loaderHome(), "current", encodeURIComponent(name));
}

function discoveryTarget(name: string): string | null {
  const path = discoveryPath(name);
  try {
    if (!lstatSync(path).isSymbolicLink()) {
      throw new Error(`Discovery path is not a symlink; leave it untouched: ${path}`);
    }
    return readlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function packageSnapshot(plugin: InstalledPlugin): string | undefined {
  const root = plugin.skillDirs[0];
  return root && basename(root) === "skills" ? dirname(root) : root;
}

function hasDiscoveryLink(plugin: InstalledPlugin): boolean {
  return discoveryTarget(plugin.name) === (packageSnapshot(plugin) ?? null);
}

/** Update only the discovery alias; session paths continue to name snapshots. */
function updateDiscoveryLink(plugin: InstalledPlugin): void {
  const target = packageSnapshot(plugin);
  const current = discoveryTarget(plugin.name);
  if (current === (target ?? null)) return;
  if (!target) {
    unlinkSync(discoveryPath(plugin.name));
    return;
  }
  const directory = join(loaderHome(), "current");
  mkdirSync(directory, { recursive: true });
  const temporary = mkdtempSync(join(directory, ".link-"));
  try {
    const link = join(temporary, "snapshot");
    symlinkSync(target, link, "dir");
    renameSync(link, discoveryPath(plugin.name));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Add or replace a plugin, preserving its timestamp when nothing changed. */
export function upsertPlugin(plugin: InstalledPlugin, expected?: InstalledPlugin): InstalledPlugin {
  // Unchanged startups do not even acquire a lock or write registry metadata.
  const existing = readRegistry().plugins.find((p) => p.name === plugin.name);
  if (existing && samePlugin(existing, plugin) && hasDiscoveryLink(existing)) return existing;
  return withRegistryLock(() => {
    const registry = readRegistry();
    const current = registry.plugins.find((p) => p.name === plugin.name);
    if (expected && JSON.stringify(current) !== JSON.stringify(expected)) return current ?? expected;
    updateDiscoveryLink(plugin);
    if (current && samePlugin(current, plugin)) return current;
    const next = registry.plugins.filter((p) => p.name !== plugin.name);
    next.push(plugin);
    writeRegistry({ version: 1, plugins: next });
    return plugin;
  });
}

/** Unregister without deleting snapshots still referenced by running sessions. */
export function removePlugin(name: string): boolean {
  return withRegistryLock(() => {
    const registry = readRegistry();
    const next = registry.plugins.filter((p) => p.name !== name);
    if (next.length === registry.plugins.length) return false;
    const target = discoveryTarget(name);
    if (target !== null) unlinkSync(discoveryPath(name));
    writeRegistry({ version: 1, plugins: next });
    return true;
  });
}
