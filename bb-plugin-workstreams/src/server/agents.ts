/** Question and recap tools and their per-session instructions. */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isWorkstreamsWorker } from "../domain/worker.ts";
import type { AgentRecaps } from "./recap.ts";
import { questionConfig } from "./questions/tool.ts";

/**
 * Internal inference workers receive no tools or instructions. Side chats
 * receive question support; other threads also receive recap configuration.
 */
export function registerAgentInstructions(
  bb: BbPluginApi,
  recaps: AgentRecaps,
): void {
  bb.agents.configure((context) => {
    if (isWorkstreamsWorker(context.pluginMetadata))
      return { tools: [], skills: [] };
    const sideChat =
      context.origin.kind === "fork" && context.origin.pluginId === "side-chat";
    const recap = recaps.configure(context.thread.id, !sideChat);
    const questions = questionConfig(
      context.provider.capabilities.supportsNativeUserQuestion,
    );
    // The recap instructions travel with the recap tool, so `configure`'s
    // instruction budget holds only the question instructions.
    return {
      tools: [...questions.tools, ...recap.tools],
      skills: [],
      instructions: questions.instructions,
    };
  });
}
