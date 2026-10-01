import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ModelChoice } from "../../domain/prefs.ts";
import { WORKER_THREAD_MARKER } from "../../domain/worker.ts";
import { WORKER_SYSTEM_PROMPT, type Completion } from "./gateway.ts";

type Sdk = BbPluginApi["sdk"];
type Choice = Extract<ModelChoice, { kind: "provider" }>;
type Reasoning = NonNullable<
  Parameters<Sdk["threads"]["spawn"]>[0]["reasoningLevel"]
>;
type ServiceTier = NonNullable<
  Parameters<Sdk["threads"]["spawn"]>[0]["serviceTier"]
>;
const TIMEOUT_MS = 120_000;
const PERMISSION_MODE = "accept-edits" as const;

/** Human-readable identity retained on traces and in the inspector. */
export function workerModelLabel(choice: ModelChoice): string {
  return choice.kind === "gateway"
    ? choice.model
    : `${choice.providerId}/${choice.model}`;
}

export async function resolveExecution(
  sdk: Sdk,
  choice: Choice,
  scope: { projectId: string; environmentId?: string },
  signal?: AbortSignal,
) {
  const catalog = await sdk.providers.models(
    scope.environmentId
      ? {
          providerId: choice.providerId,
          environmentId: scope.environmentId,
          ...(signal ? { signal } : {}),
        }
      : { providerId: choice.providerId, ...(signal ? { signal } : {}) },
  );
  let model = catalog.models.find(
    (candidate) =>
      candidate.model === choice.model || candidate.id === choice.model,
  );
  if (!model) {
    model =
      catalog.models.find((candidate) => candidate.isDefault) ??
      catalog.models[0];
  }
  if (!model)
    throw new Error(`No model is available for provider ${choice.providerId}.`);
  const supported = model.supportedReasoningEfforts.map(
    (item) => item.reasoningEffort,
  );
  const reasoningLevel = (
    supported.length === 0 ||
    !supported.includes(choice.reasoningLevel as Reasoning)
      ? model.defaultReasoningEffort
      : choice.reasoningLevel
  ) as Reasoning;
  const provider = catalog.providers.find(
    (candidate) => candidate.id === choice.providerId,
  );
  const serviceTier =
    choice.serviceTier &&
    provider?.serviceTiers?.some((tier) => tier.id === choice.serviceTier)
      ? (choice.serviceTier as ServiceTier)
      : undefined;
  return {
    providerId: choice.providerId,
    model: model.model,
    reasoningLevel,
    ...(serviceTier ? { serviceTier } : {}),
  };
}

/**
 * Completes a prompt in an unlisted BB thread, retaining the request only in
 * the worker's conversation. `accept-edits` is BB's least-permissive spawn mode;
 * Workstreams supplies no tools or filesystem task, so workers cannot organize.
 */
export async function runWorker(
  sdk: Sdk,
  prompt: string,
  choice: ModelChoice,
  projectId: string,
  environmentId: string | undefined,
  signal?: AbortSignal,
): Promise<Completion> {
  if (choice.kind !== "provider")
    throw new Error("Gateway choices must use the direct completion path.");
  if (signal?.aborted) throw signal.reason;
  const execution = await resolveExecution(
    sdk,
    choice,
    { projectId, ...(environmentId ? { environmentId } : {}) },
    signal,
  );
  const worker = await sdk.threads.spawn({
    projectId,
    ...(environmentId
      ? { environment: { type: "reuse" as const, environmentId } }
      : { environment: { type: "project-default" as const } }),
    ...execution,
    permissionMode: PERMISSION_MODE,
    title: "Workstreams worker",
    visibility: "hidden",
    pluginMetadata: { [WORKER_THREAD_MARKER.key]: WORKER_THREAD_MARKER.value },
    prompt: `${WORKER_SYSTEM_PROMPT}\n\n${prompt}`,
  });
  try {
    if (signal?.aborted) throw signal.reason;
    await sdk.threads.wait({
      threadId: worker.id,
      status: "idle",
      timeoutMs: TIMEOUT_MS,
      signal,
    });
    if (signal?.aborted) throw signal.reason;
    const { output } = await sdk.threads.output({
      threadId: worker.id,
      signal,
    });
    return {
      text: output ?? "",
      usage: { input: 0, output: 0, cost: 0 },
      reasoning: null,
      stopReason: null,
    };
  } finally {
    await sdk.threads.archive({ threadId: worker.id }).catch(() => {});
    await sdk.threads.stop({ threadId: worker.id }).catch(() => {});
  }
}
