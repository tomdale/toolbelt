import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { usageSchema } from "./pi";

export const hostContract = defineRpcContract({
  complete: {
    input: z.object({ prompt: z.string().max(500_000) }).strict(),
    output: z.object({ text: z.string().max(500_000), usage: usageSchema }),
  },
});
