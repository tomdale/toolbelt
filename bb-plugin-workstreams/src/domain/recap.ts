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

// Tool parameters avoid transforms so BB can describe them as JSON Schema.
const line = (max: number) => z.string().trim().min(1).max(max);
/** One line without the closing period models add despite instructions. */
const tidy = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?<!\.)\.$/, "");

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
 * heading, short results, one acceptance check, and links to what was made.
 */
export const recapInputSchema = z
  .object({
    state: z.enum(RECAP_STATES),
    goal: line(80),
    latest: z.array(line(120)).min(1).max(3),
    review: line(160).optional(),
    links: z.array(linkSchema).max(8).default([]),
  })
  .strict()
  .refine((recap) => recap.state !== "review" || recap.review !== undefined, {
    message:
      "A review recap needs a review line: what to check, and the expected result.",
    path: ["review"],
  });
export type RecapInput = z.infer<typeof recapInputSchema>;

/** A stored recap, tied to the turn that reported it. */
export const recapSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  at: z.number(),
  state: z.enum(RECAP_STATES),
  goal: z.string(),
  latest: z.array(z.string()),
  review: z.string().nullable(),
  links: z.array(linkSchema),
});
export type Recap = z.infer<typeof recapSchema>;

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
      input.state === "review" && input.review ? tidy(input.review) : null,
    links: input.links.map((item) => ({
      ...item,
      title: tidy(item.title),
    })),
  };
}

/**
 * The recap as short Markdown: the tool call's output, which BB shows in the
 * call's timeline row so the recap stays in the thread after the card is
 * gone. The agent reads it back as the call's result.
 */
export function recapMarkdown(recap: Recap): string {
  const state = recap.state === "complete" ? "Complete" : "Ready for review";
  return [
    `**${state}** · ${recap.goal}`,
    ...recap.latest.map((line) => `- ${line}`),
    recap.review ? `\n**Review:** ${recap.review}` : null,
    recap.links.length
      ? `\n${recap.links.map((link) => `[${link.title}](${link.location})`).join(" · ")}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
}

/** The tool's description, as the agent sees it in its tool list. */
export const RECAP_TOOL_DESCRIPTION =
  "Report how this turn ended. The user sees the recap above the composer, and its state in the sidebar.";

/**
 * Instructions for every thread that has the recap tool. They state the
 * contract once; the tool's schema carries the limits.
 */
export const RECAP_INSTRUCTIONS = `End every turn with ${RECAP_TOOL}, after completing the work you were authorized to do, unless the turn ends with a question card (AskUserQuestion or your provider's own question tool) still awaiting the user's answer. Ask questions only through such a card, never only in your reply.
state: complete when the user's latest request is fully done; review when a finished result waits on the user to inspect, test, merge, or ship.
Write terse fragments in sentence case without closing periods. goal: the thread's durable purpose as a short -ing phrase ("Porting handoffs into Workstreams"). latest: one to three concrete results of work actually done, about 12 words each, most important first. review (required for review): what to inspect or try and the result to expect, about 20 words. links: files or pages you actually made or changed that the user will open, as absolute file paths or HTTPS URLs.
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
    recap: recap.latest[0] ?? recap.goal,
    state: recap.state === "complete" ? "done" : "review",
    needsYou: null,
    revision: thread.latestAttentionAt,
    at: recap.at,
  };
}
