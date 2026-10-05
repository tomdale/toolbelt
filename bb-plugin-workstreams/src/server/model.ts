/**
 * Every model call Workstreams makes, by kind: how the prompt is built from
 * the call's input and how the response is parsed. One definition serves the
 * live call, its debug trace (SPEC §11.6), and a replay from the inspector.
 */
import {
  fullAnalysisPrompt,
  parseFullAnalysis,
  parseQuickAnalysis,
  quickAnalysisPrompt,
  type FullAnalysisInput,
  type QuickAnalysisInput,
} from "../domain/analysis.ts";
import {
  TRACE_KIND_TITLE,
  type Trace,
  type TraceKind,
  type TraceLink,
  type TraceStatus,
} from "../domain/trace.ts";
import {
  PROVIDER,
  SYSTEM_PROMPT,
  THINKING,
  type Completion,
} from "./inference/gateway.ts";
import {
  gatewayModel,
  modelChoiceSchema,
  type ModelChoice,
} from "../domain/prefs.ts";
import { UserError } from "./service.ts";
import { boundedJson, type TraceStore } from "./trace.ts";

export const MODEL_CALLS = {
  "quick-analysis": {
    prompt: (input: QuickAnalysisInput) => quickAnalysisPrompt(input),
    parse: (text: string, input: QuickAnalysisInput) =>
      parseQuickAnalysis(text, input),
  },
  "full-analysis": {
    prompt: (input: FullAnalysisInput) => fullAnalysisPrompt(input),
    parse: (text: string, input: FullAnalysisInput) =>
      parseFullAnalysis(text, input),
  },
} satisfies Record<
  TraceKind,
  {
    prompt: (input: never) => string;
    parse: (text: string, input: never) => unknown;
  }
>;

type Calls = typeof MODEL_CALLS;

/** Human-readable identity persisted alongside replayable model choices. */
export function modelLabel(choice: ModelChoice): string {
  const direct = gatewayModel(choice);
  return (
    direct ??
    (choice.kind === "provider"
      ? `${choice.providerId}/${choice.model}`
      : choice.model)
  );
}
export type InputOf<K extends TraceKind> = Parameters<Calls[K]["prompt"]>[0];
export type OutputOf<K extends TraceKind> = ReturnType<Calls[K]["parse"]>;

/**
 * One line of what a call decided, for lists: the Activity log, the Debug
 * tab, and `bb workstreams trace`.
 */
export function summarize(
  kind: TraceKind,
  value: unknown,
  input: unknown,
): string | null {
  const topicOf = (
    topic: {
      subjectId: string | null;
      proposed: { name: string } | null;
    } | null,
    entities: readonly { id: string; name: string }[] | undefined,
  ) =>
    topic
      ? topic.subjectId
        ? (entities?.find((e) => e.id === topic.subjectId)?.name ??
          topic.subjectId)
        : topic.proposed
          ? `new topic ${topic.proposed.name}`
          : "no topic"
      : null;
  switch (kind) {
    case "quick-analysis": {
      const q = value as OutputOf<"quick-analysis">;
      return [
        q.goal ? `goal “${q.goal}”` : "no goal",
        topicOf(q, (input as QuickAnalysisInput).entities),
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "full-analysis": {
      const a = value as OutputOf<"full-analysis">;
      return [
        a.status ? a.status.state.replace("_", " ") : "reported",
        a.goal ? `goal “${a.goal}”` : null,
        a.topic
          ? `${topicOf(a.topic, (input as FullAnalysisInput).topic?.entities)}${a.topic.scopeShift ? " (scope shift)" : ""}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
  }
}
type Spec = {
  prompt: (input: unknown) => string;
  parse: (text: string, input: unknown) => unknown;
};

export type Complete = (
  prompt: string,
  choice: ModelChoice,
  signal?: AbortSignal,
  maxTokens?: number,
  context?: { threadId?: string },
) => Promise<
  Pick<Completion, "text" | "usage"> &
    Partial<Pick<Completion, "reasoning" | "stopReason">>
>;

/** The trace behind a failed call, when debug mode recorded one. */
export function traceIdOf(error: unknown): string | null {
  const id =
    error && typeof error === "object"
      ? (error as { traceId?: unknown }).traceId
      : undefined;
  return typeof id === "string" ? id : null;
}

function withTrace(error: unknown, traceId: string | null): unknown {
  if (traceId && error && typeof error === "object")
    Object.defineProperty(error, "traceId", {
      value: traceId,
      configurable: true,
    });
  return error;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const duration = (ms: number) =>
  ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} seconds`;

export class Inference {
  constructor(
    private readonly deps: {
      complete: Complete;
      traces: TraceStore;
      /** Whether debug mode is on; read before every call. */
      debug: () => Promise<boolean>;
      log?: (message: string) => void;
      now?: () => number;
    },
  ) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Builds the prompt for `kind` from `input`, calls the model, and parses
   * the response. With debug mode on, records the call and returns its trace
   * id; a failure carries the id too (see `traceIdOf`).
   */
  async run<K extends TraceKind>(
    kind: K,
    input: InputOf<K>,
    options: {
      model: ModelChoice;
      threadId?: string;
      label?: string;
      links?: readonly TraceLink[];
      /**
       * Aborts the call when its answer stops mattering. An aborted call
       * rejects with the abort reason and is not traced: it explains nothing.
       */
      signal?: AbortSignal;
      /**
       * Gives up on a call that takes longer than this, which fails like any
       * other failed call (and is traced as one), unlike an abort.
       */
      timeoutMs?: number;
    },
  ): Promise<{ value: OutputOf<K>; traceId: string | null }> {
    const spec = MODEL_CALLS[kind] as unknown as Spec;
    const result = await this.call(kind, {
      prompt: spec.prompt(input),
      parse: (text) => spec.parse(text, input),
      input,
      model: options.model,
      threadId: options.threadId,
      label: options.label ?? TRACE_KIND_TITLE[kind],
      links: options.links ?? [],
      replayOf: null,
      record: await this.deps.debug(),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    if (!result.ok) throw withTrace(result.error, result.traceId);
    return { value: result.value as OutputOf<K>, traceId: result.traceId };
  }

  /**
   * Sends a recorded prompt to its model again and records the answer as a
   * replay of the original. Nothing Workstreams stores changes.
   */
  async replay(traceId: string): Promise<Trace> {
    const original = this.deps.traces.get(traceId);
    if (!original) throw new UserError("That model call is no longer stored.");
    const spec = MODEL_CALLS[original.kind] as unknown as Spec;
    const result = await this.call(original.kind, {
      prompt: original.prompt,
      // The stored input keeps the names and ids the parser checks against.
      parse: (text) => spec.parse(text, original.input),
      input: original.input,
      model:
        original.modelChoice ??
        modelChoiceSchema.parse({ kind: "gateway", model: original.model }),
      label: original.label,
      links: [],
      replayOf: original.id,
      record: true,
    });
    const trace = result.traceId ? this.deps.traces.get(result.traceId) : null;
    if (!trace) throw new Error("The replay could not be recorded.");
    return trace;
  }

  /** Links traces (null ids are skipped) to what they explain. */
  link(
    traceIds:
      string | null | undefined | readonly (string | null | undefined)[],
    ...links: TraceLink[]
  ): void {
    for (const id of [traceIds].flat())
      if (id) this.safely(() => this.deps.traces.link(id, links));
  }

  /** Trace ids linked to each ref of one kind, newest first. */
  linked(
    kind: TraceLink["kind"],
    refs: readonly string[],
  ): Map<string, string[]> {
    return this.safely(() => this.deps.traces.idsFor(kind, refs)) ?? new Map();
  }

  /** Links every trace linked to `from` to `to` as well. */
  copyLinks(from: TraceLink, to: TraceLink): void {
    this.safely(() => this.deps.traces.copyLinks(from, to));
  }

  /** Source removal also removes retained prompts and their replay descendants. */
  forgetTraces(
    ids: readonly (string | null | undefined)[],
    links: readonly TraceLink[] = [],
  ): void {
    this.safely(() =>
      this.deps.traces.remove(
        ids.filter((id): id is string => Boolean(id)),
        links,
      ),
    );
  }

  /** Records what Workstreams did with a call's result (merged). */
  annotate(
    traceId: string | null | undefined,
    outcome: Record<string, unknown>,
  ): void {
    if (traceId) this.safely(() => this.deps.traces.annotate(traceId, outcome));
  }

  /**
   * Recording is best effort: a trace store failure never changes what a
   * model call returns, so Debug mode can't change behavior.
   */
  private safely<T>(work: () => T): T | null {
    try {
      return work();
    } catch (error) {
      this.deps.log?.(`Debug trace not recorded: ${message(error)}`);
      return null;
    }
  }

  private async call(
    kind: TraceKind,
    request: {
      prompt: string;
      parse: (text: string) => unknown;
      input: unknown;
      model: ModelChoice;
      threadId?: string;
      label: string;
      links: readonly TraceLink[];
      replayOf: string | null;
      record: boolean;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<
    | { ok: true; value: unknown; traceId: string | null }
    | { ok: false; error: unknown; traceId: string | null }
  > {
    const started = this.now();
    const record = (
      status: TraceStatus,
      fields: {
        completion?: Awaited<ReturnType<Complete>>;
        parsed?: unknown;
        error?: unknown;
      },
    ): string | null =>
      request.record
        ? this.safely(() =>
            this.deps.traces.add(
              {
                at: started,
                kind,
                status,
                label: request.label,
                model: modelLabel(request.model),
                modelChoice: request.model,
                durationMs: this.now() - started,
                replayOf: request.replayOf,
                provider:
                  request.model.kind === "gateway" ||
                  gatewayModel(request.model) !== null
                    ? PROVIDER
                    : `bb-provider:${request.model.providerId}`,
                thinking:
                  request.model.kind === "provider"
                    ? request.model.reasoningLevel
                    : THINKING,
                system: SYSTEM_PROMPT,
                prompt: request.prompt,
                input: boundedJson(request.input),
                response: fields.completion?.text ?? null,
                reasoning: fields.completion?.reasoning ?? null,
                stopReason: fields.completion?.stopReason ?? null,
                usage: fields.completion?.usage ?? null,
                parsed:
                  fields.parsed === undefined
                    ? null
                    : boundedJson(fields.parsed),
                summary:
                  fields.parsed === undefined
                    ? null
                    : this.safely(() =>
                        summarize(kind, fields.parsed, request.input),
                      ),
                outcome: null,
                error:
                  fields.error === undefined ? null : message(fields.error),
              },
              request.links,
            ),
          )
        : null;
    let completion: Awaited<ReturnType<Complete>>;
    // The timeout aborts the request itself, so the host closes it too.
    const timeout =
      request.timeoutMs === undefined ? null : new AbortController();
    const timer =
      timeout &&
      setTimeout(
        () => timeout.abort(new Error("timed out")),
        request.timeoutMs,
      );
    const signal =
      timeout && request.signal
        ? AbortSignal.any([request.signal, timeout.signal])
        : (timeout?.signal ?? request.signal);
    try {
      completion = await this.deps.complete(
        request.prompt,
        request.model,
        signal,
        undefined,
        request.threadId ? { threadId: request.threadId } : undefined,
      );
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      const failure = timeout?.signal.aborted
        ? new Error(
            `The model didn't answer within ${duration(request.timeoutMs!)}.`,
          )
        : error;
      return {
        ok: false,
        error: failure,
        traceId: record("failed", { error: failure }),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
    let value: unknown;
    try {
      value = request.parse(completion.text);
    } catch (error) {
      return {
        ok: false,
        error,
        traceId: record("invalid", { completion, error }),
      };
    }
    return {
      ok: true,
      value,
      traceId: record("ok", { completion, parsed: value }),
    };
  }
}
