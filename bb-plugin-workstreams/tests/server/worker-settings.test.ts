import { expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { resolveExecution } from "../../src/server/inference/worker.ts";

const sdk = {
  providers: {
    models: vi.fn().mockResolvedValue({
      models: [
        {
          id: "selected-id",
          model: "selected",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
          ],
        },
      ],
      providers: [
        { id: "test", serviceTiers: [{ id: "fast" }, { id: "default" }] },
      ],
    }),
  },
} as unknown as BbPluginApi["sdk"];
const choice = {
  kind: "provider" as const,
  providerId: "test",
  model: "selected",
  reasoningLevel: "low",
  serviceTier: "fast",
};
const scope = { projectId: "p", environmentId: "e" };

it("preserves the selected model, reasoning, and tier", async () => {
  expect(await resolveExecution(sdk, choice, scope)).toEqual({
    providerId: "test",
    model: "selected",
    reasoningLevel: "low",
    serviceTier: "fast",
  });
});
it("does not substitute the default model", async () => {
  await expect(
    resolveExecution(sdk, { ...choice, model: "missing" }, scope),
  ).rejects.toThrow("unavailable");
});
it("does not substitute the default reasoning", async () => {
  await expect(
    resolveExecution(sdk, { ...choice, reasoningLevel: "high" }, scope),
  ).rejects.toThrow("does not support reasoning level high");
});
it("does not drop unsupported service tiers", async () => {
  await expect(
    resolveExecution(sdk, { ...choice, serviceTier: "unknown" }, scope),
  ).rejects.toThrow("does not support service tier unknown");
});
