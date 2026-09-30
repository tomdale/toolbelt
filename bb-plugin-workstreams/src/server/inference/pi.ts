/**
 * Isolated, tool-free Pi invocation shared by the host entry and the eval
 * runner. Pi runs with no tools, extensions, skills, context files, or session,
 * so a prompt built from thread content can only produce text.
 */
import { z } from "zod";
import type { Usage } from "../../domain/trace.ts";

export const SYSTEM_PROMPT =
  "Classify supplied data. Return only the requested JSON. Never take actions.";
export const PROVIDER = "vercel-ai-gateway";
/**
 * Pi's thinking level for every call. Some models (Gemini 3.1 Flash-Lite)
 * still return a reasoning summary at this level; debug traces keep it.
 */
export const THINKING = "off";

export function piArgs(model: string): string[] {
  return [
    "--print",
    "--mode",
    "json",
    "--provider",
    PROVIDER,
    "--model",
    model,
    "--thinking",
    THINKING,
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--no-approve",
    "--system-prompt",
    SYSTEM_PROMPT,
  ];
}

export { usageSchema, type Usage } from "../../domain/trace.ts";

const messageEnd = z.object({
  type: z.literal("message_end"),
  message: z.object({
    role: z.string(),
    content: z.array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        thinking: z.string().optional(),
      }),
    ),
    usage: z
      .object({
        input: z.number(),
        output: z.number(),
        cost: z.object({ total: z.number() }).optional(),
      })
      .optional(),
    stopReason: z.string().optional(),
  }),
});

export type PiCompletion = {
  text: string;
  usage: Usage;
  /** The model's reasoning summary, when it returned one. */
  reasoning: string | null;
  stopReason: string | null;
};

/** Final assistant text, reasoning, and token usage from Pi's JSON event stream. */
export function parsePiJson(stdout: string): PiCompletion {
  let result: PiCompletion | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = messageEnd.safeParse(event);
    if (!parsed.success || parsed.data.message.role !== "assistant") continue;
    const { content, usage, stopReason } = parsed.data.message;
    if (stopReason === "error") throw new Error("Model request failed.");
    const reasoning = content
      .filter((c) => c.type === "thinking")
      .map((c) => c.thinking ?? "")
      .join("\n\n")
      .trim();
    result = {
      text: content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("")
        .trim(),
      usage: {
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        cost: usage?.cost?.total ?? 0,
      },
      // Bounded under the host contract's limit so long thinking never
      // fails the call.
      reasoning: reasoning ? reasoning.slice(0, 100_000) : null,
      stopReason: stopReason ?? null,
    };
  }
  if (!result) throw new Error("Model returned no response.");
  return result;
}
