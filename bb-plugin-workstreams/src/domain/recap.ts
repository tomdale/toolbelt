/**
 * The agent's recap: what a thread's agent reports when it ends a turn, shown
 * above the composer and as the thread's work state in the sidebar. Pure, so
 * the server, the app, and tests share one definition.
 */
import { z } from "zod";
import type { ThreadAnalysis } from "./analysis.ts";

export const RECAP_TOOL = "WorkstreamsRecap";

/**
 * How a turn's result stands: complete, or waiting on the user's review.
 * A turn that needs the user's answer ends with a question card instead.
 */
export const RECAP_STATES = ["complete", "review"] as const;
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

/** One review action, optionally with the result the user should see. */
const reviewStepSchema = z.union([
  line(160),
  z
    .object({
      step: line(160).describe("What the user does or inspects"),
      expect: line(160).optional().describe("The result the user should see"),
    })
    .strict(),
]);
export type ReviewStep = string | { step: string; expect?: string };

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
export const recapInputSchema = z
  .object({
    state: z.enum(RECAP_STATES),
    goal: line(80),
    latest: z.array(line(120)).min(1).max(3),
    // A string is one step, or a list some harnesses send JSON-encoded.
    review: z
      .union([
        z.array(reviewStepSchema).min(1).max(3),
        z.string().trim().min(1),
      ])
      .optional()
      .describe(
        "Required for review. Send each distinct action as its own array item; separate items render as a numbered list, while punctuation inside one item does not split it. Use { step, expect } when the expected result should appear separately.",
      ),
    links: z
      .array(linkSchema)
      .max(8)
      .default([])
      .describe(
        "Review state only: optional links to artifacts or pages explicitly being reviewed, as absolute file paths or HTTPS URLs.",
      ),
  })
  .strict()
  .refine((recap) => recap.state === "review" || recap.links.length === 0, {
    message: "Links are review targets and belong only in a review recap.",
    path: ["links"],
  })
  .refine((recap) => recap.state !== "review" || recap.review !== undefined, {
    message:
      "A review recap needs review steps: what to check, and the expected result.",
    path: ["review"],
  })
  .refine(
    (recap) => {
      const steps = reviewSteps(recap.review);
      return (
        steps.length <= 3 &&
        steps.every((step) =>
          typeof step === "string"
            ? visibleLength(step) <= 160
            : visibleLength(step.step) <= 160 &&
              visibleLength(step.expect ?? "") <= 160,
        )
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
  latest: z.array(z.string()),
  /** Review steps; empty unless the state is review. */
  review: z.preprocess(
    (value) =>
      typeof value === "string" ? [value] : value === null ? [] : value,
    z.array(
      z.union([
        z.string(),
        z.object({ step: z.string(), expect: z.string().optional() }),
      ]),
    ),
  ),
  links: z.array(linkSchema),
});
export type Recap = z.infer<typeof recapSchema>;

/** The review as steps, from a list, a single step, or a JSON-encoded list. */
function reviewSteps(review: string | ReviewStep[] | undefined): ReviewStep[] {
  if (review === undefined) return [];
  if (Array.isArray(review)) return review;
  if (review.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(review);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((step) => typeof step === "string" && step.trim())
      )
        return parsed.map((step: string) => step.trim());
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
    latest: input.latest.map(tidy),
    review:
      input.state === "review"
        ? reviewSteps(input.review).map((step) =>
            typeof step === "string"
              ? tidy(step)
              : {
                  step: tidy(step.step),
                  ...(step.expect ? { expect: tidy(step.expect) } : {}),
                },
          )
        : [],
    links:
      input.state === "review"
        ? input.links.map((item) => ({ ...item, title: tidy(item.title) }))
        : [],
  };
}

/**
 * The recap as short Markdown: the tool call's output, which BB shows in the
 * call's timeline row so the recap stays in the thread after the card is
 * gone. The agent reads it back as the call's result.
 */
/** A review step as one Markdown line. */
export function reviewStepText(step: ReviewStep): string {
  if (typeof step === "string") return step;
  return step.expect ? `${step.step} — expect ${step.expect}` : step.step;
}

export function recapMarkdown(recap: Recap): string {
  const state = recap.state === "complete" ? "Complete" : "Ready for review";
  return [
    `**${state}** · ${recap.goal}`,
    ...recap.latest.map((line) => `- ${line}`),
    recap.review.length === 1
      ? `\n**Review:** ${reviewStepText(recap.review[0]!)}`
      : recap.review.length
        ? `\n**Review:**\n${recap.review.map((step) => `- ${reviewStepText(step)}`).join("\n")}`
        : null,
    recap.state === "review" && recap.links.length
      ? `\n${recap.links.map((link) => `[${link.title}](${link.location})`).join(" · ")}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
}

/** The tool's description, as the agent sees it in its tool list. */
export const RECAP_TOOL_DESCRIPTION =
  "Report how this turn ended. The user sees the recap above the composer, and its state in the sidebar. For review, send each distinct action as a separate review item so the card shows a numbered list; use { step, expect } to show an expected result separately. Text fields render inline Markdown, including links and @thread:<id> mentions.";

/**
 * Instructions for every thread that has the recap tool. They state the
 * contract once; the tool's schema carries the limits.
 */
export const RECAP_INSTRUCTIONS = `End every turn with ${RECAP_TOOL}, after completing the work you were authorized to do, unless the turn ends with a question card (AskUserQuestion or your provider's own question tool) still awaiting the user's answer. Ask questions only through such a card, never only in your reply.
state: complete when the user's latest request is fully done; review when a finished result waits on the user to inspect, test, merge, or ship.
Write terse fragments in sentence case without closing periods. Every text field (goal, latest, review step and expect) renders inline Markdown: \`code\`, **emphasis**, [links](https://…), and @thread:<id> mentions, which show as thread chips; length limits count visible text, not link targets. Inline links fit any state; the links field below is a separate list of review targets. goal: the thread's durable purpose as a short -ing phrase ("Porting handoffs into Workstreams"). latest: one to three concrete results of work actually done, about 12 words each, most important first. review (required for review): one to three steps, each saying how to inspect or try the requested result and what to expect, about 20 words each. Send each distinct action as its own array item; separate items render as a numbered list, while punctuation inside one item does not split it. A step may be a string or { step, expect }. For UI review, give steps to reach and exercise the UI.
links: optional, only in the review state and only for artifacts or pages explicitly being asked to be reviewed, as absolute file paths or HTTPS URLs. A changed source file qualifies only when source review is requested. For complete, omit links or send an empty list.
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
    recap: plainText(recap.latest[0] ?? recap.goal),
    state: recap.state === "complete" ? "done" : "review",
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
