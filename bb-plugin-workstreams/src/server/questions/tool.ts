/**
 * The AskUserQuestion tool: question cards for required user input. The
 * tool opens a BB interaction (so the thread reads as waiting and recaps
 * stand aside), and the app draws the card above the composer in the recap
 * card's place; see src/app/question/QuestionCard.tsx.
 */
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import {
  ASK_USER_QUESTION_RENDERER_ID,
  interactionResponseSchema,
  toolInputSchema,
} from "./contracts.ts";
import { QUESTION_INSTRUCTIONS, TOOL_DESCRIPTION } from "./tool-definition.ts";
import {
  assertInteractionPayloadFits,
  buildInteractionPayload,
  buildInteractionTitle,
  buildToolResult,
  describeAnswers,
  validateToolInput,
} from "./translate.ts";

import type { QuestionStore } from "./store.ts";

export const TOOL_NAME = "AskUserQuestion";

const QUESTION_TIMEOUT_MS = 60 * 60 * 1000;

function errorResult(message: string): PluginAgentToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function registerQuestionTool(
  bb: BbPluginApi,
  store?: QuestionStore,
): void {
  bb.agents.registerTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    presentation: {
      label: {
        pending: "Awaiting your answer",
        completed: "Received an answer",
      },
      icon: { glyph: "MessageQuestion" },
      suppress: true,
    },
    parameters: toolInputSchema,
    async execute(input, ctx) {
      const invalid = validateToolInput(input);
      if (invalid !== null) return errorResult(invalid);

      const payload = buildInteractionPayload(input);
      try {
        assertInteractionPayloadFits(payload);
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }

      let durableId: string | undefined;
      let result;
      try {
        durableId = store?.open(ctx.threadId, payload);
        result = await bb.ui.requestInput(
          {
            threadId: ctx.threadId,
            rendererId: ASK_USER_QUESTION_RENDERER_ID,
            title: buildInteractionTitle(payload),
            payload: { ...payload, ...(durableId ? { durableId } : {}) },
            timeoutMs: QUESTION_TIMEOUT_MS,
            presentation: {
              label: { pending: "Awaiting your answer", completed: "Answered" },
              icon: { glyph: "MessageQuestion" },
            },
            describeSubmission: (value) => {
              const parsed = interactionResponseSchema.safeParse(value);
              if (!parsed.success) return {};
              return describeAnswers(
                payload,
                buildToolResult(payload, parsed.data),
              );
            },
          },
          { signal: ctx.signal },
        );
      } catch (error) {
        if (durableId) store?.finish(durableId);
        return errorResult(
          `The question could not be shown (${error instanceof Error ? error.message : String(error)}). Only one prompt can await the user at a time; group related questions in one AskUserQuestion call. Missing input remains unresolved. Continue only independent work and report what remains blocked.`,
        );
      }

      if (result.outcome === "cancelled") {
        // Reload and turn interruption lose the native waiter, not the user's
        // outstanding decision. Only explicit dismissal resolves the record.
        if (durableId) {
          if (result.reason === "user") store?.finish(durableId);
          else store?.interrupted(durableId);
        }
        return errorResult(
          `The question was cancelled (${result.reason}) without an answer. This is not a decision or approval. Continue only work independent of the missing input and report what remains blocked.`,
        );
      }

      if (durableId) store?.finish(durableId);
      const parsed = interactionResponseSchema.safeParse(result.value);
      if (!parsed.success) {
        return errorResult(
          "The answer could not be read. The required input remains unresolved. Use AskUserQuestion to request it again; continue only independent work.",
        );
      }
      const toolResult = buildToolResult(payload, parsed.data);
      if (Object.keys(toolResult.answers).length === 0) {
        return errorResult(
          "The user submitted no answers. The required input remains unresolved. Continue only independent work and report what remains blocked.",
        );
      }
      return JSON.stringify(toolResult);
    },
  });
}

/**
 * The session's question tool and instructions. Providers with their own
 * question tool keep it and get only the instructions.
 */
export function questionConfig(nativeQuestions: boolean): {
  tools: string[];
  instructions: string;
} {
  return {
    tools: nativeQuestions ? [] : [TOOL_NAME],
    instructions: QUESTION_INSTRUCTIONS,
  };
}
