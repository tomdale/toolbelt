import { z } from "zod";
import { excerpt } from "./model.ts";
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
const TIMELINE_CHARS = 600;
const TIMELINE_CONTEXT_CHARS = 24_000;
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
  const budget = Math.floor(TIMELINE_CONTEXT_CHARS / (TIMELINE_CHARS + 24));
  const stride = Math.ceil(lines.length / budget);
  const sampled = lines.filter(
    (_, index) => index % stride === 0 || index === lines.length - 1,
  );
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
