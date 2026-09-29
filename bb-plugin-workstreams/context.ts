import { z } from "zod";
import { excerpt } from "./model.ts";
import type { LogEntry } from "./organize.ts";
import { redact } from "./redact.ts";

const inputSchema = z.array(
  z.object({ type: z.string(), text: z.string().optional() }),
);
export function inputText(input: unknown): string {
  const parsed = inputSchema.safeParse(input);
  return parsed.success
    ? parsed.data
        .filter((i) => i.type === "text")
        .map((i) => i.text ?? "")
        .join("\n")
        .trim()
    : "";
}
export function initialRequest(
  events: { type: string; data: unknown }[],
): string {
  for (const event of events) {
    if (event.type !== "client/turn/requested") continue;
    const parsed = z.object({ input: z.unknown() }).safeParse(event.data);
    const text = parsed.success ? inputText(parsed.data.input) : "";
    if (text) return text;
  }
  return "";
}
/** Only sections not attributable to Workstreams are manual grouping corrections. */
export function manualSectionGroup(
  sectionId: string | null,
  names: Map<string, string>,
  log: LogEntry[],
  threadId: string,
): string | undefined {
  const name = sectionId ? names.get(sectionId) : undefined;
  if (!name) return undefined;
  const assignment = [...log]
    .reverse()
    .find(
      (entry) =>
        entry.action.kind === "section" &&
        entry.action.threadId === threadId &&
        entry.result === "done" &&
        !entry.undone,
    );
  if (assignment?.action.kind === "section") {
    // Older log entries have no destination ID. Matching their recorded name
    // avoids turning an existing automatic assignment into a permanent pin.
    const autoId = assignment.undo?.workstreamsSectionId;
    if (
      name.toLowerCase() === assignment.action.section.toLowerCase() &&
      (!autoId || sectionId === autoId)
    )
      return undefined;
  }
  return name;
}
const TIMELINE_CHARS = 600;
// The full history is paged from BB, but short prompts make identity pivots
// disappear among routine status/approval chatter. Keep semantic anchors at
// the start, end, and low-density points between them.
const TIMELINE_CONTEXT_CHARS = 48_000;
/**
 * One line per user request with its event seq, so the model can place a
 * drift split point that `threads.fork({ sourceSeqEnd })` can act on. BB's
 * own child-thread notices are omitted. Keep requests across the full thread;
 * the drift prompt bounds total characters without dropping the middle.
 */
export function requestTimeline(
  events: { type: string; seq?: number; data: unknown }[],
): string {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type !== "client/turn/requested" || event.seq === undefined)
      continue;
    const parsed = z.object({ input: z.unknown() }).safeParse(event.data);
    const text = parsed.success ? inputText(parsed.data.input) : "";
    if (!text || text.startsWith("[bb system]")) continue;
    const flat = text.replace(/\s+/g, " ");
    lines.push(
      `#${event.seq}: ${flat.length > TIMELINE_CHARS ? `${flat.slice(0, TIMELINE_CHARS - 1)}…` : flat}`,
    );
  }
  if (lines.length < 2) return "";
  const complete = redact(lines.join("\n"));
  if (complete.length <= TIMELINE_CONTEXT_CHARS) return complete;
  // Segment the conversation at sparse intervals, while preserving the first
  // requests, the latest requests, and representative requests across *all*
  // intermediate intervals. Simple global stride sampling can alias into a
  // narrow temporal window when user messages cluster irregularly.
  const target = Math.floor(TIMELINE_CONTEXT_CHARS / (TIMELINE_CHARS + 24));
  const anchors = new Set<number>();
  const fixed = Math.min(5, lines.length);
  for (let i = 0; i < fixed; i++) anchors.add(i);
  for (let i = Math.max(fixed, lines.length - 8); i < lines.length; i++)
    anchors.add(i);
  const slots = Math.max(1, target - anchors.size);
  for (let bucket = 0; bucket < slots; bucket++) {
    const start =
      fixed + Math.floor((bucket * (lines.length - fixed - 8)) / slots);
    const end =
      fixed + Math.floor(((bucket + 1) * (lines.length - fixed - 8)) / slots);
    if (end > start) anchors.add(Math.floor((start + end - 1) / 2));
  }
  const sampled = [...anchors]
    .sort((a, b) => a - b)
    .map((index) => lines[index]);
  return redact(sampled.join("\n")).slice(0, TIMELINE_CONTEXT_CHARS);
}
export function contextExcerpt(
  initial: string,
  recent: { createdAt: number; input: unknown }[],
  output: string | null,
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  if (initial) {
    parts.push(
      `Initial user request (historical intent; later explicit scope changes take precedence):\n${excerpt(initial, 2400)}`,
    );
    seen.add(initial);
  }
  // The API returns newest first. Present conversation order explicitly.
  for (const prompt of [...recent].sort((a, b) => a.createdAt - b.createdAt)) {
    const text = inputText(prompt.input);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push(
      `Recent user request (${new Date(prompt.createdAt).toISOString()}):\n${excerpt(text, 1500)}`,
    );
  }
  if (output)
    parts.push(
      `Last assistant report (unverified; may describe procedure rather than the work):\n${excerpt(output, 2500)}`,
    );
  return redact(parts.join("\n\n"));
}
