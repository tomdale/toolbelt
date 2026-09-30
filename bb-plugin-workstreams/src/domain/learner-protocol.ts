import { z } from "zod";
import { usageSchema } from "./trace.ts";

const textBlock = z.object({ type: z.literal("text"), text: z.string().max(100000) });
const toolUseBlock = z.object({ type: z.literal("tool_use"), id: z.string().max(200), name: z.string().max(100), input: z.record(z.string(), z.json()) });
const toolResultBlock = z.object({ type: z.literal("tool_result"), tool_use_id: z.string().max(200), content: z.string().max(100000), is_error: z.boolean().optional() });
export const agentRequestSchema = z.object({ system: z.string().max(30000), model: z.string().max(100), messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.array(z.union([textBlock,toolUseBlock,toolResultBlock])).max(32) })).max(40), tools: z.array(z.object({ name: z.string().max(100), description: z.string().max(2000), input_schema: z.record(z.string(),z.json()) })).max(12) });
export const agentResponseSchema = z.object({ content: z.array(z.union([textBlock,toolUseBlock])).max(32), usage: usageSchema, stopReason: z.string().nullable() });
export type AgentRequest = z.infer<typeof agentRequestSchema>;
export type AgentResponse = z.infer<typeof agentResponseSchema>;
