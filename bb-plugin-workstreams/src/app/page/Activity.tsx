import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRpc,
  type PluginSidebarSection,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import {
  TRACE_KINDS,
  TRACE_KIND_TITLE,
  type TraceKind,
  type TraceSummary,
} from "../../domain/trace.ts";
import type { RpcContract } from "../../server/contract.ts";
import type { ProposalView } from "../../server/evolution.ts";
import type { JournalEntry as Entry } from "../../server/journal.ts";
import { InspectButton } from "../debug/InspectButton.tsx";
import { useDebugMode } from "../debug/debug.ts";
import { ghostButton, secondaryButton } from "./controls.ts";
import { CallRow } from "./CallRow.tsx";
import { ActivityTerm } from "./ActivityTerm.tsx";
import { ActivityThreadLink } from "./ActivityThreadLink.tsx";

const TRACE_PAGE = 100;

/** An entry with the debug traces of the model calls behind it. */
type JournalEntry = Entry & { traceIds?: string[] };

const ACTION_LABEL: Record<Entry["action"], string> = {
  move: "Move",
  "create-workstream": "New workstream",
  "rename-workstream": "Rename",
  "delete-workstream": "Delete",
  undo: "Undo",
  batch: "Reorganize",
  proposal: "Proposal",
  "edit-workstream": "Edit",
  route: "New work",
  retitle: "Updated title",
};

const ACTION_HELP: Record<Entry["action"], string> = {
  move: "A thread was moved to another workstream.",
  "create-workstream": "A workstream was created to group related threads.",
  "rename-workstream": "A workstream’s name was changed.",
  "delete-workstream": "A workstream was removed. Its threads are not deleted.",
  undo: "A previous Workstreams change was reversed.",
  batch: "Several organization changes were applied together.",
  proposal: "Workstreams suggested an organization change for your decision.",
  "edit-workstream": "A workstream’s description or settings were changed.",
  route: "A new request was placed in a thread and workstream.",
  retitle: "A thread title was updated to reflect its work.",
};
const ENTRY_STATUS: Record<
  Entry["status"],
  { label: string; description: string }
> = {
  applied: {
    label: "Applied",
    description:
      "This organization change was applied. It does not mean the thread’s work is complete.",
  },
  pending: {
    label: "Awaiting decision",
    description:
      "This proposed change has not been applied. It is waiting for your decision.",
  },
  partial: {
    label: "Partially applied",
    description:
      "Some parts of this change were applied; others could not be completed. Check the event details.",
  },
  failed: {
    label: "Failed",
    description:
      "This change could not be applied. Check the event details for the failure.",
  },
  undone: {
    label: "Undone",
    description: "This change was reversed by a later undo event.",
  },
  dismissed: {
    label: "Dismissed",
    description: "This proposal was declined without applying the change.",
  },
};

const SOURCE_LABEL: Record<Entry["source"], string> = {
  user: "you",
  external: "outside Workstreams",
  router: "router",
  handoff: "handoff",
  auto: "automatic",
  proposal: "proposal",
  bootstrap: "bootstrap",
};

function day(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** The action filter's value for model calls (Debug mode). */
const MODEL_CALLS = "model-call";

type Item =
  | { kind: "entry"; at: number; entry: JournalEntry }
  | { kind: "call"; at: number; trace: TraceSummary };

/**
 * The Activity log: every change Workstreams made or observed, and every
 * proposal (SPEC §11.5), with filters by workstream, action, and needs-review.
 * In Debug mode it also lists each model call in place, with what the model
 * decided (SPEC §11.6).
 */
export function Activity({
  rpc,
  proposals = [],
  focus = null,
  sections = [],
  workstreamOf,
}: {
  rpc: ReturnType<typeof useRpc<RpcContract>>;
  proposals?: readonly ProposalView[];
  /** A proposal id to review first (deep link from a banner). */
  focus?: string | null;
  sections?: readonly PluginSidebarSection[];
  /** A thread's workstream, for filtering model calls by workstream. */
  workstreamOf?: (threadId: string) => string | null;
}) {
  const debug = useDebugMode();
  const [external, setExternal] = useState(false);
  const [workstream, setWorkstream] = useState("");
  const [action, setAction] = useState("");
  const [needsReview, setNeedsReview] = useState(focus !== null);
  const [showCalls, setShowCalls] = useState(true);
  const [callKind, setCallKind] = useState<TraceKind | "">("");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [traceLimit, setTraceLimit] = useState(TRACE_PAGE);
  const [moreCalls, setMoreCalls] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const proposalOf = new Map(
    proposals.filter((p) => p.entryId).map((p) => [p.entryId!, p]),
  );
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [calls, setCalls] = useState<TraceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const load = useCallback(async () => {
    const generation = ++request.current;
    setError(null);
    const report = (cause: unknown) => {
      if (generation === request.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    };
    await Promise.all([
      rpc.call("journal", { limit: 300, external }).then((result) => {
        if (generation === request.current) setEntries(result.entries);
      }, report),
      (async () => {
        const traces: TraceSummary[] = [];
        let more = false;
        let before: { at: number; id: string } | undefined;
        // Refresh loaded history from the top so realtime updates cannot leave
        // duplicates or retained-but-deleted traces in older pages.
        if (debug) {
          do {
            const result = await rpc.call("traces", {
              limit: TRACE_PAGE,
              ...(callKind ? { kind: callKind } : {}),
              ...(before ? { before } : {}),
            });
            if (generation !== request.current) return;
            traces.push(...result.traces);
            more = result.traces.length === TRACE_PAGE;
            const last = result.traces.at(-1);
            before = last ? { at: last.at, id: last.id } : undefined;
          } while (more && traces.length < traceLimit);
        }
        if (generation === request.current) {
          setCalls(traces);
          setMoreCalls(more);
        }
      })().catch(report),
    ]);
  }, [rpc, external, debug, traceLimit, callKind]);
  useRealtime("changed", load);
  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [load]);

  const clearTraces = async () => {
    setClearing(true);
    setError(null);
    try {
      await rpc.call("traceClear", null);
      setConfirmClear(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setClearing(false);
    }
  };

  const undo = async (entry: JournalEntry) => {
    setError(null);
    try {
      await rpc.call("undo", { entryId: entry.id });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const decide = async (id: string, verdict: "accept" | "dismiss") => {
    setError(null);
    try {
      await rpc.call("proposal", { id, action: verdict });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const shownEntries = (entries ?? []).filter(
    (entry) =>
      !(debug && (action === MODEL_CALLS || failuresOnly || callKind)) &&
      (!workstream || entry.workstreams.some((w) => w.id === workstream)) &&
      (!action ||
        (!debug && action === MODEL_CALLS) ||
        entry.action === action) &&
      (!needsReview || entry.status === "pending"),
  );
  const shownCalls =
    debug && showCalls && !needsReview && (!action || action === MODEL_CALLS)
      ? calls.filter(
          (trace) =>
            (!callKind || trace.kind === callKind) &&
            (!failuresOnly || trace.status !== "ok") &&
            (!workstream ||
              trace.threads.some((id) => workstreamOf?.(id) === workstream)),
        )
      : [];
  const callCost = shownCalls.reduce((sum, t) => sum + (t.usage?.cost ?? 0), 0);
  const items: Item[] = [
    ...shownEntries.map((entry) => ({
      kind: "entry" as const,
      at: entry.at,
      entry,
    })),
    ...shownCalls.map((trace) => ({
      kind: "call" as const,
      at: trace.at,
      trace,
    })),
  ].sort((a, b) => b.at - a.at);
  const days: { label: string; items: Item[] }[] = [];
  for (const item of items) {
    const label = day(item.at);
    const last = days[days.length - 1];
    if (last?.label === label) last.items.push(item);
    else days.push({ label, items: [item] });
  }

  return (
    <div className="mt-5">
      <div
        role="group"
        aria-label="Activity filters"
        className="grid grid-cols-1 items-center gap-3 text-xs text-muted-foreground sm:flex sm:flex-wrap"
      >
        <select
          aria-label="Filter by workstream"
          value={workstream}
          onChange={(event) => setWorkstream(event.target.value)}
          className="h-7 rounded-md border border-input bg-transparent px-1"
        >
          <option value="">All workstreams</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by action"
          value={action}
          onChange={(event) => {
            setAction(event.target.value);
            setCallKind("");
            setFailuresOnly(false);
            if (event.target.value === MODEL_CALLS) {
              setShowCalls(true);
              setNeedsReview(false);
            }
          }}
          className="h-7 rounded-md border border-input bg-transparent px-1"
        >
          <option value="">All actions</option>
          {Object.entries(ACTION_LABEL).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
          {debug ? <option value={MODEL_CALLS}>Model calls</option> : null}
        </select>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={needsReview}
            onChange={(event) => {
              setNeedsReview(event.target.checked);
              if (event.target.checked) {
                setCallKind("");
                setFailuresOnly(false);
                if (action === MODEL_CALLS) setAction("");
              }
            }}
          />
          Needs review
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={external}
            onChange={(event) => setExternal(event.target.checked)}
          />
          Include changes made outside Workstreams
        </label>
        {debug ? (
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={showCalls}
              onChange={(event) => {
                setShowCalls(event.target.checked);
                if (!event.target.checked) {
                  setCallKind("");
                  setFailuresOnly(false);
                  if (action === MODEL_CALLS) setAction("");
                }
              }}
            />
            Model calls
          </label>
        ) : null}
      </div>
      {debug ? (
        <div className="mt-3 rounded-md border border-border bg-state-hover/30 p-3 text-xs text-muted-foreground">
          <ActivityTerm
            label="Debug events"
            description="AI assessments appear alongside applied changes. An assessment may suggest a change without applying it. Expand Technical details for measurements and the full prompt. Traces are kept for 7 days, up to 1,000 records."
          />
          <div className="mt-2 grid grid-cols-1 items-center gap-3 sm:flex sm:flex-wrap">
            <select
              aria-label="Filter by model call kind"
              value={callKind}
              onChange={(event) => {
                setCallKind(event.target.value as TraceKind | "");
                setTraceLimit(TRACE_PAGE);
                setShowCalls(true);
                setAction(MODEL_CALLS);
                setNeedsReview(false);
              }}
              className="h-7 rounded-md border border-input bg-transparent px-1"
            >
              <option value="">All model call kinds</option>
              {TRACE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {TRACE_KIND_TITLE[kind]}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={failuresOnly}
                onChange={(event) => {
                  setFailuresOnly(event.target.checked);
                  if (event.target.checked) {
                    setShowCalls(true);
                    setAction(MODEL_CALLS);
                    setNeedsReview(false);
                  }
                }}
              />
              Failures only
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
            <span className="tabular-nums">
              {shownCalls.length} model calls shown · ${callCost.toFixed(4)}
            </span>
            {confirmClear ? (
              <span className="flex items-center gap-1.5">
                Delete all model-call traces? Activity changes are kept.
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={clearing}
                  onClick={() => void clearTraces()}
                >
                  Delete traces
                </button>
                <button
                  type="button"
                  className={ghostButton}
                  disabled={clearing}
                  onClick={() => setConfirmClear(false)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                className={ghostButton}
                onClick={() => setConfirmClear(true)}
              >
                Clear traces…
              </button>
            )}
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {entries && items.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No activity yet.</p>
      ) : null}
      {days.map(({ label, items: list }) => (
        <section key={label} className="mt-4">
          <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
            {label}
          </h3>
          <ul className="divide-y divide-border">
            {list.map((item) => {
              if (item.kind === "call")
                return <CallRow key={item.trace.id} trace={item.trace} />;
              const { entry } = item;
              return (
                <li
                  key={entry.id}
                  className={cn(
                    "grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 py-3 pl-2 text-sm sm:gap-x-3 sm:grid-cols-[4.5rem_minmax(0,1fr)_auto]",
                    (entry.status === "undone" ||
                      entry.status === "dismissed") &&
                      "opacity-60",
                    focus !== null &&
                      proposalOf.get(entry.id)?.id === focus &&
                      "rounded-md bg-state-hover",
                  )}
                >
                  <time
                    className="w-16 shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
                    dateTime={new Date(entry.at).toISOString()}
                    title={new Date(entry.at).toLocaleString()}
                    aria-label={new Date(entry.at).toLocaleString()}
                  >
                    {new Date(entry.at).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <div className="col-start-2 row-start-1 min-w-0">
                    <div className="mb-1 text-xs text-muted-foreground">
                      <ActivityTerm
                        label={ACTION_LABEL[entry.action]}
                        description={ACTION_HELP[entry.action]}
                      />
                    </div>
                    <div className="break-words">
                      <span>{entry.rationale}</span>
                      {entry.threads.length ? (
                        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
                          {entry.threads.map((thread) => (
                            <ActivityThreadLink
                              key={thread.id}
                              threadId={thread.id}
                              fallback={thread.name}
                            />
                          ))}
                        </div>
                      ) : null}

                      {entry.detail ? (
                        <span className="block text-xs text-muted-foreground">
                          {entry.detail}
                        </span>
                      ) : null}
                      {debug ? (
                        <details className="mt-1 text-xs text-muted-foreground">
                          <summary className="w-fit cursor-pointer rounded hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                            Technical details
                          </summary>
                          {entry.traceIds?.length ? (
                            <div className="mt-2 flex items-center gap-1">
                              <span>Inspect supporting model calls</span>
                              <InspectButton
                                target={{
                                  link: { kind: "entry", ref: entry.id },
                                }}
                                title={`Model calls behind: ${entry.rationale}`}
                                label="Inspect the model calls behind this change"
                              />
                            </div>
                          ) : null}
                          <dl className="my-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                            <dt>Source</dt>
                            <dd>{SOURCE_LABEL[entry.source]}</dd>
                            <dt>Event ID</dt>
                            <dd className="break-all" translate="no">
                              {entry.id}
                            </dd>
                          </dl>
                          <details>
                            <summary className="cursor-pointer">
                              Raw event JSON
                            </summary>
                            <pre className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-state-hover p-2">
                              {JSON.stringify(entry, null, 2)}
                            </pre>
                          </details>
                        </details>
                      ) : null}
                    </div>
                  </div>
                  <span className="col-start-2 mt-1 flex flex-wrap items-center gap-2 border-t border-border pt-1 text-xs sm:col-start-3 sm:row-start-1 sm:mt-0 sm:border-0 sm:pt-0 sm:flex-col sm:items-end">
                    <span className="text-muted-foreground">Change status</span>
                    <span
                      className={cn(
                        "text-muted-foreground",
                        (entry.status === "failed" ||
                          entry.status === "partial") &&
                          "text-destructive",
                      )}
                    >
                      <ActivityTerm {...ENTRY_STATUS[entry.status]} />
                    </span>
                    {entry.status === "pending" && proposalOf.get(entry.id) ? (
                      <span className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            void decide(proposalOf.get(entry.id)!.id, "accept")
                          }
                          className="text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          {proposalOf.get(entry.id)!.accept}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void decide(proposalOf.get(entry.id)!.id, "dismiss")
                          }
                          className="text-muted-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          Not now
                        </button>
                      </span>
                    ) : entry.undo && entry.status === "applied" ? (
                      <button
                        type="button"
                        onClick={() => void undo(entry)}
                        className="text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        Undo
                      </button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {debug &&
      showCalls &&
      !needsReview &&
      (!action || action === MODEL_CALLS) &&
      moreCalls ? (
        <button
          type="button"
          className={cn(secondaryButton, "mt-3")}
          onClick={() => setTraceLimit((limit) => limit + TRACE_PAGE)}
        >
          Load older model calls
        </button>
      ) : null}
    </div>
  );
}
