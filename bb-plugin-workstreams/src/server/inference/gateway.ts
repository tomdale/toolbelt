/**
 * Isolated, tool-free AI Gateway completion shared by the host entry and the
 * eval runners. It calls the gateway's Anthropic Messages endpoint with the
 * AI Gateway key Pi already has on the machine, so no new credential is
 * stored, and a prompt built from thread content can only produce text.
 *
 * The request never carries a `thinking` field. The gateway turns
 * `thinking: { type: "disabled" }` (what `pi --print --thinking off` sends)
 * into full reasoning for Gemini 3.1 Flash-Lite: 500-2,500 output tokens and
 * 3-10 s per call, against about 60 tokens and ~1 s with the field omitted.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Usage } from "../../domain/trace.ts";
import { agentResponseSchema, type AgentRequest, type AgentResponse } from "../../domain/learner-protocol.ts";

export const SYSTEM_PROMPT =
  "Classify supplied data. Return only the requested JSON. Never take actions.";
export const PROVIDER = "vercel-ai-gateway";
/** Reasoning is never requested; see the module comment. */
export const THINKING = "off";

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/messages";
/** Every call's JSON answer fits well inside this; it only bounds a runaway. */
const MAX_TOKENS = 4_096;

export type Completion = {
  text: string;
  usage: Usage;
  /** The model's reasoning summary, when it returned one anyway. */
  reasoning: string | null;
  stopReason: string | null;
};

const response = z.object({
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      thinking: z.string().optional(),
    }),
  ),
  stop_reason: z.string().nullable().optional(),
  usage: z
    .object({ input_tokens: z.number(), output_tokens: z.number() })
    .optional(),
  provider_metadata: z
    .object({
      gateway: z
        .object({ cost: z.union([z.string(), z.number()]).optional() })
        .optional(),
    })
    .optional(),
});

/**
 * The AI Gateway key Pi uses on this machine: Pi's stored API key first (it
 * wins over the environment in Pi too), then `AI_GATEWAY_API_KEY`.
 */
export async function gatewayKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const dir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  try {
    const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as {
      "vercel-ai-gateway"?: { type?: string; key?: unknown };
    };
    const stored = auth["vercel-ai-gateway"];
    if (stored?.type === "api_key" && typeof stored.key === "string")
      return stored.key;
  } catch {
    // No readable Pi auth file; fall back to the environment.
  }
  return env.AI_GATEWAY_API_KEY?.trim() || null;
}

/** One native tool-use turn. Tools execute on the server, not the host. */
export async function gatewayAgentTurn(request: AgentRequest & { apiKey: string; signal?: AbortSignal }): Promise<AgentResponse> {
  const res = await fetch(GATEWAY_URL, {
    method: "POST", signal: request.signal,
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": request.apiKey },
    body: JSON.stringify({ model: request.model, system: request.system, messages: request.messages, tools: request.tools, max_tokens: MAX_TOKENS }),
  });
  if (!res.ok) throw new Error(`AI Gateway returned ${res.status}.`);
  const body = await res.json() as { content: unknown[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number }; provider_metadata?: { gateway?: { cost?: number | string } } };
  return agentResponseSchema.parse({
    content: body.content.filter(block => block && typeof block === "object" && ["text", "tool_use"].includes((block as { type: string }).type)),
    stopReason: body.stop_reason ?? null,
    usage: { input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0, cost: Number(body.provider_metadata?.gateway?.cost ?? 0) || 0 },
  });
}

export async function gatewayComplete(request: {
  prompt: string;
  model: string;
  apiKey: string;
  signal?: AbortSignal;
  /**
   * Sends `thinking: { type: "disabled" }`. Some models (DeepSeek V4 Flash,
   * GLM 5.3 Flash, Nemotron 3.5 Lightning) reason unless told not to, the
   * opposite of Gemini; only the evals use this so far.
   */
  disableThinking?: boolean;
}): Promise<Completion> {
  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    signal: request.signal,
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": request.apiKey,
    },
    body: JSON.stringify({
      model: request.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: request.prompt }],
      max_tokens: MAX_TOKENS,
      ...(request.disableThinking ? { thinking: { type: "disabled" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`AI Gateway returned ${res.status}.`);
  const body = response.parse(await res.json());
  const text = body.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();
  const reasoning = body.content
    .filter((c) => c.type === "thinking")
    .map((c) => c.thinking ?? "")
    .join("\n\n")
    .trim();
  return {
    text,
    usage: {
      input: body.usage?.input_tokens ?? 0,
      output: body.usage?.output_tokens ?? 0,
      cost: Number(body.provider_metadata?.gateway?.cost ?? 0) || 0,
    },
    // Bounded under the host contract's limit.
    reasoning: reasoning ? reasoning.slice(0, 100_000) : null,
    stopReason: body.stop_reason ?? null,
  };
}
