import { resolve, sep } from "node:path";
import { scanClaude } from "./claude.js";
import { scanCodex } from "./codex.js";
import type { AgentProvider, ScanOptions, SessionRecord } from "./types.js";

export async function scanSessions(options: ScanOptions): Promise<SessionRecord[]> {
  const scanners: Record<AgentProvider, () => Promise<SessionRecord[]>> = {
    codex: () => scanCodex(options.homeDir),
    claude: () => scanClaude(options.homeDir),
  };

  const records = (await Promise.all(options.providers.map((provider) => scanners[provider]()))).flat();
  const inTree = records.filter((record) => isInTree(record.cwd, options.targetDir));
  const filtered = options.query ? inTree.filter((record) => matchesQuery(record, options.query!)) : inTree;

  return filtered
    .sort((left, right) => dateValue(right.updatedAt ?? right.createdAt) - dateValue(left.updatedAt ?? left.createdAt))
    .slice(0, options.limit);
}

function matchesQuery(record: SessionRecord, query: string): boolean {
  const haystack = [record.provider, record.id, record.title, record.preview, record.path].filter(Boolean).join("\n").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function dateValue(value: Date | undefined): number {
  return value?.getTime() ?? 0;
}

function isInTree(candidate: string | undefined, targetDir: string): boolean {
  if (!candidate) {
    return false;
  }

  const normalizedCandidate = withoutTrailingSeparator(resolve(candidate));
  const normalizedTarget = withoutTrailingSeparator(resolve(targetDir));

  return normalizedCandidate === normalizedTarget || normalizedCandidate.startsWith(`${normalizedTarget}${sep}`);
}

function withoutTrailingSeparator(path: string): string {
  return path.endsWith(sep) && path !== sep ? path.slice(0, -1) : path;
}
