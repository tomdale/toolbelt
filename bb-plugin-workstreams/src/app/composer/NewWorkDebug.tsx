/**
 * The New thread composer's Debug section (SPEC §11.6): a collapsed
 * disclosure under the composer with what it takes to judge a preview: the
 * topic and goal, the reason, what Quick analysis was given, the server's
 * notes on each step, and the exact prompt and raw response. Copy
 * diagnostics adds the composer's state and activity log.
 */
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import type { QuickAnalysisInput } from "../../domain/analysis.ts";
import type { Trace } from "../../domain/trace.ts";
import type { RpcContract } from "../../server/contract.ts";
import type { Preview } from "../../server/preview.ts";
import { Code, json, smallButton } from "../debug/Inspector.tsx";
import type { NewWork } from "./new-work.ts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function decisionTarget(decision: Preview): string {
  return decision.subject
    ? `New thread about ${decision.subject}`
    : "New thread with no topic yet";
}

/** The decision's recorded model call, once loaded. */
function useTrace(id: string | null) {
  const rpc = useRpc<RpcContract>();
  const [loaded, setLoaded] = useState<{
    id: string;
    trace: Trace | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    rpc.call("trace", { id }).then(
      ({ trace }) => live && setLoaded({ id, trace, error: null }),
      (cause: unknown) =>
        live &&
        setLoaded({
          id,
          trace: null,
          error: cause instanceof Error ? cause.message : String(cause),
        }),
    );
    return () => {
      live = false;
    };
  }, [rpc, id]);
  return loaded?.id === id ? loaded : null;
}

function Fields({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
      {children}
    </dl>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h4 className="mb-1 mt-3 font-medium first:mt-0">{children}</h4>;
}

export function NewWorkDebug({ newWork }: { newWork: NewWork }) {
  const state = useSyncExternalStore(newWork.subscribe, newWork.snapshot);
  const rpc = useRpc<RpcContract>();
  const { decision } = state;
  const traceId = decision?.traceId ?? null;
  const loaded = useTrace(traceId);
  const trace = loaded?.trace ?? null;
  const input = (trace?.input ?? null) as Partial<QuickAnalysisInput> | null;
  const notes = decision?.explanation?.notes ?? [];
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const { events, ...dialog } = state;
    try {
      await navigator.clipboard.writeText(
        json({ decision, trace, dialog, events }),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the section still shows the essentials.
    }
  };
  return (
    <details className="ws-new-work-debug group/debug mt-3 rounded-lg border border-dashed border-border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <Icon name="Bug" aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium">Debug</span>
        <span className="min-w-0 flex-1 truncate">
          {decision ? decisionTarget(decision) : "No preview yet"}
        </span>
        <span
          aria-hidden
          className="inline-block transition-transform group-open/debug:rotate-90"
        >
          ›
        </span>
      </summary>
      <div className="max-h-[50vh] overflow-y-auto border-t border-dashed border-border px-3 pb-3 pt-2 text-xs">
        {decision ? (
          <>
            <Heading>Result</Heading>
            <Fields>
              <Field label="Outcome">
                {decisionTarget(decision)} · {decision.confidence} confidence
              </Field>
              {decision.goal ? (
                <Field label="Title">{decision.goal}</Field>
              ) : null}
              <Field label="Reason">{decision.reason || "—"}</Field>
            </Fields>
          </>
        ) : (
          <p className="text-muted-foreground">
            No preview has finished for this draft yet.
          </p>
        )}
        {decision && !traceId ? (
          <p className="mt-3 text-muted-foreground">
            No model call was recorded: the preview needed none, or Debug mode
            was off when it ran.
          </p>
        ) : null}
        {traceId && !loaded ? (
          <p className="mt-3 text-muted-foreground">Loading the model call…</p>
        ) : null}
        {loaded && !trace ? (
          <p className="mt-3 text-muted-foreground">
            {loaded.error ?? "This model call is no longer stored."}
          </p>
        ) : null}
        {trace ? (
          <>
            <Heading>Model inputs</Heading>
            <Fields>
              <Field label="Request">
                “{clip(input?.request ?? trace.label, 160)}”
              </Field>
              <Field label="Project">{input?.project ?? "None"}</Field>
              <Field label="Topics offered">
                {plural(input?.entities?.length ?? 0, "topic")}
              </Field>
              <Field label="Model">
                {trace.model} · {seconds(trace.durationMs)}
                {trace.usage
                  ? ` · ${trace.usage.input.toLocaleString()} tokens in`
                  : ""}
              </Field>
            </Fields>
            {trace.error ? (
              <p className="mt-2 whitespace-pre-wrap font-mono text-destructive">
                {trace.error}
              </p>
            ) : null}
          </>
        ) : null}
        {notes.length ? (
          <>
            <Heading>Steps</Heading>
            <ol className="list-decimal pl-5 text-muted-foreground">
              {notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ol>
          </>
        ) : null}
        {trace ? (
          // Named group: the outer chevron must not turn with this one.
          <details className="group/call mt-3">
            <summary className="flex cursor-pointer list-none items-baseline gap-1.5 font-medium [&::-webkit-details-marker]:hidden">
              <span
                aria-hidden
                className="inline-block w-2 text-muted-foreground transition-transform group-open/call:rotate-90"
              >
                ›
              </span>
              Prompt and response
            </summary>
            <div className="flex flex-col gap-2 pt-2">
              <Code content={trace.prompt} label="Prompt" />
              <Code
                content={trace.response ?? "No response."}
                label="Response"
              />
              {trace.reasoning ? (
                <Code content={trace.reasoning} label="Reasoning" />
              ) : null}
            </div>
          </details>
        ) : null}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => void copy()}
            title="Copies the preview, model call, composer state and activity as JSON"
            className={smallButton}
          >
            <Icon
              name={copied ? "Check" : "Copy"}
              aria-hidden
              className="size-3.5"
            />
            {copied ? "Copied" : "Copy diagnostics"}
          </button>
        </div>
      </div>
    </details>
  );
}
