/**
 * Types describing the subset of Claude Code's plugin format that this loader
 * understands. The full schema (hooks, MCP servers, LSP servers, monitors,
 * agents, themes) is documented at https://code.claude.com/docs/en/plugins-reference.
 *
 * pi has no runtime-compatible equivalent for most of those components, so we
 * deliberately map only what pi can load natively: skills and slash commands.
 * Everything else in a manifest is parsed but ignored.
 */

/** A Claude plugin manifest (`.claude-plugin/plugin.json`). All fields optional per the spec except `name`. */
export interface ClaudePluginManifest {
  name?: string;
  displayName?: string;
  version?: string;
  description?: string;
  /** Extra skill directories, added on top of the default `skills/` scan. */
  skills?: string | string[];
  /** Flat command markdown files or directories. Replaces the default `commands/` scan. */
  commands?: string | string[];
}

/** How a marketplace entry points at the plugin's files. */
export type ClaudePluginSource =
  | string
  | {
      source?: "local" | "git" | "github";
      path?: string;
      url?: string;
      repo?: string;
    };

/** A single plugin entry inside a marketplace manifest. */
export interface ClaudeMarketplacePlugin {
  name: string;
  source?: ClaudePluginSource;
  description?: string;
}

/** A Claude marketplace manifest (`.claude-plugin/marketplace.json`). */
export interface ClaudeMarketplaceManifest {
  name?: string;
  plugins?: ClaudeMarketplacePlugin[];
}

/**
 * One installed plugin recorded in the loader registry. Paths are absolute so
 * the extension can hand them straight to pi's resource loader without
 * re-resolving anything at session start.
 */
export interface InstalledPlugin {
  /** Plugin name, used as the identity for dedup and removal. */
  name: string;
  displayName?: string;
  description?: string;
  version?: string;
  /** The `pi install`-style source the user asked for, e.g. `git:github.com/tomdale/skills`. */
  source: string;
  /** Marketplace name when the plugin came from a marketplace manifest. */
  marketplace?: string;
  /** Absolute path to the resolved plugin root on disk. */
  root: string;
  /** Absolute skill directories to scan (fed to pi as skillPaths). */
  skillDirs: string[];
  /** Absolute command files/directories (fed to pi as promptPaths). */
  commandPaths: string[];
  installedAt: string;
}

export interface Registry {
  version: 1;
  plugins: InstalledPlugin[];
}
