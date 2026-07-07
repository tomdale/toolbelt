import { basename, join } from "node:path";
import { stat } from "node:fs/promises";
import { readJsonFile, readTextFile, walkFiles } from "./fs.js";
import type { SessionRecord } from "./types.js";

interface CodexMessage {
  role?: unknown;
  content?: unknown;
}

interface CodexConversation {
  id?: unknown;
  title?: unknown;
  cwd?: unknown;
  messages?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

export async function scanCodex(homeDir: string): Promise<SessionRecord[]> {
  const roots = [join(homeDir, ".codex", "sessions"), join(homeDir, ".codex", "history")];
  const files = (
    await Promise.all(roots.map((root) => walkFiles(root, (path) => path.endsWith(".json") || path.endsWith(".jsonl"))))
  ).flat();

  const records = await Promise.all(files.map(parseCodexFile));
  return records.filter((record): record is SessionRecord => Boolean(record));
}

async function parseCodexFile(path: string): Promise<SessionRecord | undefined> {
  try {
    const parsed = path.endsWith(".jsonl") ? parseCodexJsonl(await readTextFile(path)) : await parseCodexJson(path);
    const info = await stat(path);
    return {
      provider: "codex",
      id: parsed.id ?? basename(path).replace(/\.(jsonl|json)$/u, ""),
      title: parsed.title ?? parsed.preview ?? basename(path),
      cwd: parsed.cwd,
      path,
      createdAt: parsed.createdAt ?? info.birthtime,
      updatedAt: parsed.updatedAt ?? info.mtime,
      messageCount: parsed.messageCount,
      preview: parsed.preview,
    };
  } catch {
    return undefined;
  }
}

async function parseCodexJson(path: string): Promise<ParsedCodex> {
  const json = (await readJsonFile(path)) as CodexConversation;
  const messages = Array.isArray(json.messages) ? json.messages : [];
  const firstText = messages.map(extractMessageText).find(Boolean);

  return {
    id: typeof json.id === "string" ? json.id : undefined,
    cwd: typeof json.cwd === "string" ? json.cwd : undefined,
    title: typeof json.title === "string" && json.title.trim() ? json.title.trim() : undefined,
    createdAt: parseDate(json.created_at),
    updatedAt: parseDate(json.updated_at),
    messageCount: messages.length || undefined,
    preview: firstText,
  };
}

function parseCodexJsonl(text: string): ParsedCodex {
  const events = text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => safeParseJson(line))
    .filter((event): event is Record<string, unknown> => Boolean(event));

  const firstText = events.map(extractCodexUserText).find(Boolean);
  const timestamps = events.map((event) => parseDate(event.timestamp ?? event.created_at ?? getNested(event, ["payload", "timestamp"]))).filter(Boolean) as Date[];
  const id = events
    .flatMap((event) => [event.id, getNested(event, ["payload", "id"]), getNested(event, ["payload", "session_id"])])
    .find((value): value is string => typeof value === "string");
  const cwd = events
    .flatMap((event) => [event.cwd, getNested(event, ["payload", "cwd"])])
    .find((value): value is string => typeof value === "string");
  const title = events
    .flatMap((event) => [event.title, getNested(event, ["payload", "title"])])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);

  return {
    id,
    cwd,
    title: title?.trim(),
    createdAt: timestamps[0],
    updatedAt: timestamps.at(-1),
    messageCount: events.length || undefined,
    preview: firstText,
  };
}

interface ParsedCodex {
  id?: string;
  cwd?: string;
  title?: string;
  createdAt?: Date;
  updatedAt?: Date;
  messageCount?: number;
  preview?: string;
}

function extractCodexUserText(event: Record<string, unknown>): string | undefined {
  const role = event.role ?? getNested(event, ["payload", "role"]);
  const type = event.type ?? getNested(event, ["payload", "type"]);

  if (role !== "user" && type !== "user") {
    return undefined;
  }

  const text = extractMessageText(event);
  return text && !isContextText(text) ? text : undefined;
}

function extractMessageText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const message = value as CodexMessage & Record<string, unknown>;
  const payload = message.payload && typeof message.payload === "object" ? (message.payload as Record<string, unknown>) : undefined;
  const payloadMessage = payload?.message && typeof payload.message === "object" ? (payload.message as Record<string, unknown>) : undefined;
  const content = message.content ?? message.message ?? message.text ?? payload?.content ?? payloadMessage?.content;
  return extractText(content);
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizePreview(value);
  }

  if (Array.isArray(value)) {
    return value.map(extractText).find(Boolean);
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

function isContextText(text: string): boolean {
  return (
    text.startsWith("# AGENTS.md instructions") ||
    text.startsWith("<codex_internal_context") ||
    text.startsWith("<environment_context>")
  );
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

function getNested(value: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = value;

  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}
