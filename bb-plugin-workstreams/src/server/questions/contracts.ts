import { z } from "zod";

export const ASK_USER_QUESTION_RENDERER_ID = "ask-user-question";

const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 4;
const MAX_SELECTED = MAX_OPTIONS;
const MAX_FREE_TEXT_LENGTH = 4096;
export const MAX_OPTION_PREVIEW_LENGTH = 4096;

const nonBlank = (value: string) => value.trim().length > 0;

const interactionOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  preview: z.string().min(1).optional(),
});

const interactionQuestionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  details: z.string().min(1).optional(),
  shortLabel: z.string().min(1),
  multiSelect: z.boolean(),
  options: z.array(interactionOptionSchema).max(MAX_OPTIONS),
  allowFreeText: z.boolean(),
});
export type InteractionQuestion = z.infer<typeof interactionQuestionSchema>;

export const interactionPayloadSchema = z.object({
  questions: z.array(interactionQuestionSchema).min(1).max(MAX_QUESTIONS),
});
export type InteractionPayload = z.infer<typeof interactionPayloadSchema>;

const interactionAttachmentSchema = z.object({
  type: z.enum(["localImage", "localFile"]),
  projectId: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sourceProjectId: z.string().min(1).optional(),
  sourcePath: z.string().min(1).optional(),
});

const interactionAnswerSchema = z.object({
  selected: z.array(z.string().min(1)).max(MAX_SELECTED),
  freeText: z
    .string()
    .min(1)
    .max(MAX_FREE_TEXT_LENGTH)
    .refine(nonBlank, "Free text cannot be blank")
    .optional(),
  attachments: z.array(interactionAttachmentSchema).max(100).optional(),
});
export type InteractionAnswer = z.infer<typeof interactionAnswerSchema>;

export const interactionResponseSchema = z.object({
  answers: z.record(z.string().min(1), interactionAnswerSchema),
});
export type InteractionResponse = z.infer<typeof interactionResponseSchema>;

const toolOptionSchema = z.strictObject({
  label: z
    .string()
    .min(1)
    .refine(nonBlank, "Option labels cannot be blank")
    .describe(
      "The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
    ),
  description: z
    .string()
    .min(1)
    .refine(nonBlank, "Option descriptions cannot be blank")
    .describe(
      "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
    ),
  preview: z
    .string()
    .max(MAX_OPTION_PREVIEW_LENGTH)
    .optional()
    .describe(
      "Optional preview content rendered when this option is selected. Use for mockups, code snippets, or visual comparisons that help users compare concrete artifacts.",
    ),
});

const toolQuestionSchema = z.strictObject({
  question: z
    .string()
    .min(1)
    .refine(nonBlank, "Questions cannot be blank")
    .describe(
      'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
    ),
  details: z
    .string()
    .min(1)
    .refine(nonBlank, "Details cannot be blank")
    .optional()
    .describe(
      "Optional always-visible context displayed directly below the question and above its answer options. Put proposal lists and other information the user must see before deciding here, not in an option preview.",
    ),
  header: z
    .string()
    .min(1)
    .refine(nonBlank, "Headers cannot be blank")
    .describe(
      'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
    ),
  options: z
    .array(toolOptionSchema)
    .max(MAX_OPTIONS)
    .describe(
      "Up to 4 meaningful suggested answers. Use an empty array for a genuinely freeform answer. Each suggestion should be distinct and mutually exclusive unless multiSelect is enabled. Freeform input is always provided automatically; omit an 'Other' option.",
    ),
  multiSelect: z
    .boolean()
    .default(false)
    .describe(
      "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
    ),
});

export const toolInputSchema = z.strictObject({
  questions: z
    .array(toolQuestionSchema)
    .min(1)
    .max(MAX_QUESTIONS)
    .describe("Questions to ask the user (1-4 questions)"),
});
export type ToolInput = z.infer<typeof toolInputSchema>;

interface ToolResultQuestion {
  question: string;
  details?: string;
  header: string;
  options: Array<{ label: string; description: string; preview?: string }>;
  multiSelect: boolean;
}

export interface ToolResultAnnotation {
  preview?: string;
  notes?: string;
  attachments?: Array<{
    type: "localImage" | "localFile";
    projectId: string;
    path: string;
    name: string;
    mimeType?: string;
    sizeBytes?: number;
    sourceProjectId?: string;
    sourcePath?: string;
  }>;
}

export interface ToolResult {
  questions: ToolResultQuestion[];
  answers: Record<string, string>;
  response?: string;
  annotations?: Record<string, ToolResultAnnotation>;
}
