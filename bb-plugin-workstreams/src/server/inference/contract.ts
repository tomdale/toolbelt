import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { usageSchema } from "./pi.ts";

/** RPC between the plugin server and its `bb.host` entry on the machine. */
export const hostContract = defineRpcContract({
  complete: {
    input: z
      .object({
        prompt: z.string().max(200_000),
        model: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/)
          .max(100),
      })
      .strict(),
    output: z.object({ text: z.string().max(200_000), usage: usageSchema }),
  },
});
