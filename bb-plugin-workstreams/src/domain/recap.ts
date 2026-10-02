/**
 * The agent's recap: what a thread's agent reports when it ends a turn, shown
 * above the composer and as the thread's work state in the sidebar. Pure, so
 * the server, the app, and tests share one definition.
 */
import { z } from "zod";
import type { ThreadAnalysis } from "./analysis.ts";

export const RECAP_TOOL = "WorkstreamsRecap";

/**
 * How a turn's result stands: complete, awaiting review, or waiting on async tasks.
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
const recapItemSchema = (max: number) =>
  z.union([
    line(max),
    z
      .object({
        step: line(max).describe("The item's primary text"),
        expect: line(max)
          .optional()
          .describe("Optional secondary text shown on a subrow"),
      })
      .strict(),
  ]);
export type RecapItem = string | { step: string; expect?: string };
const storedRecapItemSchema = z.union([
  z.string(),
  z.object({ step: z.string(), expect: z.string().optional() }).strict(),
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
      title: line(28).describe("Short, title-case button label"),
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

/**
 * The tool's parameters. The limits keep each line glanceable: a goal
 * heading, short results, acceptance checks, and optional review targets.
 */
const recapFields = z
  .object({
    state: z.enum(RECAP_STATES),
    goal: line(80),
    latest: z
      .array(recapItemSchema(120))
      .max(3)
      .default([])
      .describe(
        "Completed results for complete and review. Items can be strings or { step, expect } objects with optional secondary text.",
      ),
    tasks: z
      .array(recapItemSchema(120))
      .max(3)
      .nullable()
      .optional()
      .describe(
        "Waiting only: one to three async tasks the agent is waiting on",
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
        "Required for review. Send each distinct action as its own array item; separate items render as a numbered list. Items can be strings or { step, expect } objects with optional secondary text.",
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
        "Complete and review only: one to three next actions the user might take or questions they may ask, shown as buttons under the recap. Use { title, message, description? } for a short title-case title of 2-4 words (at most 28 characters), the full message sent verbatim, and an optional short description shown on hover or in the action menu. Strings remain supported as both title and message.",
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
      tasks: z.array(z.never()).max(0).nullable().optional(),
      timeout: z.null().optional(),
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
      tasks: z.array(z.never()).max(0).nullable().optional(),
      timeout: z.null().optional(),
      latest: recapFields.shape.latest.removeDefault().min(1),
      review: z.union([
        z.array(reviewStepSchema).min(1).max(3),
        z.string().trim().min(1),
      ]),
    }),
    recapFields.extend({
      state: z.literal("waiting"),
      tasks: z.array(recapItemSchema(120)).min(1).max(3),
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
export const recapSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  at: z.number(),
  state: z.enum(RECAP_STATES),
  goal: z.string(),
  latest: z.array(storedRecapItemSchema).default([]),
  tasks: z.array(storedRecapItemSchema).optional(),
  timeout: z.number().optional(),
  /** Review steps; empty unless the state is review. */
  review: z.preprocess(
    (value) => storedRecapItems(value),
    z.array(storedRecapItemSchema),
  ),
  links: z.array(linkSchema),
  /** Suggested next messages, offered as buttons; empty while waiting. */
  next: z.array(nextActionSchema).default([]),
});
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
  return typeof item === "string"
    ? visibleLength(item) <= max
    : visibleLength(item.step) <= max &&
        visibleLength(item.expect ?? "") <= max;
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
    tasks: input.state === "waiting" ? input.tasks.map(tidyRecapItem) : [],
    ...(input.state === "waiting" ? { timeout: input.timeout } : {}),
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
  return item.expect ? `${item.step}\n  - ${item.expect}` : item.step;
}

/** A review step as readable Markdown. */
export const reviewStepText = recapItemText;

function tidyRecapItem(item: RecapItem): RecapItem {
  if (typeof item === "string") return tidy(item);
  return {
    step: tidy(item.step),
    ...(item.expect ? { expect: tidy(item.expect) } : {}),
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
    ...(recap.tasks ?? []).map((item) => `- ${recapItemText(item)}`),
    ...(recap.state === "waiting"
      ? [`Check status in ${recap.timeout}s`]
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
  "Report how this turn ended. The user sees the recap above the composer, and its state in the sidebar. Lists accept strings or { step, expect } items. The optional expect appears as a subrow. Text fields render inline Markdown, including links and @thread:<id> mentions. For complete and review, the optional next lists 1-3 suggested messages. Use { title, message, description? } for a short 2-4 word Title Case button label (at most 28 characters), the exact message to send, and an optional short description shown on hover or in the action menu; strings remain supported.";

/**
 * Instructions for every thread that has the recap tool. They state the
 * contract once; the tool's schema carries the limits.
 */
export const RECAP_INSTRUCTIONS = `End every turn with ${RECAP_TOOL}, after completing the work you were authorized to do, unless the turn ends with a question card (AskUserQuestion or your provider's own question tool) still awaiting the user's answer. Ask questions only through such a card, never only in your reply.
state: complete when the user's latest request is fully done; review when a finished result waits on the user to inspect, test, merge, or ship; waiting when async tasks are running and the agent is waiting for their results. Keep working while there is authorized work you can do, or use a question card when required user input blocks progress.
Write terse fragments in sentence case without closing periods. Every text field (goal, latest, tasks, review step and expect) renders inline Markdown: \`code\`, **emphasis**, [links](https://…), and @thread:<id> mentions, which show as thread chips. A lowercase commit hash, bare or alone in backticks (not in links), shows shortened and highlighted with copy on click. Length limits count visible text, not link targets. Inline links fit any state. The links field is a separate list of review targets. goal: the thread's purpose as a short phrase, past tense for complete and review ("Added dark mode to Settings") and -ing for waiting ("Waiting for Settings tests"). latest: one to three concrete results for complete and review, about 12 words each, most important first. review (required for review): one to three steps saying how to inspect or try the result and what to expect. Every item list accepts strings or { step, expect } objects. Use expect for optional secondary text shown on its own subrow. Keep each item distinct. Use separate items rather than joining results with semicolons. For UI review, give steps to reach and exercise the UI.
For waiting: tasks (required) names one to three async tasks whose results you need; timeout (required) is the number of seconds until you should check their status, from 1 to 86400. Choose a realistic polling interval. The card counts down and automatically prompts you to check status if the same turn is still current when the timeout expires. Omit latest, review, and links.
links: optional, only in the review state and only for artifacts or pages explicitly being asked to be reviewed, as absolute file paths or HTTPS URLs. A changed source file qualifies only when source review is requested. For complete, omit links or send an empty list.
next: for complete and review, one to three messages the user might send next — a follow-up action or a question to you. Prefer an object with title (a short, 2–4 word Title Case button label, at most 28 characters), message (the exact self-contained plain-text message sent verbatim as the user's next message, at most 120 characters), and optional description (a short explanation shown on hover or in the action menu, at most 120 characters). Make the title concise; put details in description and the actual request in message. Strings remain supported as both title and message for simple actions. Omit closing periods. Do not restate choices elsewhere in the recap or offer work you should do yourself. Omit next while waiting.
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
    recap: plainText(
      recapItemText(recap.tasks?.[0] ?? recap.latest[0] ?? recap.goal),
    ),
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
