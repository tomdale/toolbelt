/**
 * Debug trace shapes (SPEC §11.6), shared by the server that records model
 * calls and the inspector that shows them. Pure, so the app can import it.
 */
import { z } from "zod";

export const usageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cost: z.number(),
});
export type Usage = z.infer<typeof usageSchema>;

export const TRACE_KINDS = ["analysis", "route", "organize"] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

/**
 * `ok`: the response parsed. `invalid`: it didn't, so Workstreams used
 * nothing from it. `failed`: the call itself failed.
 */
export const TRACE_STATUSES = ["ok", "invalid", "failed"] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

export const LINK_KINDS = [
  "thread",
  "entry",
  "proposal",
  "section",
  "organize",
] as const;
export type TraceLink = {
  kind: (typeof LINK_KINDS)[number];
  ref: string;
};
export const linkSchema = z.object({
  kind: z.enum(LINK_KINDS),
  ref: z.string().min(1).max(200),
});

export const traceSummarySchema = z.object({
  id: z.string(),
  at: z.number(),
  kind: z.enum(TRACE_KINDS),
  status: z.enum(TRACE_STATUSES),
  label: z.string(),
  model: z.string(),
  durationMs: z.number(),
  replayOf: z.string().nullable(),
  usage: usageSchema.nullable(),
  error: z.string().nullable(),
  /** One line of what the model decided, e.g. "review · Workstreams". */
  summary: z.string().nullable(),
  /** Threads the call is about. */
  threads: z.array(z.string()),
});
export type TraceSummary = z.infer<typeof traceSummarySchema>;

export const traceSchema = traceSummarySchema.extend({
  provider: z.string(),
  thinking: z.string(),
  system: z.string(),
  prompt: z.string(),
  /** The structured input the prompt was built from, redacted and bounded. */
  input: z.unknown(),
  response: z.string().nullable(),
  reasoning: z.string().nullable(),
  stopReason: z.string().nullable(),
  /** The validated output, exactly as the parser returned it. */
  parsed: z.unknown(),
  /** What Workstreams stored or decided from it, when that differs. */
  outcome: z.unknown(),
  links: z.array(linkSchema),
  replays: z.array(traceSummarySchema),
});
export type Trace = z.infer<typeof traceSchema>;

export type NewTrace = Omit<
  Trace,
  "id" | "at" | "links" | "replays" | "threads"
> & {
  at: number;
};

/** How the inspector and the CLI name each kind of call. */
export const TRACE_KIND_TITLE: Record<TraceKind, string> = {
  analysis: "Thread analysis",
  route: "Routing",
  organize: "Organize workstreams",
};

/** Compact labels for narrow columns, such as the Activity log's. */
export const TRACE_KIND_SHORT: Record<TraceKind, string> = {
  analysis: "Analysis",
  route: "Routing",
  organize: "Organize",
};

export const TRACE_STATUS_TITLE: Record<TraceStatus, string> = {
  ok: "Used",
  invalid: "Invalid response",
  failed: "Call failed",
};
