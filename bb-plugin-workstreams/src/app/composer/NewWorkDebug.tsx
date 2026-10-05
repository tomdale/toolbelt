/**
 * New work's Debug section (SPEC §11.6): a collapsed disclosure under the
 * composer with what it takes to judge a suggestion: the result and its
 * placement, the model's reason, the inputs the model was given, the
 * server's notes on each deterministic step, and the exact prompt and raw
 * response. Copy diagnostics adds New work's state and activity log.
 */
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import type { RouteInput } from "../../domain/router.ts";
import type { Trace } from "../../domain/trace.ts";
import type { RpcContract } from "../../server/contract.ts";
import type { Placement, RouteDecision } from "../../server/router.ts";
import { Code, json, smallButton } from "../debug/Inspector.tsx";
import { suggestionVisibility, type NewWork } from "./new-work.ts";
import { useProjects } from "./Suggestion.tsx";

/** The model sees only this many threads (see `routePrompt`). */
const OFFERED_THREADS = 30;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function decisionTarget(decision: RouteDecision): string {
  switch (decision.outcome) {
    case "continue":
      return `Continue “${decision.threadTitle}”`;
    case "new-thread":
      return decision.workstream
        ? `New thread in ${decision.workstream}`
        : "New thread without a workstream";
    case "new-workstream":
      return `New workstream “${decision.name}”`;
    case "unsure":
      return `Unsure (${plural(decision.candidates.length, "candidate")})`;
  }
}

function placementText(
  placement: Placement | null,
  projects: ReturnType<typeof useProjects>,
): string {
  if (!placement) return "None: the Project picker stays as it is";
  const project = projects.get(placement.projectId);
  const name = !project
    ? placement.projectId
    : project.personal
      ? `${project.name} (shown as No project)`
      : project.name;
  return `${name} · ${placement.label}`;
}

function projectHint(hosts: readonly string[] | null | undefined): string {
  if (!hosts) return "None";
  return hosts.length
    ? `Picked project hosts ${hosts.join(", ")}`
    : "Picked project hosts no workstream";
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
  const navigate = useBbNavigate();
  const projects = useProjects();
  const { decision } = state;
  const traceId = decision?.traceId ?? null;
  const loaded = useTrace(traceId);
  const trace = loaded?.trace ?? null;
  const input = (trace?.input ?? null) as Partial<RouteInput> | null;
  const notes = decision?.explanation?.notes ?? [];
  const [copied, setCopied] = useState(false);
  const [flagging, setFlagging] = useState(false);
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
  const visibility = suggestionVisibility(state);
  const flagResult = async () => {
    if (!decision || flagging) return;
    setFlagging(true);
    try {
      const result = await rpc.call("flagRoute", {
        diagnostics: json({
          decision,
          trace,
          traceError: loaded?.error ?? null,
          dialog: state,
          events: state.events,
        }),
        projectId: state.selection?.projectId ?? null,
      });
      navigate.toThread(result.threadId);
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Couldn't report the result.",
      );
    } finally {
      setFlagging(false);
    }
  };
  return (
    <details className="ws-new-work-debug group/debug mt-3 rounded-lg border border-dashed border-border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <Icon name="Bug" aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium">Debug</span>
        <span className="min-w-0 flex-1 truncate">
          {decision
            ? `${decisionTarget(decision)} · ${visibility}`
            : visibility}
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
              {"placement" in decision ? (
                <Field label="Project">
                  {placementText(decision.placement, projects)}
                </Field>
              ) : null}
              <Field label="Reason">{decision.reason || "—"}</Field>
              <Field label="Suggestion">{visibility}</Field>
            </Fields>
          </>
        ) : (
          <p className="text-muted-foreground">
            No classification has finished for this draft yet.
          </p>
        )}
        {decision && !traceId ? (
          <p className="mt-3 text-muted-foreground">
            No model call was recorded: the router decided without one, or Debug
            mode was off when it ran.
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
                “{clip(input?.prompt ?? trace.label, 160)}”
              </Field>
              <Field label="Workstream">
                {input?.selectedWorkstream ?? "None selected"}
              </Field>
              <Field label="Project hint">
                {projectHint(input?.pickedProjectHosts)}
              </Field>
              <Field label="Offered">
                {plural(input?.workstreams?.length ?? 0, "workstream")} ·{" "}
                {plural(
                  Math.min(input?.threads?.length ?? 0, OFFERED_THREADS),
                  "thread",
                )}
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
          {decision ? (
            <button
              type="button"
              onClick={() => void flagResult()}
              disabled={flagging || (!!traceId && !loaded)}
              title="Creates a triage thread in the Workstreams workstream with this decision and its diagnostics"
              className={smallButton}
            >
              <Icon
                name={flagging ? "Spinner" : "Bug"}
                aria-hidden
                className={`size-3.5 ${flagging ? "animate-spin" : ""}`}
              />
              {flagging ? "Creating report…" : "Flag inaccurate result"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void copy()}
            title="Copies the decision, model call, New work state and activity as JSON"
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
