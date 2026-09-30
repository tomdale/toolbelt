import { z } from "zod";

export const notebookSchema = z.object({ threadId: z.string(), title: z.string(), text: z.string(), updatedAt: z.number(), cursor: z.string().nullable(), revision: z.number().nullable(), error: z.string().nullable() });
export const briefSchema = z.object({ text: z.string(), updatedAt: z.number() });
export const learningStepSchema = z.object({ tool: z.string(), input: z.string(), output: z.string(), at: z.number() });
export const learningRunSchema = z.object({ id: z.string(), threadId: z.string().nullable(), question: z.string().nullable(), status: z.enum(["running", "done", "failed", "cancelled"]), startedAt: z.number(), finishedAt: z.number().nullable(), summary: z.string(), error: z.string().nullable(), steps: z.array(learningStepSchema), usage: z.object({ input: z.number(), output: z.number(), cost: z.number() }), model: z.string() });
export const notebookVersionSchema = z.object({ id: z.string(), threadId: z.string().nullable(), text: z.string(), at: z.number(), runId: z.string().nullable() });
export const notebookOverviewSchema = z.object({ brief: briefSchema, notebooks: z.array(notebookSchema), runs: z.array(learningRunSchema), running: z.boolean(), totalNotebooks: z.number() });
export type Notebook = z.infer<typeof notebookSchema>;
export type Brief = z.infer<typeof briefSchema>;
export type LearningRun = z.infer<typeof learningRunSchema>;
export type NotebookVersion = z.infer<typeof notebookVersionSchema>;
