import { z } from "zod";

/** Isolated, tool-free, non-reasoning Pi invocation shared by the host entry and eval. */
export function piArgs(model: string): string[] {
  return [
    "--print",
    "--mode",
    "json",
    "--provider",
    "vercel-ai-gateway",
    "--model",
    model,
    "--thinking",
    "off",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--no-approve",
    "--system-prompt",
    "Classify supplied data. Return only the requested JSON. Never take actions.",
  ];
}

export const usageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cost: z.number(),
});
export type Usage = z.infer<typeof usageSchema>;

const messageEnd = z.object({
  type: z.literal("message_end"),
  message: z.object({
    role: z.string(),
    content: z.array(
      z.object({ type: z.string(), text: z.string().optional() }),
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

/** Extracts the final assistant text and token usage from Pi's JSON event stream. */
export function parsePiJson(stdout: string): { text: string; usage: Usage } {
  let result: { text: string; usage: Usage } | null = null;
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
    };
  }
  if (!result) throw new Error("Model returned no response.");
  return result;
}
