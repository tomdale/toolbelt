import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { usageSchema } from "./pi";

export const hostContract = defineRpcContract({
  complete: {
    input: z.object({ prompt: z.string().max(500_000) }).strict(),
    output: z.object({ text: z.string().max(500_000), usage: usageSchema }),
  },
  image: {
    input: z
      .object({ prompt: z.string().max(4_000), model: z.string() })
      .strict(),
    output: z.object({
      /** Base64 image bytes. */
      data: z.string().max(4_000_000),
      mime: z.string(),
      cost: z.number(),
    }),
  },
});
