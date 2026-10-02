import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { usageSchema } from "../../domain/trace.ts";

/** RPC between the plugin server and its `bb.host` entry on the machine. */
export const hostContract = defineRpcContract({
  complete: {
    input: z
      .object({
        prompt: z.string().max(320_000),
        reasoningLevel: z.string().min(1).max(50).optional(),
        serviceTier: z.string().min(1).max(50).optional(),
        maxTokens: z.number().int().min(1024).max(32768).optional(),
        model: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/)
          .max(100),
      })
      .strict(),
    output: z.object({
      text: z.string().max(200_000),
      usage: usageSchema,
      // Optional so a host bundle built before reasoning capture still answers.
      reasoning: z.string().max(200_000).nullable().optional(),
      stopReason: z.string().max(100).nullable().optional(),
    }),
  },
});
