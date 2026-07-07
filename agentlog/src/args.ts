import { homedir } from "node:os";
import type { AgentProvider } from "./types.js";

export interface CliOptions {
  providers: AgentProvider[];
  homeDir: string;
  targetDir: string;
  limit?: number;
  query?: string;
  json: boolean;
}

const providerValues = new Set<AgentProvider>(["codex", "claude"]);

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    providers: ["codex", "claude"],
    homeDir: homedir(),
    targetDir: process.cwd(),
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case "--agent":
      case "-a":
        options.providers = parseProviders(next());
        break;
      case "--home":
        options.homeDir = next();
        break;
      case "--cwd":
      case "--path":
        options.targetDir = next();
        break;
      case "--json":
        options.json = true;
        break;
      case "--limit":
      case "-n":
        options.limit = parseLimit(next());
        break;
      case "--query":
      case "-q":
        options.query = next();
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function parseProviders(value: string): AgentProvider[] {
  const providers = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (providers.length === 0) {
    throw new Error("At least one agent provider is required.");
  }

  for (const provider of providers) {
    if (!providerValues.has(provider as AgentProvider)) {
      throw new Error(`Unsupported agent provider: ${provider}`);
    }
  }

  return providers as AgentProvider[];
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--limit must be a positive integer.");
  }

  return limit;
}

function printHelp(): void {
  console.log(`agentlog

Inspect coding agent session history.

Usage:
  agentlog [options]

Options:
  -a, --agent codex,claude  Agents to scan (default: codex,claude)
      --home PATH           Home directory to inspect (default: current user)
      --cwd PATH            Directory tree to match (default: current directory)
  -n, --limit NUMBER        Maximum sessions to print (default: all matching)
  -q, --query TEXT          Filter by title, preview, id, path, or provider
      --json                Print JSON instead of a table
  -h, --help                Show this help
`);
}
