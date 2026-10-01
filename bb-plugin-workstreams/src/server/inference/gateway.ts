/*
 * Isolated, tool-free AI Gateway completion shared by the host entry and the
 * eval runners. It uses the AI Gateway key Pi already has on the machine,
 * so no new credential is
 * stored, and a prompt built from thread content can only produce text.
 *
 * Unconfigured completions omit `thinking`. The gateway turns
 * `thinking: { type: "disabled" }` (what `pi --print --thinking off` sends)
 * into full reasoning for Gemini 3.1 Flash-Lite: 500-2,500 output tokens and
 * 3-10 s per call, against about 60 tokens and ~1 s with the field omitted.
 * Explicit reasoning uses Chat Completions' shared effort control, which
 * supports disabling reasoning and named levels across Gateway providers.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Usage } from "../../domain/trace.ts";

export const WORKER_SYSTEM_PROMPT =
  "Classify supplied data. Return only the requested JSON. Never take actions.";
export const SYSTEM_PROMPT = WORKER_SYSTEM_PROMPT;
export const PROVIDER = "vercel-ai-gateway";
/** Omitted reasoning leaves the provider's default in control. */
export const THINKING = "provider-default";

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

const chatResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          reasoning: z.string().nullable().optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      cost: z.union([z.number(), z.string()]).optional(),
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
  maxTokens?: number;
  reasoningLevel?: string;
  serviceTier?: string;
}): Promise<Completion> {
  const effort = request.reasoningLevel;
  if (
    effort &&
    !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      effort,
    )
  )
    throw new Error(
      `AI Gateway does not support reasoning level ${effort}. Choose a supported level.`,
    );
  if (
    request.serviceTier &&
    !["default", "fast", "priority", "flex"].includes(request.serviceTier)
  )
    throw new Error(
      `AI Gateway does not support service tier ${request.serviceTier}. Choose a supported tier.`,
    );
  const providerOptions =
    request.serviceTier && request.serviceTier !== "default"
      ? { providerOptions: { gateway: { serviceTier: request.serviceTier } } }
      : {};
  const res = await fetch(
    effort ? "https://ai-gateway.vercel.sh/v1/chat/completions" : GATEWAY_URL,
    {
      method: "POST",
      signal: request.signal,
      headers: {
        "content-type": "application/json",
        ...(effort
          ? { Authorization: `Bearer ${request.apiKey}` }
          : { "anthropic-version": "2023-06-01", "x-api-key": request.apiKey }),
      },
      body: JSON.stringify({
        model: request.model,
        ...(effort
          ? {
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: request.prompt },
              ],
              reasoning_effort: effort,
            }
          : {
              system: SYSTEM_PROMPT,
              messages: [{ role: "user", content: request.prompt }],
              ...(request.disableThinking
                ? { thinking: { type: "disabled" } }
                : {}),
            }),
        max_tokens: request.maxTokens ?? MAX_TOKENS,
        ...providerOptions,
      }),
    },
  );
  if (!res.ok) throw new Error(`AI Gateway returned ${res.status}.`);
  if (effort) {
    const body = chatResponse.parse(await res.json());
    const answer = body.choices[0]!;
    return {
      text: answer.message.content?.trim() ?? "",
      reasoning: answer.message.reasoning?.slice(0, 100_000) ?? null,
      stopReason: answer.finish_reason ?? null,
      usage: {
        input: body.usage?.prompt_tokens ?? 0,
        output: body.usage?.completion_tokens ?? 0,
        cost: Number(body.usage?.cost ?? 0) || 0,
      },
    };
  }
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
