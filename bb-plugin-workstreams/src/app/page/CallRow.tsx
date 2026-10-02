import { cn } from "@/lib/utils";
import {
  TRACE_KIND_TITLE,
  type TraceKind,
  type TraceSummary,
} from "../../domain/trace.ts";
import { InspectButton } from "../debug/InspectButton.tsx";
import { ActivityTerm } from "./ActivityTerm.tsx";
import { ActivityThreadLink } from "./ActivityThreadLink.tsx";

const EVENT: Record<TraceKind, { label: string; description: string }> = {
  classify: {
    label: "Subject classification",
    description:
      "Identifies a product or feature independently of active navigation.",
  },
  regroup: {
    label: "Active grouping preview",
    description:
      "Proposes active identities from concurrent subject counts. Apply remains a separate user action.",
  },
  analysis: {
    label: "Thread assessment",
    description:
      "The model assessed this thread’s progress, workstream, and possible follow-ups. This is an assessment, not proof that a change was applied.",
  },
  route: {
    label: "Destination selection",
    description:
      "The model classified a request against the applied map or left its destination undecided.",
  },
  organize: {
    label: "Organization preview",
    description:
      "One pass proposed the whole map and thread placements. Apply is a separate user action.",
  },
};
const STATES: Record<string, { label: string; description: string }> = {
  review: {
    label: "Ready for your review",
    description:
      "A deliverable is ready for you to review, test, merge, or ship.",
  },
  "needs decision": {
    label: "Needs your decision",
    description:
      "The model found a specific question, choice, permission request, or next step that only you can resolve.",
  },
  blocked: {
    label: "Blocked",
    description:
      "The model judged that work is waiting on something other than your input.",
  },
  "in progress": {
    label: "In progress",
    description:
      "The model judged that the request still has outstanding work. This does not mean an agent is currently running.",
  },
  done: {
    label: "Done",
    description:
      "The model judged that the latest request is complete with no outstanding tasks. This is an assessment, not independent verification.",
  },
};

function CallResult({ trace }: { trace: TraceSummary }) {
  if (trace.status !== "ok")
    return (
      <div className="mt-1 text-xs text-destructive">
        <ActivityTerm
          label={
            trace.status === "invalid"
              ? "Response not usable"
              : "Model call failed"
          }
          description={
            trace.status === "invalid"
              ? "The model responded, but its output could not be validated. Workstreams did not use the result."
              : "The request to the model failed before producing a usable result."
          }
        />
        {trace.error ? <p className="mt-1 break-words">{trace.error}</p> : null}
      </div>
    );
  if (!trace.summary)
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        Completed · No result summary recorded
      </p>
    );
  // Analysis summaries start with a known lifecycle label. Unknown formats
  // stay intact under Model result rather than being interpreted as a new state.
  const [state, ...parts] = trace.summary.split(" · ");
  const lifecycle = trace.kind === "analysis" ? STATES[state!] : undefined;
  const suggestions = parts.filter(
    (part) => part.startsWith("drift → ") || part.startsWith("new title "),
  );
  const subject = parts
    .filter((part) => !suggestions.includes(part))
    .join(" · ");
  if (!lifecycle)
    return (
      <p className="mt-1 break-words text-xs">
        <span className="text-muted-foreground">Model result: </span>
        {trace.summary.replace(/(^| · )new: /g, "$1New workstream: ")}
      </p>
    );
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <span>
        <span className="text-muted-foreground">Work status: </span>
        <ActivityTerm {...lifecycle} />
      </span>
      {subject ? (
        <span className="break-words">
          <span className="text-muted-foreground">Subject: </span>
          {subject}
        </span>
      ) : null}
      {suggestions.length ? (
        <p className="w-full break-words">
          <span className="text-muted-foreground">Suggestions: </span>
          {suggestions
            .join(" · ")
            .replace(/drift → /g, "Different workstream: ")
            .replace(/new title /g, "Title: ")}
        </p>
      ) : null}
    </div>
  );
}

export function CallRow({ trace }: { trace: TraceSummary }) {
  const event = EVENT[trace.kind];
  return (
    <li
      className={cn(
        "grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 rounded-md bg-state-hover/30 py-3 pl-2 pr-2 text-sm sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-3",
        trace.status !== "ok" && "bg-destructive/5",
      )}
    >
      <time
        className="pt-0.5 text-xs tabular-nums text-muted-foreground"
        dateTime={new Date(trace.at).toISOString()}
        title={new Date(trace.at).toLocaleString()}
        aria-label={new Date(trace.at).toLocaleString()}
      >
        {new Date(trace.at).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </time>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground">
          <ActivityTerm {...event} />
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px]">
            Model
          </span>
          {trace.replayOf ? (
            <ActivityTerm
              label="Replay"
              description="The recorded prompt was run again for comparison. A replay does not change Workstreams state."
            />
          ) : null}
        </div>
        <div className="mt-1 break-words font-medium text-foreground">
          {trace.label === TRACE_KIND_TITLE[trace.kind] ? (
            <span className="font-normal text-muted-foreground">
              No specific subject recorded
            </span>
          ) : (
            trace.label
          )}
        </div>
        <CallResult trace={trace} />
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer rounded hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            Technical details
          </summary>
          <dl className="mt-2 grid grid-cols-1 gap-y-1 rounded-md bg-state-hover/40 p-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-4">
            <dt>Model</dt>
            <dd className="break-all" translate="no">
              {trace.model}
            </dd>
            <dt>Duration</dt>
            <dd className="tabular-nums">
              {(trace.durationMs / 1000).toFixed(1)} seconds
            </dd>
            <dt>
              <ActivityTerm
                label="Input tokens"
                description="Units of text sent to the model, including the prompt and context. Token counts measure model usage, not words."
              />
            </dt>
            <dd className="tabular-nums">
              {trace.usage
                ? trace.usage.input.toLocaleString()
                : "Not reported"}
            </dd>
            <dt>
              <ActivityTerm
                label="Output tokens"
                description="Units of text generated by the model in its response."
              />
            </dt>
            <dd className="tabular-nums">
              {trace.usage
                ? trace.usage.output.toLocaleString()
                : "Not reported"}
            </dd>
            <dt>Reported cost</dt>
            <dd className="tabular-nums">
              {trace.usage
                ? new Intl.NumberFormat(undefined, {
                    style: "currency",
                    currency: "USD",
                    minimumFractionDigits: 4,
                  }).format(trace.usage.cost)
                : "Not reported"}
            </dd>
          </dl>
          {trace.threads.length ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span>Related threads:</span>
              {trace.threads.map((id) => (
                <ActivityThreadLink key={id} threadId={id} />
              ))}
            </div>
          ) : null}
          <div className="mt-2 flex items-center gap-1">
            <span>Inspect prompt &amp; response</span>
            <InspectButton
              target={{ traceIds: [trace.id] }}
              title={`${TRACE_KIND_TITLE[trace.kind]}: ${trace.label}`}
              label="Inspect this model call"
            />
          </div>
        </details>
      </div>
    </li>
  );
}
