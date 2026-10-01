import { afterEach, expect, it, vi } from "vitest";
import { gatewayComplete } from "../../src/server/inference/gateway.ts";
import { fakeWorld } from "./fake-bb.ts";
import { savePrefs } from "../../src/server/prefs.ts";

afterEach(() => vi.unstubAllGlobals());

it.each(["none", "minimal", "low", "medium", "high", "xhigh", "max"])(
  "sends explicit %s effort and service tier through Chat Completions",
  async (effort) => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "{}", reasoning: "summary" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 30, cost: "0.004" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await gatewayComplete({
      prompt: "classify",
      model: "openai/test",
      apiKey: "test-key",
      reasoningLevel: effort,
      serviceTier: "fast",
      maxTokens: 32768,
    });
    expect(fetch.mock.calls[0]![0]).toBe(
      "https://ai-gateway.vercel.sh/v1/chat/completions",
    );
    const request = fetch.mock.calls[0]![1];
    expect(request.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(request.body)).toMatchObject({
      model: "openai/test",
      reasoning_effort: effort,
      max_tokens: 32768,
      providerOptions: { gateway: { serviceTier: "fast" } },
      messages: [{ role: "system" }, { role: "user", content: "classify" }],
    });
    expect(result).toMatchObject({
      text: "{}",
      reasoning: "summary",
      usage: { input: 120, output: 30, cost: 0.004 },
    });
  },
);

it("keeps unconfigured requests on Messages without forcing thinking", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] })),
    );
  vi.stubGlobal("fetch", fetch);
  await gatewayComplete({
    prompt: "classify",
    model: "google/test",
    apiKey: "test-key",
  });
  expect(fetch.mock.calls[0]![0]).toBe(
    "https://ai-gateway.vercel.sh/v1/messages",
  );
  const body = JSON.parse(fetch.mock.calls[0]![1].body);
  expect(body).not.toHaveProperty("thinking");
  expect(body).not.toHaveProperty("reasoning_effort");
});

it("rejects unsupported controls rather than silently dropping them", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    gatewayComplete({
      prompt: "x",
      model: "openai/test",
      apiKey: "test",
      reasoningLevel: "ultracode",
    }),
  ).rejects.toThrow("does not support reasoning level");
  await expect(
    gatewayComplete({
      prompt: "x",
      model: "openai/test",
      apiKey: "test",
      serviceTier: "unknown",
    }),
  ).rejects.toThrow("does not support service tier");
  expect(fetch).not.toHaveBeenCalled();
});

it("forwards saved Pi Gateway controls through host RPC and traces the direct provider", async () => {
  const world = await fakeWorld();
  try {
    world.addThread("analysis");
    const db = world.bb.storage.database();
    savePrefs(db, {
      advanced: { debug: true },
      threads: {
        analysisModel: {
          kind: "provider",
          providerId: "pi",
          model: "vercel-ai-gateway/openai/test",
          reasoningLevel: "low",
          serviceTier: "fast",
        },
      },
    });
    await world.harness.behavior.runCli(["analyze", "analysis"]);
    expect(world.completions.at(-1)).toMatchObject({
      model: "openai/test",
      reasoningLevel: "low",
      serviceTier: "fast",
    });
    const trace = db
      .prepare(
        "SELECT json_extract(data, '$.provider') AS provider, json_extract(data, '$.thinking') AS thinking FROM ws_trace ORDER BY rowid DESC LIMIT 1",
      )
      .get();
    expect(trace).toMatchObject({
      provider: "vercel-ai-gateway",
      thinking: "low",
    });
    expect(world.workerCalls).toHaveLength(0);
  } finally {
    await world.harness.lifecycle.dispose();
  }
});
