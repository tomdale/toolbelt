#!/usr/bin/env node
/**
 * Headless companion to the `/claude-plugin` command. Same registry, same
 * resolution logic, usable from scripts and CI where a pi session isn't
 * running. After installing here, a pi session with the loader extension picks
 * up the new skills on its next `resources_discover`.
 */
import { installFromSource } from "./install.ts";
import { readRegistry, removePlugin } from "./registry.ts";

function main(argv: string[]): number {
  const [command, ...rest] = argv;

  switch (command) {
    case "install": {
      const spec = rest.join(" ").trim();
      if (!spec) {
        console.error("Usage: pi-claude-plugin install <source>");
        return 1;
      }
      const installed = installFromSource(spec);
      for (const plugin of installed) {
        console.log(
          `Installed ${plugin.name}: ${plugin.skillDirs.length} skill dir(s), ` +
            `${plugin.commandPaths.length} command path(s)`,
        );
        for (const dir of plugin.skillDirs) console.log(`  skills: ${dir}`);
      }
      return 0;
    }

    case "remove": {
      const name = rest.join(" ").trim();
      if (!name) {
        console.error("Usage: pi-claude-plugin remove <name>");
        return 1;
      }
      console.log(removePlugin(name) ? `Removed ${name}` : `No plugin named ${name}`);
      return 0;
    }

    case "list":
    case undefined: {
      const registry = readRegistry();
      if (registry.plugins.length === 0) {
        console.log("No Claude plugins installed.");
        return 0;
      }
      for (const plugin of registry.plugins) {
        console.log(`${plugin.name}  [${plugin.source}]`);
        for (const dir of plugin.skillDirs) console.log(`  skills: ${dir}`);
        for (const path of plugin.commandPaths) console.log(`  commands: ${path}`);
      }
      return 0;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Commands: install <source> | list | remove <name>");
      return 1;
  }
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exit(1);
}
