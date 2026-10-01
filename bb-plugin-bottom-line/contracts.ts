import { z } from "zod";

export const QUESTIONS_RENDERER = "bottom-line-questions";
export const TOOLS = ["BottomLineAskQuestions", "BottomLineDeliver", "BottomLineFinish"] as const;
const text = z.string().trim().min(1).max(4000);
export const deliverableSchema = z.object({
  title: z.string().trim().min(1).max(200),
  location: z.string().trim().min(1).max(2048).refine((value) => {
    if (/^https:\/\//.test(value)) {
      try { return new URL(value).protocol === "https:"; } catch { return false; }
    }
    return value.startsWith("/") && !value.startsWith("//") && !/[\r\n\u0000]/.test(value);
  }, "Use an absolute file path or an HTTPS URL."),
  description: z.string().trim().max(1000).optional(),
}).strict();
export const deliverSchema = z.object({
  summary: text,
  deliverables: z.array(deliverableSchema).min(1).max(20),
}).strict();
export const finishSchema = z.object({
  summary: text,
  deliverables: z.array(deliverableSchema).max(20).default([]),
}).strict();
export const questionsSchema = z.object({
  questions: z.array(z.object({
    question: z.string().trim().min(1).max(1000),
    options: z.array(z.object({
      label: z.string().trim().min(1).max(200),
      description: z.string().trim().max(1000),
    }).strict()).max(4),
  }).strict()).min(1).max(4),
}).strict();
export const answersSchema = z.object({ answers: z.array(z.string().trim().min(1).max(4000)).min(1).max(4) }).strict();
export const cardSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  kind: z.enum(["deliverables", "finished"]),
  summary: text,
  deliverables: z.array(deliverableSchema).max(20),
}).strict();
export type Card = z.infer<typeof cardSchema>;

export const INSTRUCTIONS = `End each turn by calling a Bottom Line tool: BottomLineAskQuestions for concrete questions or proposed next steps requiring user input; BottomLineDeliver for one or more deliverables the user requested; BottomLineFinish when the overall task is finished, with a concise summary and any requested deliverables. AskUserQuestion or a provider's native question card also satisfies the questions path. Finish authorized work before handing control back. Use questions when useful input remains; use the finished path when work is complete. A deliverable identifies an existing artifact requested by the user, with an absolute file path or HTTPS URL. BottomLineFinish shows your summary with Archive and Dismiss controls; the user chooses whether to archive. A dismissed or expired question supplies no answer or approval. Continue only independent work while required input is unresolved.`;
