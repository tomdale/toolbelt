/**
 * The agent's recap: what a thread's agent reports when it ends a turn, shown
 * above the composer and as the thread's work state in the sidebar. Pure, so
 * the server, the app, and tests share one definition.
 */
import { z } from "zod";
import type { ThreadAnalysis } from "./analysis.ts";

export const RECAP_TOOL = "WorkstreamsRecap";

/**
 * How a turn's result stands: complete, awaiting review, or waiting on an async task.
 * A turn that needs the user's answer ends with a question card instead.
 */
export const RECAP_STATES = ["complete", "review", "waiting"] as const;
export type RecapState = (typeof RECAP_STATES)[number];

/**
 * Recap lines are inline Markdown: `code`, emphasis, [links](url), and
 * `@thread:<id>` mentions, which BB renders as thread chips. Newlines are
 * collapsed, so block syntax never applies.
 *
 * The line as a reader sees it, without Markdown syntax or link
 * destinations, for limits and for surfaces that show plain text.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Visible length, with a mention counted as the short chip it renders as. */
const visibleLength = (markdown: string) =>
  plainText(markdown).replace(/@(thread|project|section):[\w-]+/g, "@chip")
    .length;

// Tool parameters avoid transforms so BB can describe them as JSON Schema.
// `max` bounds the visible text; the raw cap leaves room for link targets.
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max * 4 + 2048)
    .refine((text) => visibleLength(text) <= max, {
      message: `Keep the visible text to ${max} characters or fewer.`,
    });
/** One line without the closing period models add despite instructions. */
const tidy = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?<!\.)\.$/, "");

/** One recap list item, optionally with a secondary subrow. */
const genericRecapItem = (max: number) =>
  z
    .object({
      text: line(max).describe("The item's primary text"),
      detail: line(max)
        .optional()
        .describe("Optional secondary text shown on a subrow"),
    })
    .strict();

const legacyRecapItem = (max: number) =>
  z
    .object({
      step: line(max).describe("Legacy alias for text"),
      expect: line(max).optional().describe("Legacy alias for detail"),
    })
    .strict();

const recapItemSchema = (max: number) =>
  z.union([line(max), genericRecapItem(max), legacyRecapItem(max)]);

export type RecapItem =
  | string
  | { text: string; detail?: string }
  | { step: string; expect?: string };

export type StoredRecapItem = string | { text: string; detail?: string };

export function itemParts(item: RecapItem): { text: string; detail?: string } {
  if (typeof item === "string") return { text: item };
  if ("text" in item) {
    return {
      text: item.text,
      ...(item.detail !== undefined ? { detail: item.detail } : {}),
    };
  }
  return {
    text: item.step,
    ...(item.expect !== undefined ? { detail: item.expect } : {}),
  };
}

const storedRecapItemSchema: z.ZodType<StoredRecapItem> = z.union([
  z.string(),
  z.object({ text: z.string(), detail: z.string().optional() }).strict(),
  z
    .object({ step: z.string(), expect: z.string().optional() })
    .strict()
    .transform((item): { text: string; detail?: string } => ({
      text: item.step,
      ...(item.expect ? { detail: item.expect } : {}),
    })),
]);
/** One review action, optionally with the result the user should see. */
const reviewStepSchema = recapItemSchema(160);
export type ReviewStep = RecapItem;

/** A suggested action can separate its short button title from its message. */
const nextActionSchema = z.union([
  z
    .string()
    .trim()
    .min(1)
    .max(120 * 4 + 2048)
    .refine((text) => visibleLength(text) <= 120, {
      message: "Keep the visible text to 120 characters or fewer.",
    }),
  z
    .object({
      title: line(28).describe(
        "Short sentence-case button label, at most 28 characters",
      ),
      message: line(120).describe(
        "The exact plain-text message sent when clicked",
      ),
      description: line(120)
        .optional()
        .describe(
          "Optional short explanation shown on hover or in the action menu",
        ),
    })
    .strict(),
]);
export type NextAction = z.infer<typeof nextActionSchema>;
export type NextActionInput = z.input<typeof nextActionSchema>;

export const linkSchema = z
  .object({
    title: line(80),
    location: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine((value) => {
        if (value.startsWith("https://")) {
          try {
            return new URL(value).protocol === "https:";
          } catch {
            return false;
          }
        }
        return (
          value.startsWith("/") &&
          !value.startsWith("//") &&
          !/[\r\n\u0000]/.test(value)
        );
      }, "Use an absolute file path or an HTTPS URL."),
  })
  .strict();
export type RecapLink = z.infer<typeof linkSchema>;

const waitingAgentSchema = z
  .object({
    threadId: z.string().trim().min(1).max(200),
    task: line(80),
  })
  .strict();
export type WaitingAgent = z.infer<typeof waitingAgentSchema>;

/**
 * The tool's parameters. The limits keep each line glanceable: a goal
 * heading, short results, acceptance checks, and optional review targets.
 */
const recapFields = z
  .object({
    state: z.enum(RECAP_STATES),
    goal: line(80),
    waitingAgents: z
      .array(waitingAgentSchema)
      .max(8)
      .optional()
      .describe(
        "Waiting only: agents this thread is waiting for, each with a short task and thread ID so the card can link to that agent thread.",
      ),
    latest: z
      .array(recapItemSchema(120))
      .max(3)
      .default([])
      .describe(
        "Completed results for complete and review. Items can be strings or { text, detail } objects with optional secondary text.",
      ),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(86400)
      .nullable()
      .optional()
      .describe(
        "Waiting only: seconds until the agent should check task status, from 1 to 86400",
      ),
    // A string is one step, or a list some harnesses send JSON-encoded.
    review: z
      .union([z.array(reviewStepSchema).max(3), z.string().trim()])
      .nullable()
      .optional()
      .describe(
        "Required for review. Send each distinct action as its own array item; separate items render as a numbered list. Items can be strings or { text, detail } objects with optional secondary text.",
      ),
    links: z
      .array(linkSchema)
      .max(8)
      .default([])
      .describe(
        "Review state only: optional links to artifacts or pages explicitly being reviewed, as absolute file paths or HTTPS URLs.",
      ),
    next: z
      .array(nextActionSchema)
      .max(3)
      .default([])
      .describe(
        "Complete and review only: one to three next actions the user might take or questions they may ask, shown as buttons under the recap. Use { title, message, description? }: title is a short sentence-case button label of at most 28 characters, message is sent verbatim, and optional description holds longer context shown on hover and in the action menu. Keep button labels very short. Strings remain supported as the same short label and sent message.",
      ),
  })
  .strict();

/**
 * The fields advertised to agents. Keep the root a concrete object: provider
 * bridges can flatten a root union into a tool with no named parameters.
 * State-specific requirements are enforced by recapInputSchema at execution.
 */
export const recapToolSchema = recapFields;

/** The state-specific contract checked before accepting a recap. */
export const recapInputSchema = z
  .discriminatedUnion("state", [
    recapFields.extend({
      state: z.literal("complete"),
      timeout: z.null().optional(),
      waitingAgents: z.array(z.never()).max(0).default([]),
      review: z
        .union([z.array(z.never()).max(0), z.literal("")])
        .nullable()
        .optional(),
      latest: recapFields.shape.latest.removeDefault().min(1),
      links: z
        .array(linkSchema)
        .max(0, "Links are review targets and belong only in a review recap.")
        .default([]),
    }),
    recapFields.extend({
      state: z.literal("review"),
      timeout: z.null().optional(),
      waitingAgents: z.array(z.never()).max(0).default([]),
      latest: recapFields.shape.latest.removeDefault().min(1),
      review: z.union([
        z.array(reviewStepSchema).min(1).max(3),
        z.string().trim().min(1),
      ]),
    }),
    recapFields.extend({
      state: z.literal("waiting"),
      timeout: z.number().int().min(1).max(86400),
      latest: z.array(z.never()).max(0).default([]),
      next: z.array(z.never()).max(0).default([]),
      review: z
        .union([z.array(z.never()).max(0), z.literal("")])
        .nullable()
        .optional(),
      links: z
        .array(linkSchema)
        .max(0, "Links are review targets and belong only in a review recap.")
        .default([]),
    }),
  ])
  .refine(
    (recap) => {
      const steps = reviewSteps(
        recap.state === "review" ? recap.review : undefined,
      );
      return (
        steps.length <= 3 && steps.every((step) => recapItemWithin(step, 160))
      );
    },
    {
      message: "Review takes one to three steps of 160 characters or fewer.",
      path: ["review"],
    },
  );
export type RecapInput = z.infer<typeof recapInputSchema>;

/** A stored recap, tied to the turn that reported it. */
export const recapSchema = z
  .object({
    id: z.string(),
    turnId: z.string(),
    at: z.number(),
    state: z.enum(RECAP_STATES),
    goal: z.string(),
    /** Legacy Waiting label saved before Waiting reused goal. */
    task: z.string().optional(),
    waitingAgents: z.array(waitingAgentSchema).optional(),
    latest: z.array(storedRecapItemSchema).default([]),
    timeout: z.number().optional(),
    /** Review steps; empty unless the state is review. */
    review: z.preprocess(
      (value) => storedRecapItems(value),
      z.array(storedRecapItemSchema),
    ),
    links: z.array(linkSchema),
    /** Suggested next messages, offered as buttons; empty while waiting. */
    next: z.array(nextActionSchema).default([]),
  })
  .transform(({ task, waitingAgents, ...recap }) => ({
    ...recap,
    // Stored Waiting recaps may still carry the former separate task field.
    ...(typeof task === "string" ? { goal: task } : {}),
    ...(waitingAgents ? { waitingAgents } : {}),
  }));
export type Recap = z.infer<typeof recapSchema>;

function storedRecapItems(value: unknown): unknown {
  if (value === null || value === undefined) return [];
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Stored plain strings remain one-item lists.
  }
  return [value];
}

/** The review as steps, from a list, a single step, or a JSON-encoded list. */
function recapItemWithin(item: RecapItem, max: number): boolean {
  if (typeof item === "string") return visibleLength(item) <= max;
  const { text, detail } = itemParts(item);
  return visibleLength(text) <= max && visibleLength(detail ?? "") <= max;
}

function reviewSteps(review: string | ReviewStep[] | undefined): ReviewStep[] {
  if (review === undefined) return [];
  if (Array.isArray(review)) return review;
  if (review.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(review);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((step) => recapItemSchema(160).safeParse(step).success)
      )
        return parsed.map((step) =>
          typeof step === "string" ? step.trim() : step,
        ) as ReviewStep[];
    } catch {
      // Not JSON: a step that happens to start with a bracket.
    }
  }
  return [review];
}

export function toRecap(
  input: RecapInput,
  meta: { id: string; turnId: string; at: number },
): Recap {
  return {
    ...meta,
    state: input.state,
    goal: tidy(input.goal),
    latest: input.latest.map(tidyRecapItem),
    ...(input.state === "waiting"
      ? {
          timeout: input.timeout,
          waitingAgents: (input.waitingAgents ?? []).map((agent) => ({
            threadId: agent.threadId,
            task: tidy(agent.task),
          })),
        }
      : { waitingAgents: [] }),
    review:
      input.state === "review"
        ? reviewSteps(input.review).map(tidyRecapItem)
        : [],
    links:
      input.state === "review"
        ? input.links.map((item) => ({ ...item, title: tidy(item.title) }))
        : [],
    next:
      input.state === "waiting"
        ? []
        : input.next.map((action) =>
            typeof action === "string"
              ? tidy(action)
              : {
                  title: tidy(action.title),
                  message: tidy(action.message),
                  ...(action.description
                    ? { description: tidy(action.description) }
                    : {}),
                },
          ),
  };
}

/**
 * The recap as short Markdown: the tool call's output, which BB shows in the
 * call's timeline row so the recap stays in the thread after the card is
 * gone. The agent reads it back as the call's result.
 */
/** A recap item with optional secondary text on its own Markdown row. */
export function recapItemText(item: RecapItem): string {
  if (typeof item === "string") return item;
  const { text, detail } = itemParts(item);
  return detail ? `${text}\n  - ${detail}` : text;
}

/** A review step as readable Markdown. */
export const reviewStepText = recapItemText;

function tidyRecapItem(item: RecapItem): StoredRecapItem {
  if (typeof item === "string") return tidy(item);
  const { text, detail } = itemParts(item);
  return {
    text: tidy(text),
    ...(detail ? { detail: tidy(detail) } : {}),
  };
}

export function recapMarkdown(recap: Recap): string {
  const state =
    recap.state === "complete"
      ? "Complete"
      : recap.state === "waiting"
        ? "Waiting"
        : "Ready for review";
  return [
    `**${state}** · ${recap.goal}`,
    ...(recap.state === "waiting"
      ? [
          ...(recap.waitingAgents ?? []).map(
            (agent) => `- ${agent.task} · @thread:${agent.threadId}`,
          ),
          `Check status in ${recap.timeout}s`,
        ]
      : recap.latest.map((item) => `- ${recapItemText(item)}`)),
    recap.review.length === 1
      ? `\n**Review:** ${reviewStepText(recap.review[0]!)}`
      : recap.review.length
        ? `\n**Review:**\n${recap.review.map((step) => `- ${reviewStepText(step)}`).join("\n")}`
        : null,
    recap.state === "review" && recap.links.length
      ? `\n${recap.links.map((link) => `[${link.title}](${link.location})`).join(" · ")}`
      : null,
    recap.next.length
      ? `\n**Next:**\n${recap.next
          .map((action) =>
            typeof action === "string"
              ? `- ${action}`
              : `- ${action.title}: ${action.message}${action.description ? ` (${action.description})` : ""}`,
          )
          .join("\n")}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
}

/** The tool's description, as the agent sees it in its tool list. */
export const RECAP_TOOL_DESCRIPTION =
  "Report the actual end of this turn; the recap drives the thread's visible state and may make it look finished. Use complete only when the user's latest request and the broader task they asked to do are fully done—not merely because you answered one step, gave examples, or reached a natural pause. If the user wants to work through options or examples together, keep collaborating; if their choice or other required input is needed to continue, ask with the question-card tool and end the turn without calling this recap tool. Do not use complete or next as a substitute for that question. Use review only for finished work awaiting inspection, testing, merging, or shipping; use waiting only while an async task is running and you need to check its result. The user sees the recap above the composer and its state in the sidebar. Lists accept strings or { text, detail } items; optional detail appears as a subrow. Text fields render inline Markdown, including links and @thread:<id> mentions. For waiting, use goal as the task description and provide a timeout; goal is the card title, and the card counts down to the status check. When waiting on agents, include waitingAgents with one { threadId, task } entry per agent; the card lists each task under the goal with a link to its agent thread and the agent's live status. For complete and review, next accepts 1-3 optional follow-up messages only after the current request is finished. Prefer { title, message, description? }: title is a short sentence-case button label (at most 28 characters), message is sent verbatim, and optional description holds longer context shown on hover or in the action menu. Keep titles very short; strings remain supported as the same short title and message.";

/**
 * Instructions for every thread that has the recap tool. They state the
 * contract once; the tool's schema carries the limits.
 */
export const RECAP_INSTRUCTIONS = `End every turn with ${RECAP_TOOL}, after completing the work you were authorized to do, unless the turn ends with a question card (AskUserQuestion or your provider's own question tool) still awaiting the user's answer. Ask questions only through such a card, never only in your reply.
Before a complete or review recap, check the current task for concrete blockers and obvious continuations. Include one to three relevant next actions whenever the user can take or request one; \`next\` may be empty only when there is no useful follow-up. If progress requires the user's answer or approval, ask with the question-card tool and end without a recap.
state: complete when the user's latest request is fully done; review when a finished result waits on the user to inspect, test, merge, or ship; waiting when an async task is running and the agent is waiting for its result. Keep working while there is authorized work you can do, or use a question card when required user input blocks progress.
Write terse fragments in sentence case without closing periods. Every text field (goal, latest, review, and detail) renders inline Markdown: \`code\`, **emphasis**, [links](https://…), and @thread:<id> mentions, which show as thread chips. A lowercase commit hash, bare or alone in backticks (not in links), shows shortened and highlighted with copy on click. Length limits count visible text, not link targets. Inline links fit any state. The links field is a separate list of review targets. goal: the thread's purpose as a short phrase, past tense for complete and review ("Added dark mode to Settings") and -ing for waiting ("Waiting for Settings tests"). latest: one to three concrete results for complete and review, about 12 words each, most important first. review (required for review): one to three steps saying how to inspect or try the result and what to expect. Every item list accepts strings or { text, detail } objects. Use detail for optional secondary text shown on its own subrow. Keep each item distinct. Use separate items rather than joining results with semicolons. For UI review, give steps to reach and exercise the UI.
For waiting: goal (required) is a short description of the async task whose result you need; timeout (required) is the number of seconds until you should check its status, from 1 to 86400. Choose a realistic polling interval. Goal is the card title, and the card shows a countdown to the status check. When waiting on agents, include waitingAgents with one { threadId, task } entry per agent so the card can list each task under the goal with a link to its agent thread and the agent's live status; otherwise omit it. With several agents, goal names the shared outcome and each task names one agent's part. The state label names the number of awaited agents. The card counts down and automatically prompts you to check status if the same turn is still current when the timeout expires. Omit latest, review, and links.
links: optional, only in the review state and only for artifacts or pages explicitly being asked to be reviewed, as absolute file paths or HTTPS URLs. A changed source file qualifies only when source review is requested. For complete, omit links or send an empty list.
For complete and review, \`next\` holds messages the user might send — a follow-up action or question. Prefer { title, message, description? }. Keep title a very short sentence-case button label, at most 28 characters (ideally 2–4 words); validation enforces the limit. Put the exact self-contained plain-text request (at most 120 characters) in message; it is sent verbatim. Use optional description (at most 120 characters) for longer context or why the choice may be useful; it appears on hover and in the action menu. Do not cram the message into the title. Strings remain supported for simple actions and are shown as the full label. Omit closing periods. Do not restate choices elsewhere or offer work you should do yourself. Omit next while waiting.
The user decides whether to archive the thread from the recap. When a question card is dismissed or expires, treat the question as unanswered and unapproved, and continue only work that does not depend on it.`;

/**
 * A thread's work as its agent reported it, in analysis's shape: the recap's
 * state and first result over `base`, a current analysis that still supplies
 * subject and drift. The agent's report outranks analysis for the turn it
 * describes.
 */
export function reportedAnalysis(
  recap: Recap,
  thread: { latestAttentionAt: number },
  base?: ThreadAnalysis & { driftSectionId: string | null },
): ThreadAnalysis & { driftSectionId: string | null; traceId: string | null } {
  return {
    subject: null,
    title: null,
    drift: null,
    driftSectionId: null,
    model: "agent",
    traceId: null,
    ...base,
    recap: plainText(recapItemText(recap.latest[0] ?? recap.goal)),
    state:
      recap.state === "complete"
        ? "done"
        : recap.state === "waiting"
          ? "in_progress"
          : "review",
    needsYou: null,
    revision: thread.latestAttentionAt,
    at: recap.at,
  };
}

/** Where the thread's files live, for resolving a recap's file links. */
export type RecapFiles = {
  environmentId: string;
  /** The environment's directory on its host. */
  root: string | null;
  hostId: string | null;
};

/**
 * BB's file target for a recap link's absolute path: the thread's workspace
 * when the path is inside it, else the environment's host. Null when neither
 * is known, so the link shows as plain text.
 */
export function fileTarget(
  path: string,
  files: RecapFiles | null,
):
  | { kind: "workspace"; environmentId: string; path: string }
  | { kind: "host"; hostId: string; path: string }
  | null {
  if (!files) return null;
  const root = files.root?.replace(/\/+$/, "");
  if (root && (path === root || path.startsWith(`${root}/`)))
    return { kind: "workspace", environmentId: files.environmentId, path };
  return files.hostId ? { kind: "host", hostId: files.hostId, path } : null;
}

/** A piece of a recap line: Markdown, or a token the card renders itself. */
export type RecapSegment =
  | { kind: "markdown"; text: string }
  | { kind: "thread"; threadId: string }
  | { kind: "sha"; sha: string };

/**
 * `@thread:<id>` mentions, and commit hashes: 7–40 hex digits with at least
 * one digit and one letter, so plain numbers and hex-looking words stay text.
 */
const TOKEN =
  /@thread:([A-Za-z0-9_-]+)|(?<![\w/#.-])(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])([0-9a-f]{7,40})(?![\w/-])/g;

/**
 * Splits a recap line around thread mentions and commit hashes, which BB's
 * Markdown renders as plain text. A code span holding only a hash counts as
 * a hash; other code spans and link syntax stay whole for Markdown.
 */
export function recapSegments(text: string): RecapSegment[] {
  const segments: RecapSegment[] = [];
  let markdown = "";
  const protectedSpan =
    /`[^`]*`|\[[^\]]*\]\([^)]*\)|<https?:\/\/[^>\s]+>|https?:\/\/\S+/g;
  let last = 0;
  const scan = (chunk: string) => {
    let at = 0;
    for (const match of chunk.matchAll(TOKEN)) {
      markdown += chunk.slice(at, match.index);
      if (markdown) segments.push({ kind: "markdown", text: markdown });
      markdown = "";
      segments.push(
        match[1]
          ? { kind: "thread", threadId: match[1] }
          : { kind: "sha", sha: match[2]! },
      );
      at = match.index + match[0].length;
    }
    markdown += chunk.slice(at);
  };
  for (const span of text.matchAll(protectedSpan)) {
    scan(text.slice(last, span.index));
    const sha = /^`\s*([0-9a-f]{7,40})\s*`$/.exec(span[0])?.[1];
    if (sha && /[0-9]/.test(sha) && /[a-f]/.test(sha)) {
      if (markdown) segments.push({ kind: "markdown", text: markdown });
      markdown = "";
      segments.push({ kind: "sha", sha });
    } else markdown += span[0];
    last = span.index + span[0].length;
  }
  scan(text.slice(last));
  if (markdown) segments.push({ kind: "markdown", text: markdown });
  return segments;
}
