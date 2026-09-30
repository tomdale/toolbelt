/**
 * Every model call Workstreams makes, by kind: how the prompt is built from
 * the call's input and how the response is parsed. One definition serves the
 * live call, its debug trace (SPEC §11.6), and a replay from the inspector.
 */
import {
  analysisPrompt,
  parseAnalysis,
  type AnalysisInput,
} from "../domain/analysis.ts";
import {
  assignPrompt,
  describePrompt,
  mapPrompt,
  parseAssignments,
  parseDescriptions,
  parseMapProposal,
  type AssignInput,
  type MapInput,
} from "../domain/organize.ts";
import { parseRoute, routePrompt, type RouteInput } from "../domain/router.ts";
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
  type PiCompletion,
} from "./inference/pi.ts";
import { UserError } from "./service.ts";
import { boundedJson, type TraceStore } from "./trace.ts";

type DescribeInput = Parameters<typeof describePrompt>[0];

const assign = {
  prompt: (input: AssignInput) => assignPrompt(input),
  parse: (text: string, input: AssignInput) =>
    parseAssignments(
      text,
      input.threads.map((t) => t.id),
      input.workstreams.map((w) => w.name),
    ),
};

export const MODEL_CALLS = {
  analysis: {
    prompt: (input: AnalysisInput) => analysisPrompt(input),
    parse: (text: string, input: AnalysisInput) => parseAnalysis(text, input),
  },
  route: {
    prompt: (input: RouteInput) => routePrompt(input),
    parse: (text: string, input: RouteInput) => parseRoute(text, input),
  },
  "organize-map": {
    prompt: (input: MapInput) => mapPrompt(input),
    parse: (text: string, input: MapInput) =>
      parseMapProposal(
        text,
        input.workstreams.map((w) => w.name),
      ),
  },
  "organize-assign": assign,
  "file-unsorted": assign,
  describe: {
    prompt: (input: DescribeInput) => describePrompt(input),
    parse: (text: string, input: DescribeInput) =>
      parseDescriptions(
        text,
        input.map((w) => w.name),
      ),
  },
} satisfies Record<
  TraceKind,
  {
    prompt: (input: never) => string;
    parse: (text: string, input: never) => unknown;
  }
>;

type Calls = typeof MODEL_CALLS;
export type InputOf<K extends TraceKind> = Parameters<Calls[K]["prompt"]>[0];
export type OutputOf<K extends TraceKind> = ReturnType<Calls[K]["parse"]>;
type Spec = {
  prompt: (input: unknown) => string;
  parse: (text: string, input: unknown) => unknown;
};

export type Complete = (
  prompt: string,
  model: string,
) => Promise<
  Pick<PiCompletion, "text" | "usage"> &
    Partial<Pick<PiCompletion, "reasoning" | "stopReason">>
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
    options: { model: string; label?: string; links?: readonly TraceLink[] },
  ): Promise<{ value: OutputOf<K>; traceId: string | null }> {
    const spec = MODEL_CALLS[kind] as unknown as Spec;
    const result = await this.call(kind, {
      prompt: spec.prompt(input),
      parse: (text) => spec.parse(text, input),
      input,
      model: options.model,
      label: options.label ?? TRACE_KIND_TITLE[kind],
      links: options.links ?? [],
      replayOf: null,
      record: await this.deps.debug(),
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
      model: original.model,
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
      model: string;
      label: string;
      links: readonly TraceLink[];
      replayOf: string | null;
      record: boolean;
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
                model: request.model,
                durationMs: this.now() - started,
                replayOf: request.replayOf,
                provider: PROVIDER,
                thinking: THINKING,
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
                outcome: null,
                error:
                  fields.error === undefined ? null : message(fields.error),
              },
              request.links,
            ),
          )
        : null;
    let completion: Awaited<ReturnType<Complete>>;
    try {
      completion = await this.deps.complete(request.prompt, request.model);
    } catch (error) {
      return { ok: false, error, traceId: record("failed", { error }) };
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
