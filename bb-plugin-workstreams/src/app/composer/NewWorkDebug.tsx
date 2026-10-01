/**
 * New work's Debug section (SPEC §11.6): a collapsed disclosure under the
 * composer that explains the suggestion. It shows why the suggestion is or
 * isn't showing, the decision the server returned with the server's own
 * step-by-step notes, the recorded model call behind it (prompt, structured
 * input, reasoning, raw response, parsed result), the dialog's state, and
 * every classification, acceptance and submit with its inputs and result.
 */
import { useState, useSyncExternalStore } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { RpcContract } from "../../server/contract.ts";
import type { RouteDecision } from "../../server/router.ts";
import {
  Code,
  Section,
  TraceDetail,
  json,
  smallButton,
} from "../debug/Inspector.tsx";
import {
  suggestionVisibility,
  type NewWork,
  type NewWorkEvent,
  type NewWorkState,
} from "./new-work.ts";
import { useProjects } from "./Suggestion.tsx";

const STATUS_CLASS: Record<NewWorkEvent["status"], string> = {
  pending: "text-muted-foreground",
  ok: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  superseded: "text-muted-foreground line-through",
};

const clip = (text: string, max = 60) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function decisionTarget(decision: RouteDecision): string {
  switch (decision.outcome) {
    case "continue":
      return `continue “${decision.threadTitle}”`;
    case "new-thread":
      return decision.workstream
        ? `new thread in ${decision.workstream}`
        : "new thread without a workstream";
    case "new-workstream":
      return `new workstream “${decision.name}”`;
    case "unsure":
      return `unsure (${decision.candidates.length} candidates)`;
  }
}

/** A one-line description of an event for its row. */
function eventLine(event: NewWorkEvent): string {
  const input = event.input as Record<string, unknown> | null;
  const output = event.output as Record<string, unknown> | null;
  switch (event.kind) {
    case "classify": {
      const decision = output?.decision as RouteDecision | undefined;
      const prompt = clip(String(input?.prompt ?? ""), 40);
      return decision
        ? `“${prompt}” → ${decisionTarget(decision)}`
        : `“${prompt}”`;
    }
    case "accept": {
      const suggestion = input?.suggestion as
        { kind: string; title?: string; name?: string } | undefined;
      return `${suggestion?.kind ?? "suggestion"}: ${suggestion?.title ?? suggestion?.name ?? ""}`;
    }
    case "dismiss":
      return "the suggestion";
    case "select-workstream": {
      const to = input?.to as { name: string } | null | undefined;
      return to ? to.name : "No workstream";
    }
    case "create-workstream":
      return String(input?.name ?? "");
    case "submit":
      return input?.sendTo
        ? `send to ${String(input.sendTo)}`
        : `start a thread in ${input?.startIn ? String(input.startIn) : "no workstream"}`;
  }
}

function EventRow({ event }: { event: NewWorkEvent }) {
  return (
    <li className="rounded-md border border-border">
      <details className="group/event">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-xs [&::-webkit-details-marker]:hidden">
          <span
            aria-hidden
            className="inline-block text-muted-foreground transition-transform group-open/event:rotate-90"
          >
            ›
          </span>
          <time
            dateTime={new Date(event.at).toISOString()}
            className="shrink-0 tabular-nums text-muted-foreground"
          >
            {new Date(event.at).toLocaleTimeString()}
          </time>
          <span className="shrink-0 font-medium">{event.kind}</span>
          <span className={cn("shrink-0", STATUS_CLASS[event.status])}>
            {event.status}
          </span>
          {event.durationMs !== null ? (
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {event.durationMs < 1000
                ? `${event.durationMs}ms`
                : `${(event.durationMs / 1000).toFixed(1)}s`}
            </span>
          ) : null}
          <span className="min-w-0 truncate text-muted-foreground">
            {eventLine(event)}
          </span>
        </summary>
        <div className="flex flex-col gap-2 px-2.5 pb-2.5">
          {event.error ? (
            <p className="whitespace-pre-wrap font-mono text-xs text-destructive">
              {event.error}
            </p>
          ) : null}
          <Code content={json(event.input)} label="Input" />
          {event.output !== null ? (
            <Code content={json(event.output)} label="Output" />
          ) : null}
        </div>
      </details>
    </li>
  );
}

function SuggestionSection({ state }: { state: NewWorkState }) {
  const { decision } = state;
  const projects = useProjects();
  const notes = decision?.explanation?.notes ?? [];
  return (
    <Section title="Suggestion" hint={suggestionVisibility(state)} open>
      {decision ? (
        <div className="flex flex-col gap-2 text-xs">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
            <dt className="text-muted-foreground">Decision</dt>
            <dd>{decisionTarget(decision)}</dd>
            <dt className="text-muted-foreground">Confidence</dt>
            <dd>{decision.confidence}</dd>
            <dt className="text-muted-foreground">Reason</dt>
            <dd>{decision.reason || "—"}</dd>
            <dt className="text-muted-foreground">Subject</dt>
            <dd>{decision.subject ?? "—"}</dd>
            {"placement" in decision ? (
              <>
                <dt className="text-muted-foreground">Placement</dt>
                <dd>
                  {decision.placement
                    ? `${projects.get(decision.placement.projectId)?.name ?? decision.placement.projectId} · ${decision.placement.label}`
                    : "none: the pickers' project stays"}
                </dd>
              </>
            ) : null}
            {decision.explanation ? (
              <>
                <dt className="text-muted-foreground">Routed in</dt>
                <dd>{(decision.explanation.durationMs / 1000).toFixed(1)}s</dd>
              </>
            ) : null}
          </dl>
          {notes.length ? (
            <div>
              <p className="mb-1 font-medium">How Workstreams got there</p>
              <ol className="list-decimal pl-5 text-muted-foreground">
                {notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ol>
            </div>
          ) : null}
          {/* Named group: a nested Section would turn with its parent's chevron. */}
          <details className="group/raw">
            <summary className="flex cursor-pointer list-none items-baseline gap-1.5 py-1 [&::-webkit-details-marker]:hidden">
              <span
                aria-hidden
                className="inline-block w-2 text-muted-foreground transition-transform group-open/raw:rotate-90"
              >
                ›
              </span>
              <span className="font-medium">Raw decision</span>
              <span className="text-muted-foreground">
                As the server returned it
              </span>
            </summary>
            <div className="pt-1">
              <Code content={json(decision)} label="Decision" />
            </div>
          </details>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No classification has finished for this draft yet.
        </p>
      )}
    </Section>
  );
}

export function NewWorkDebug({
  newWork,
  onClose,
}: {
  newWork: NewWork;
  /** Closes the dialog, as following a thread link from the model call does. */
  onClose: () => void;
}) {
  const rpc = useRpc<RpcContract>();
  const state = useSyncExternalStore(newWork.subscribe, newWork.snapshot);
  const [copied, setCopied] = useState(false);
  const traceId = state.decision?.traceId ?? null;
  const copy = async () => {
    const { events, ...rest } = state;
    try {
      await navigator.clipboard.writeText(json({ state: rest, events }));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the sections still show everything.
    }
  };
  return (
    <details className="ws-new-work-debug group/debug mt-3 rounded-lg border border-dashed border-border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <Icon name="Bug" aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium">Debug</span>
        <span className="min-w-0 flex-1 truncate">
          {suggestionVisibility(state)}
        </span>
        <span className="shrink-0">
          {state.events.length} event{state.events.length === 1 ? "" : "s"}
        </span>
        <span
          aria-hidden
          className="inline-block transition-transform group-open/debug:rotate-90"
        >
          ›
        </span>
      </summary>
      <div className="max-h-[50vh] overflow-y-auto border-t border-dashed border-border px-3 pb-3 pt-2">
        <div className="mb-1 flex justify-end">
          <button
            type="button"
            onClick={() => void copy()}
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
        <SuggestionSection state={state} />
        <Section
          title="Model call"
          hint={
            traceId
              ? "Prompt, input, reasoning and raw response"
              : "None recorded"
          }
        >
          {traceId ? (
            <div className="[&>article]:px-0 [&>article]:pb-2 [&>article]:pt-0">
              <TraceDetail
                key={traceId}
                rpc={rpc}
                id={traceId}
                close={onClose}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {state.decision
                ? "The router decided without a model call (a mention or a chosen workstream), or Debug mode was off when it ran."
                : "No classification has finished yet."}
            </p>
          )}
        </Section>
        <Section title="Dialog state" hint="The fields New work submits with">
          <Code
            label="Dialog state"
            content={json({
              text: state.text,
              workstream: state.workstream,
              composerSelection: state.selection,
              suggestion: state.suggestion,
              settledSuggestion: state.settled,
              classifying: state.classifying,
              accepting: state.accepting,
              error: state.error,
            })}
          />
        </Section>
        <Section
          title="Activity"
          hint={`${state.events.length} event${state.events.length === 1 ? "" : "s"}, newest first`}
        >
          {state.events.length ? (
            <ul className="flex flex-col gap-1.5">
              {[...state.events].reverse().map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Nothing yet.</p>
          )}
        </Section>
      </div>
    </details>
  );
}
