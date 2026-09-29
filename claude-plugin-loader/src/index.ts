import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installFromSource } from "./install.ts";
import { readRegistry, removePlugin } from "./registry.ts";
import type { InstalledPlugin } from "./types.ts";

/**
 * Bridge Claude Code's plugin format into pi.
 *
 * Loading side: on `resources_discover` we read the registry written by the
 * installer and hand pi the resolved skill and command directories. pi's own
 * resource loader scans them exactly as it would any other skill path, so
 * Claude plugin skills become first-class pi skills with no per-skill glue.
 *
 * Install side: the `/claude-plugin` command clones a Claude plugin or
 * marketplace, records what it found, then reloads the session so the newly
 * installed skills appear immediately.
 */
export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", async () => {
    const registry = readRegistry();
    const skillPaths = new Set<string>();
    const promptPaths = new Set<string>();

    for (const plugin of registry.plugins) {
      for (const dir of plugin.skillDirs) skillPaths.add(dir);
      for (const path of plugin.commandPaths) promptPaths.add(path);
    }

    return {
      skillPaths: [...skillPaths],
      promptPaths: [...promptPaths],
    };
  });

  pi.registerCommand("claude-plugin", {
    description: "Install and manage Claude Code plugins (install <src> | list | remove <name>)",
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (subcommand === "install") {
        const spec = rest.join(" ").trim();
        if (!spec) {
          ctx.ui.notify("Usage: /claude-plugin install <source>", "error");
          return;
        }
        ctx.ui.setStatus("claude-plugin", `Installing ${spec}...`);
        try {
          const installed = installFromSource(spec);
          ctx.ui.setStatus("claude-plugin", "");
          ctx.ui.notify(summarizeInstall(installed), "info");
          // Reload so resources_discover re-runs and the new skills load now.
          await ctx.reload();
          return;
        } catch (error) {
          ctx.ui.setStatus("claude-plugin", "");
          ctx.ui.notify(`Install failed: ${(error as Error).message}`, "error");
          return;
        }
      }

      if (subcommand === "remove") {
        const name = rest.join(" ").trim();
        if (!name) {
          ctx.ui.notify("Usage: /claude-plugin remove <name>", "error");
          return;
        }
        const removed = removePlugin(name);
        if (!removed) {
          ctx.ui.notify(`No installed plugin named "${name}"`, "error");
          return;
        }
        ctx.ui.notify(`Removed plugin "${name}"`, "info");
        await ctx.reload();
        return;
      }

      // Default: list.
      const registry = readRegistry();
      if (registry.plugins.length === 0) {
        ctx.ui.notify("No Claude plugins installed. Use /claude-plugin install <source>", "info");
        return;
      }
      ctx.ui.notify(registry.plugins.map(describePlugin).join("\n"), "info");
    },
  });
}

function summarizeInstall(installed: InstalledPlugin[]): string {
  const lines = installed.map((plugin) => {
    const skills = plugin.skillDirs.length;
    const commands = plugin.commandPaths.length;
    const parts = [`${skills} skill dir${skills === 1 ? "" : "s"}`];
    if (commands > 0) parts.push(`${commands} command path${commands === 1 ? "" : "s"}`);
    return `  ${plugin.name} (${parts.join(", ")})`;
  });
  return `Installed ${installed.length} plugin(s):\n${lines.join("\n")}`;
}

function describePlugin(plugin: InstalledPlugin): string {
  const label = plugin.displayName ? `${plugin.name} — ${plugin.displayName}` : plugin.name;
  return `  ${label}  [${plugin.source}]`;
}
