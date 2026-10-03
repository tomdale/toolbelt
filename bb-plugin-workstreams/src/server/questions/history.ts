import { z } from "zod";
import { interactionPayloadSchema } from "./contracts.ts";

export const questionResultSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string(),
      options: z.array(
        z.object({
          label: z.string(),
          description: z.string(),
          preview: z.string().optional(),
        }),
      ),
      multiSelect: z.boolean(),
    }),
  ),
  answers: z.record(z.string(), z.string()),
  response: z.string().optional(),
  annotations: z
    .record(
      z.string(),
      z.object({
        preview: z.string().optional(),
        notes: z.string().optional(),
        attachments: z
          .array(
            z.object({
              type: z.enum(["localImage", "localFile"]),
              projectId: z.string(),
              path: z.string(),
              name: z.string(),
              mimeType: z.string().optional(),
              sizeBytes: z.number().optional(),
              sourceProjectId: z.string().optional(),
              sourcePath: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});
export const questionHistorySchema = z.object({
  id: z.string(),
  at: z.number().nullable(),
  status: z.enum(["answered", "dismissed", "pending", "unknown"]),
  payload: interactionPayloadSchema,
  result: questionResultSchema.nullable(),
});
export type QuestionHistory = z.infer<typeof questionHistorySchema>;

/** Detached answers are ordinary retained inputs, even when their UI row was suppressed. */
export function deliveredQuestionResult(text: string) {
  const prefix =
    "Your earlier AskUserQuestion tool call has finished. Its result:\n\n";
  const recovered =
    "My answer to your question (recovered after the question tool was interrupted):\n";
  let raw: string;
  if (text.startsWith(prefix)) raw = text.slice(prefix.length);
  else if (text.startsWith(recovered))
    raw = text.slice(recovered.length).split("\nUse this as my answer")[0]!;
  else return null;
  try {
    const result = questionResultSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
