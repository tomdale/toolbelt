import { basename, join } from "node:path";
import { stat } from "node:fs/promises";
import { readTextFile, walkFiles } from "./fs.js";
import type { SessionRecord } from "./types.js";

export async function scanClaude(homeDir: string): Promise<SessionRecord[]> {
  const root = join(homeDir, ".claude", "projects");
  const files = await walkFiles(root, (path) => path.endsWith(".jsonl"));
  const records = await Promise.all(files.map(parseClaudeFile));
  return records.filter((record): record is SessionRecord => Boolean(record));
}

async function parseClaudeFile(path: string): Promise<SessionRecord | undefined> {
  try {
    const text = await readTextFile(path);
    const events = text
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => safeParseJson(line))
      .filter((event): event is Record<string, unknown> => Boolean(event));
    const info = await stat(path);
    const timestamps = events.map((event) => parseDate(event.timestamp)).filter(Boolean) as Date[];
    const firstText = events.map(extractClaudeText).find(Boolean);
    const cwd = events.map((event) => event.cwd).find((value): value is string => typeof value === "string");
    const sessionId = events.map((event) => event.sessionId).find((value): value is string => typeof value === "string");

    return {
      provider: "claude",
      id: sessionId ?? basename(path).replace(/\.jsonl$/u, ""),
      title: firstText ?? cwd ?? basename(path),
      cwd,
      path,
      createdAt: timestamps[0] ?? info.birthtime,
      updatedAt: timestamps.at(-1) ?? info.mtime,
      messageCount: events.length || undefined,
      preview: firstText,
    };
  } catch {
    return undefined;
  }
}

function extractClaudeText(event: Record<string, unknown>): string | undefined {
  const message = event.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    const text = extractText(content);
    if (text) {
      return text;
    }
  }

  return extractText(event.text ?? event.content);
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizePreview(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractText(item);
      if (text) {
        return text;
      }
    }
  }

  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return extractText(object.text ?? object.content);
  }

  return undefined;
}

function normalizePreview(value: string): string | undefined {
  const text = value.replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, 120) : undefined;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function safeParseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}
