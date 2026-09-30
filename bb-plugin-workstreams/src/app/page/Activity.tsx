import { useCallback, useEffect, useRef, useState } from "react";
import {
  ThreadTitle,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginSidebarSection,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  TRACE_KINDS,
  TRACE_KIND_SHORT,
  TRACE_KIND_TITLE,
  TRACE_STATUS_TITLE,
  type TraceKind,
  type TraceSummary,
} from "../../domain/trace.ts";
import type { RpcContract } from "../../server/contract.ts";
import type { ProposalView } from "../../server/evolution.ts";
import type { JournalEntry as Entry } from "../../server/journal.ts";
import { InspectButton } from "../debug/InspectButton.tsx";
import { useDebugMode } from "../debug/debug.ts";
import { ghostButton, secondaryButton } from "./controls.ts";

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
  retitle: "Retitle",
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
  const navigate = useBbNavigate();
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
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
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
        <div className="mt-3 rounded-md border border-dashed border-border bg-state-hover/30 p-3 text-xs text-muted-foreground">
          <p className="flex items-center gap-1.5">
            <Icon name="Bug" aria-hidden className="size-3" />
            Debug mode: internal model calls appear alongside changes, even when
            they made no change. Inspect a call for prompts, responses, results,
            and replay. Traces are kept for 7 days (up to 1,000).
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
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
            <span className="flex-1" />
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
                    "flex items-baseline gap-3 py-1.5 text-sm",
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
                  >
                    {new Date(entry.at).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <span className="w-28 shrink-0 text-xs text-muted-foreground">
                    {ACTION_LABEL[entry.action]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span>{entry.rationale}</span>
                    {entry.threads.map((thread) => (
                      <button
                        key={thread.id}
                        type="button"
                        onClick={() => navigate.toThread(thread.id)}
                        className="ml-2 max-w-64 truncate align-bottom text-xs text-primary hover:underline"
                      >
                        {thread.name}
                      </button>
                    ))}
                    {entry.traceIds?.length ? (
                      <InspectButton
                        target={{ link: { kind: "entry", ref: entry.id } }}
                        title={`Model calls behind: ${entry.rationale}`}
                        label="Inspect the model calls behind this change"
                        className="ml-1 align-middle text-muted-foreground"
                      />
                    ) : null}
                    {entry.detail ? (
                      <span className="block text-xs text-muted-foreground">
                        {entry.detail}
                      </span>
                    ) : null}
                    {debug ? (
                      <details className="mt-1 text-xs text-muted-foreground">
                        <summary className="cursor-pointer">
                          Internal event details
                        </summary>
                        <pre className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-state-hover p-2">
                          {JSON.stringify(entry, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {SOURCE_LABEL[entry.source]}
                  </span>
                  <span className="w-24 shrink-0 text-right text-xs">
                    {entry.status === "pending" && proposalOf.get(entry.id) ? (
                      <span className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            void decide(proposalOf.get(entry.id)!.id, "accept")
                          }
                          className="text-primary hover:underline"
                        >
                          {proposalOf.get(entry.id)!.accept}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void decide(proposalOf.get(entry.id)!.id, "dismiss")
                          }
                          className="text-muted-foreground hover:underline"
                        >
                          Not now
                        </button>
                      </span>
                    ) : entry.status === "pending" ? (
                      <span className="text-muted-foreground">pending</span>
                    ) : entry.status === "dismissed" ? (
                      <span className="text-muted-foreground">dismissed</span>
                    ) : entry.status === "undone" ? (
                      <span className="text-muted-foreground">undone</span>
                    ) : entry.undo ? (
                      <button
                        type="button"
                        onClick={() => void undo(entry)}
                        className="text-primary hover:underline"
                      >
                        Undo
                      </button>
                    ) : entry.status === "partial" ? (
                      <span className="text-muted-foreground">partial</span>
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

/**
 * A model call in the log (Debug mode): what it was about, what the model
 * decided, and the inspector. Muted, so the changes still stand out.
 */
function CallRow({ trace }: { trace: TraceSummary }) {
  const navigate = useBbNavigate();
  const ok = trace.status === "ok";
  // An analysis is labeled with its thread's title already.
  const threads = trace.kind === "analysis" ? [] : trace.threads.slice(0, 3);
  return (
    <li className="flex items-baseline gap-3 border-l-2 border-dashed border-border bg-state-hover/30 pl-2 py-1.5 text-sm text-muted-foreground">
      <time
        className="w-16 shrink-0 whitespace-nowrap text-xs tabular-nums"
        dateTime={new Date(trace.at).toISOString()}
        title={new Date(trace.at).toLocaleString()}
      >
        {new Date(trace.at).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </time>
      <span
        className="flex w-28 shrink-0 items-center gap-1 text-xs"
        title={TRACE_KIND_TITLE[trace.kind]}
      >
        <Icon name="Bug" aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{TRACE_KIND_SHORT[trace.kind]}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span>{trace.label}</span>
        {threads.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => navigate.toThread(id)}
            className="ml-2 max-w-64 truncate align-bottom text-xs text-primary hover:underline"
          >
            <ThreadTitle threadId={id} />
          </button>
        ))}
        <InspectButton
          target={{ traceIds: [trace.id] }}
          title={`${TRACE_KIND_TITLE[trace.kind]}: ${trace.label}`}
          label="Inspect this model call"
          className="ml-1 align-middle"
        />
        {ok && trace.summary ? (
          <span className="block text-xs">{trace.summary}</span>
        ) : null}
        <span className="block text-xs tabular-nums">
          Internal · {trace.model} · {(trace.durationMs / 1000).toFixed(1)}s
          {trace.usage
            ? ` · ${trace.usage.input} in / ${trace.usage.output} out · $${trace.usage.cost.toFixed(4)}`
            : ""}
          {trace.replayOf ? " · Replay" : ""}
        </span>
        {!ok && trace.error ? (
          <span className="block truncate text-xs text-destructive">
            {trace.error}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-xs">model</span>
      <span
        className={cn(
          "w-24 shrink-0 text-right text-xs tabular-nums",
          !ok && "font-medium text-destructive",
        )}
      >
        {ok
          ? `${(trace.durationMs / 1000).toFixed(1)}s`
          : TRACE_STATUS_TITLE[trace.status]}
      </span>
    </li>
  );
}
