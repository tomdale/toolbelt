import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ThreadTitle,
  useBbNavigate,
  useRealtime,
  type useRpc,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import "./understanding.css";
import type { RpcContract } from "../../server/contract.ts";
import type {
  AccountDetail,
  Belief,
  DebugOverview,
  Evidence,
  ObservationDetail,
  RetrievalReport,
  RetrievalSnapshot,
} from "../../domain/understanding-debug.ts";
import { TraceInspector } from "../debug/Inspector.tsx";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;
type View = "accounts" | "evidence" | "retrieval" | "decisions" | "health";
type Selection = { kind: "account" | "evidence"; id: string } | null;

const VIEWS: { id: View; label: string; step: string }[] = [
  { id: "accounts", label: "Accounts", step: "03" },
  { id: "evidence", label: "Evidence", step: "02" },
  { id: "retrieval", label: "Retrieval lab", step: "04" },
  { id: "decisions", label: "Decisions", step: "05" },
  { id: "health", label: "Collection health", step: "01" },
];

const roleLabel: Record<Evidence["epistemic"], string> = {
  explicit: "Explicit",
  intention: "Intention",
  reported_outcome: "Reported outcome",
  inference: "Inference",
};
const dispositionLabel: Record<string, string> = {
  included: "Included",
  budget: "Budget excluded",
  limit: "Limit excluded",
  "missing-evidence": "Missing evidence",
  covered: "Covered by another candidate",
};
const stamp = (at: number | null) =>
  at === null ? "Date unknown" : new Date(at).toLocaleString();
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export function Understanding({
  rpc,
  subPath = "understanding",
}: {
  rpc: Rpc;
  subPath?: string;
}) {
  const parts = subPath.split("/").filter(Boolean);
  const validView = VIEWS.some((view) => view.id === parts[1]);
  const linkedView = validView ? (parts[1] as View) : "accounts";
  const rawLinkedId = validView ? parts[2] : parts[1];
  let linkedId: string | undefined;
  try {
    linkedId = rawLinkedId ? decodeURIComponent(rawLinkedId) : undefined;
  } catch {
    linkedId = rawLinkedId;
  }
  const [view, setView] = useState<View>(linkedView);
  const [selection, setSelection] = useState<Selection>(() =>
    linkedId && (linkedView === "accounts" || linkedView === "evidence")
      ? {
          kind: linkedView === "accounts" ? "account" : "evidence",
          id: linkedId,
        }
      : null,
  );
  const [query, setQuery] = useState("");
  const [overview, setOverview] = useState<DebugOverview | null>(null);
  const [overviewMoreLoading, setOverviewMoreLoading] = useState(false);
  const [overviewMoreKind, setOverviewMoreKind] = useState<
    "accounts" | "observations" | "progress" | null
  >(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [account, setAccount] = useState<AccountDetail | null>(null);
  const [observation, setObservation] = useState<ObservationDetail | null>(
    null,
  );
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [revisionLoading, setRevisionLoading] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [budget, setBudget] = useState(3000);
  const [report, setReport] = useState<RetrievalReport | null>(null);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);
  const [retrievalLoading, setRetrievalLoading] = useState(false);
  const [retrievals, setRetrievals] = useState<RetrievalSnapshot[] | null>(
    null,
  );
  const [retrievalsError, setRetrievalsError] = useState<string | null>(null);
  const [retrievalsMoreLoading, setRetrievalsMoreLoading] = useState(false);
  const [retrievalsHasMore, setRetrievalsHasMore] = useState(false);
  const [traceIds, setTraceIds] = useState<string[]>([]);
  const [traceTitle, setTraceTitle] = useState("");
  const overviewGeneration = useRef(0);
  const overviewOffsets = useRef({ accounts: 0, observations: 0, progress: 0 });
  const detailGeneration = useRef(0);
  const retrievalGeneration = useRef(0);
  const snapshotsGeneration = useRef(0);
  const snapshotsBefore = useRef<{ at: number; id: string } | undefined>(
    undefined,
  );
  const loadOverview = useCallback(async () => {
    const generation = ++overviewGeneration.current;
    overviewOffsets.current = { accounts: 0, observations: 0, progress: 0 };
    setOverviewLoading(true);
    setOverviewError(null);
    try {
      const trimmed = query.trim();
      const result = await rpc.call("understandingOverview", {
        ...(trimmed ? { query: trimmed } : {}),
        offset: 0,
        limit: 80,
      });
      if (generation === overviewGeneration.current) setOverview(result);
    } catch (cause) {
      if (generation === overviewGeneration.current)
        setOverviewError(errorText(cause));
    } finally {
      if (generation === overviewGeneration.current) setOverviewLoading(false);
    }
  }, [rpc, query]);

  const loadMoreOverview = useCallback(
    async (kind: "accounts" | "observations" | "progress") => {
      const offset = overviewOffsets.current[kind] + 80;
      const generation = ++overviewGeneration.current;
      setOverviewMoreLoading(true);
      setOverviewMoreKind(kind);
      setOverviewError(null);
      try {
        const trimmed = query.trim();
        const next = await rpc.call("understandingOverview", {
          ...(trimmed ? { query: trimmed } : {}),
          offset,
          limit: 80,
        });
        if (generation !== overviewGeneration.current) return;
        setOverview((current) => {
          if (!current) return next;
          if (kind === "accounts")
            return {
              ...next,
              accounts: [...current.accounts, ...next.accounts],
              hasMoreObservations: current.hasMoreObservations,
              hasMoreProgress: current.hasMoreProgress,
            };
          if (kind === "observations")
            return {
              ...next,
              observations: [...current.observations, ...next.observations],
              hasMoreAccounts: current.hasMoreAccounts,
              hasMoreProgress: current.hasMoreProgress,
            };
          return {
            ...next,
            progress: [...current.progress, ...next.progress],
            hasMoreAccounts: current.hasMoreAccounts,
            hasMoreObservations: current.hasMoreObservations,
          };
        });
        overviewOffsets.current[kind] = offset;
      } catch (cause) {
        if (generation === overviewGeneration.current)
          setOverviewError(errorText(cause));
      } finally {
        if (generation === overviewGeneration.current) {
          setOverviewMoreLoading(false);
          setOverviewMoreKind(null);
        }
      }
    },
    [rpc, query],
  );

  useEffect(() => {
    void loadOverview();
    return () => {
      overviewGeneration.current++;
    };
  }, [loadOverview]);
  const loadDetail = useCallback(async () => {
    if (!selection) return;
    const generation = ++detailGeneration.current;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const result =
        selection.kind === "account"
          ? await rpc.call("understandingAccount", { id: selection.id })
          : await rpc.call("understandingObservation", { id: selection.id });
      if (generation !== detailGeneration.current) return;
      if (selection.kind === "account") {
        setAccount(result as AccountDetail);
        setObservation(null);
      } else {
        setObservation(result as ObservationDetail);
        setAccount(null);
      }
    } catch (cause) {
      if (generation === detailGeneration.current)
        setDetailError(errorText(cause));
    } finally {
      if (generation === detailGeneration.current) setDetailLoading(false);
    }
  }, [rpc, selection]);

  const loadMoreRevisions = useCallback(async () => {
    if (selection?.kind !== "account" || !account?.revisions.length) return;
    const generation = ++detailGeneration.current;
    const before = account.revisions[account.revisions.length - 1]!.at;
    setRevisionLoading(true);
    setRevisionError(null);
    try {
      const next = await rpc.call("understandingAccount", {
        id: selection.id,
        before,
      });
      if (generation !== detailGeneration.current) return;
      setAccount((current) =>
        current
          ? { ...next, revisions: [...current.revisions, ...next.revisions] }
          : next,
      );
    } catch (cause) {
      if (generation === detailGeneration.current)
        setRevisionError(errorText(cause));
    } finally {
      if (generation === detailGeneration.current) setRevisionLoading(false);
    }
  }, [rpc, selection, account]);

  useEffect(() => {
    setView(linkedView);
    if (linkedId && (linkedView === "accounts" || linkedView === "evidence"))
      setSelection({
        kind: linkedView === "accounts" ? "account" : "evidence",
        id: linkedId,
      });
    else setSelection(null);
  }, [subPath, linkedId, linkedView]);

  useEffect(() => {
    setAccount(null);
    setObservation(null);
    setDetailError(null);
    void loadDetail();
    return () => {
      detailGeneration.current++;
    };
  }, [loadDetail]);

  const loadRetrievals = useCallback(
    async (append = false) => {
      const generation = ++snapshotsGeneration.current;
      const before = append ? snapshotsBefore.current : undefined;
      if (append) setRetrievalsMoreLoading(true);
      else {
        snapshotsBefore.current = undefined;
        setRetrievals(null);
        setRetrievalsHasMore(false);
      }
      setRetrievalsError(null);
      try {
        const result = await rpc.call("understandingRetrievals", {
          limit: 100,
          ...(before ? { before } : {}),
        });
        if (generation !== snapshotsGeneration.current) return;
        setRetrievals((current) =>
          append
            ? [...(current ?? []), ...result.retrievals]
            : result.retrievals,
        );
        setRetrievalsHasMore(result.retrievals.length === 100);
        const last = result.retrievals[result.retrievals.length - 1];
        if (last) snapshotsBefore.current = { at: last.at, id: last.id };
      } catch (cause) {
        if (generation === snapshotsGeneration.current)
          setRetrievalsError(errorText(cause));
      } finally {
        if (generation === snapshotsGeneration.current)
          setRetrievalsMoreLoading(false);
      }
    },
    [rpc],
  );
  useEffect(() => {
    if (view === "decisions") void loadRetrievals();
    return () => {
      snapshotsGeneration.current++;
    };
  }, [view, loadRetrievals]);
  useRealtime("changed", () => {
    void loadOverview();
    void loadDetail();
    if (view === "decisions") void loadRetrievals();
  });
  const openTrace = (ids: (string | null | undefined)[], title: string) => {
    const present = ids.filter((id): id is string => Boolean(id));
    if (!present.length) return;
    setTraceIds(present);
    setTraceTitle(title);
  };
  const choose = (next: Selection) => setSelection(next);
  const currentBeliefs = useMemo(() => overview?.accounts ?? [], [overview]);
  const currentEvidence = useMemo(
    () => overview?.observations ?? [],
    [overview],
  );

  return (
    <section className="understanding min-h-0">
      <header className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Workstreams / Understanding
          </div>
          <h2 className="text-xl font-semibold tracking-tight">
            Understanding
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Inspect what was observed, how it was interpreted, what retrieval
            selected, and what consumers actually received.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void loadOverview();
            void loadDetail();
            if (view === "decisions") void loadRetrievals();
          }}
          className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-state-hover focus-visible:outline-2 focus-visible:outline-ring"
        >
          Refresh
        </button>
      </header>

      <div className="understanding__pipeline mb-4 overflow-hidden rounded-lg border border-border bg-surface-raised/30">
        <div className="flex min-w-max items-center divide-x divide-border overflow-x-auto">
          {[
            { label: "Conversation", number: "01", note: "source entries" },
            {
              label: "Evidence",
              number: "02",
              note: `${overview?.counts.observations ?? "—"} observations`,
            },
            {
              label: "Accounts",
              number: "03",
              note: `${overview?.counts.accounts ?? "—"} interpretations`,
            },
            {
              label: "Retrieval",
              number: "04",
              note: "rank · budget · include",
            },
            { label: "Decision", number: "05", note: "consumer snapshot" },
          ].map((step, index) => (
            <div
              key={step.number}
              className="understanding__step flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5"
            >
              <span className="font-mono text-[10px] text-muted-foreground">
                {step.number}
              </span>
              <div className="min-w-0">
                <div className="text-xs font-medium">{step.label}</div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {step.note}
                </div>
              </div>
              {index < 4 ? (
                <span aria-hidden className="ml-auto text-muted-foreground">
                  ›
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <nav
          aria-label="Understanding views"
          className="flex flex-wrap gap-1 rounded-lg border border-border p-1"
        >
          {VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => {
                setView(item.id);
                if (item.id !== "accounts" && item.id !== "evidence")
                  choose(null);
              }}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                view === item.id
                  ? "bg-state-active text-foreground"
                  : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>
        {view === "accounts" || view === "evidence" ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="sr-only">Search understanding</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search evidence and accounts"
              className="h-8 w-56 max-w-[65vw] rounded-md border border-input bg-transparent px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            />
          </label>
        ) : null}
      </div>

      {overviewError ? (
        <ErrorBox error={overviewError} retry={() => void loadOverview()} />
      ) : null}
      {view === "accounts" || view === "evidence" ? (
        <div className="understanding__workspace grid min-h-[420px] grid-cols-1 overflow-hidden rounded-lg border border-border lg:grid-cols-[minmax(230px,0.36fr)_minmax(0,1fr)]">
          <aside
            aria-label={view === "accounts" ? "Account list" : "Evidence list"}
            className="understanding__list max-h-[48vh] overflow-y-auto border-b border-border lg:max-h-[70vh] lg:border-b-0 lg:border-r"
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <span>
                {view === "accounts" ? "Interpretations" : "Observed evidence"}
              </span>
              <span>
                {view === "accounts"
                  ? currentBeliefs.length
                  : currentEvidence.length}
              </span>
            </div>
            {overviewLoading && !overview ? (
              <Loading label="Loading understanding…" />
            ) : null}
            {!overviewLoading &&
            !overviewError &&
            (view === "accounts"
              ? currentBeliefs.length === 0
              : currentEvidence.length === 0) ? (
              <EmptyState
                title={query ? "No matches" : "Nothing collected yet"}
                detail={
                  query
                    ? "Try another term or clear the search."
                    : "Understanding appears as conversations are observed. This view does not trigger collection."
                }
              />
            ) : null}
            {view === "accounts"
              ? currentBeliefs.map((belief) => (
                  <button
                    key={belief.id}
                    type="button"
                    onClick={() => choose({ kind: "account", id: belief.id })}
                    className={cn(
                      "block w-full border-b border-border/70 px-3 py-3 text-left hover:bg-state-hover focus-visible:outline-2 focus-visible:outline-ring",
                      selection?.id === belief.id && "bg-state-active",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium">
                        {belief.name}
                      </span>
                      <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
                        {belief.id.slice(0, 9)}
                      </span>
                    </span>
                    <span className="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-muted-foreground">
                      {belief.narrative}
                    </span>
                    <span className="mt-2 block text-[10px] text-muted-foreground">
                      {belief.evidenceIds.length} cited · updated{" "}
                      {stamp(belief.updatedAt)}
                    </span>
                  </button>
                ))
              : currentEvidence.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => choose({ kind: "evidence", id: item.id })}
                    className={cn(
                      "block w-full border-b border-border/70 px-3 py-3 text-left hover:bg-state-hover focus-visible:outline-2 focus-visible:outline-ring",
                      selection?.id === item.id && "bg-state-active",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                        {roleLabel[item.epistemic]}
                      </span>
                      <span className="font-mono text-[9px] text-muted-foreground">
                        {item.id.slice(0, 9)}
                      </span>
                    </span>
                    <span className="mt-1 line-clamp-2 block text-xs leading-relaxed">
                      {item.observation}
                    </span>
                    <span className="mt-2 block text-[10px] text-muted-foreground">
                      {stamp(item.sourceAt)} ·{" "}
                      <ThreadTitle threadId={item.threadId} />
                    </span>
                  </button>
                ))}
            {overview &&
            (view === "accounts"
              ? overview.hasMoreAccounts
              : overview.hasMoreObservations) ? (
              <button
                type="button"
                disabled={overviewMoreLoading}
                onClick={() =>
                  void loadMoreOverview(
                    view === "accounts" ? "accounts" : "observations",
                  )
                }
                className="w-full px-3 py-3 text-left text-xs text-muted-foreground hover:bg-state-hover disabled:opacity-50"
              >
                {overviewMoreLoading && overviewMoreKind === view
                  ? "Loading more…"
                  : "Load more"}
              </button>
            ) : null}
          </aside>
          <main className="understanding__detail min-w-0 overflow-y-auto p-4 lg:max-h-[70vh]">
            {detailLoading ? <Loading label="Loading detail…" /> : null}
            {detailError ? (
              <ErrorBox
                error={detailError}
                retry={() => {
                  const selected = selection;
                  choose(null);
                  queueMicrotask(() => choose(selected));
                }}
              />
            ) : null}
            {!selection && !detailLoading ? (
              <EmptyState
                title="Select an item"
                detail="Choose an account or evidence record to follow its provenance."
              />
            ) : null}
            {selection?.kind === "account" && account ? (
              <AccountPane
                detail={account}
                onEvidence={(id) => {
                  setView("evidence");
                  choose({ kind: "evidence", id });
                }}
                onAccount={(id) => choose({ kind: "account", id })}
                onTrace={(ids, title) => openTrace(ids, title)}
                hasMoreRevisions={account.hasMoreRevisions}
                revisionsLoading={revisionLoading}
                revisionsError={revisionError}
                onLoadMoreRevisions={() => void loadMoreRevisions()}
              />
            ) : null}
            {selection?.kind === "evidence" && observation ? (
              <EvidencePane
                detail={observation}
                onSelect={(kind, id) => {
                  setView(kind === "account" ? "accounts" : "evidence");
                  choose({ kind, id });
                }}
                onTrace={(ids, title) => openTrace(ids, title)}
              />
            ) : null}
          </main>
        </div>
      ) : null}
      {view === "retrieval" ? (
        <RetrievalLab
          rpc={rpc}
          report={report}
          setReport={setReport}
          error={retrievalError}
          setError={setRetrievalError}
          loading={retrievalLoading}
          setLoading={setRetrievalLoading}
          budget={budget}
          setBudget={setBudget}
          onSelect={(kind, id) => {
            setView(kind === "account" ? "accounts" : "evidence");
            choose({ kind, id });
          }}
        />
      ) : null}
      {view === "decisions" ? (
        <Decisions
          retrievals={retrievals}
          error={retrievalsError}
          reload={() => void loadRetrievals()}
          loadMore={() => void loadRetrievals(true)}
          hasMore={retrievalsHasMore}
          moreLoading={retrievalsMoreLoading}
          onTrace={(ids, title) => openTrace(ids, title)}
          onSelect={(kind, id) => {
            setView(kind === "account" ? "accounts" : "evidence");
            choose({ kind, id });
          }}
        />
      ) : null}
      {view === "health" ? (
        <Health
          overview={overview}
          loading={overviewLoading}
          moreLoading={overviewMoreLoading}
          onLoadMore={() => void loadMoreOverview("progress")}
        />
      ) : null}
      {traceIds.length ? (
        <TraceInspector
          open
          onOpenChange={(open) => {
            if (!open) setTraceIds([]);
          }}
          target={{ traceIds }}
          title={traceTitle}
        />
      ) : null}
    </section>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div role="status" className="p-5 text-xs text-muted-foreground">
      <span className="mr-2 inline-block size-2 animate-pulse rounded-full bg-emerald-500" />
      {label}
    </div>
  );
}
function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-h-40 flex-col justify-center p-6">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}
function ErrorBox({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div
      role="alert"
      className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs"
    >
      <span className="min-w-0">Could not load: {error}</span>
      <button
        type="button"
        onClick={retry}
        className="rounded border border-border px-2 py-1 hover:bg-state-hover"
      >
        Retry
      </button>
    </div>
  );
}
function SectionTitle({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-4 border-b border-border pb-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {eyebrow}
      </div>
      <div className="mt-1 flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}
function TraceAction({
  ids,
  title,
  onTrace,
}: {
  ids: (string | null | undefined)[];
  title: string;
  onTrace: (ids: (string | null | undefined)[], title: string) => void;
}) {
  const present = ids.filter(Boolean);
  return present.length ? (
    <button
      type="button"
      onClick={() => onTrace(ids, title)}
      className="rounded-md border border-border px-2 py-1 text-[11px] hover:bg-state-hover focus-visible:outline-2 focus-visible:outline-ring"
    >
      Inspect model call · {present.length} trace
      {present.length === 1 ? "" : "s"}
    </button>
  ) : (
    <span className="text-[10px] text-muted-foreground">
      No trace ID recorded
    </span>
  );
}
function EvidenceCard({
  item,
  onSelect,
}: {
  item: Evidence;
  onSelect: (id: string) => void;
}) {
  return (
    <article className="rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2 text-[10px]">
        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-800 dark:text-emerald-200">
          {roleLabel[item.epistemic]}
        </span>
        <span className="text-muted-foreground">
          {item.speaker} · {stamp(item.sourceAt)}
        </span>
        <button
          type="button"
          onClick={() => onSelect(item.id)}
          className="ml-auto font-mono text-muted-foreground underline decoration-dotted underline-offset-2"
        >
          {item.id}
        </button>
      </div>
      <blockquote className="mt-2 border-l-2 border-emerald-500/40 pl-3 text-xs leading-relaxed">
        “{item.quote}”
      </blockquote>
      <p className="mt-2 text-xs text-muted-foreground">{item.observation}</p>
      <p className="mt-2 text-[10px] text-muted-foreground">
        Source: <ThreadSource threadId={item.threadId} />{" "}
        <span className="font-mono">· entry {item.entryId}</span>
      </p>
    </article>
  );
}
function ThreadSource({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate.toThread(threadId)}
      className="underline decoration-dotted underline-offset-2 hover:text-foreground"
    >
      <ThreadTitle threadId={threadId} />{" "}
      <span className="font-mono">({threadId})</span>
    </button>
  );
}
function AccountPane({
  detail,
  onEvidence,
  onAccount,
  onTrace,
  hasMoreRevisions,
  revisionsLoading,
  revisionsError,
  onLoadMoreRevisions,
}: {
  detail: AccountDetail;
  onEvidence: (id: string) => void;
  onAccount: (id: string) => void;
  onTrace: (ids: (string | null | undefined)[], title: string) => void;
  hasMoreRevisions: boolean;
  revisionsLoading: boolean;
  revisionsError: string | null;
  onLoadMoreRevisions: () => void;
}) {
  const { account, evidence, revisions } = detail;
  return (
    <>
      <SectionTitle
        eyebrow={
          account
            ? "Current interpretation · not a direct quote"
            : "Retired interpretation"
        }
        title={
          account?.name ?? revisions[0]?.before?.name ?? "Account unavailable"
        }
      >
        <span className="font-mono text-[10px] text-muted-foreground">
          {revisions[0]?.accountId ?? ""}
        </span>
      </SectionTitle>
      {account ? (
        <>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">
            {account.narrative}
          </p>
          {account.questions.length ? (
            <div className="mt-4 rounded-md border border-amber-500/25 bg-amber-500/5 p-3">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-200">
                Open questions
              </h3>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
                {account.questions.map((question, index) => (
                  <li key={`${question}-${index}`}>{question}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span>
              Updated {stamp(account.updatedAt)} · {evidence.length} available
              citations
            </span>
            <TraceAction
              ids={[account.traceId]}
              title={`Synthesis for ${account.name}`}
              onTrace={onTrace}
            />
          </div>
          <div className="mt-3 space-y-2">
            {evidence.map((item) => (
              <EvidenceCard key={item.id} item={item} onSelect={onEvidence} />
            ))}
            {!evidence.length ? (
              <p className="text-xs text-muted-foreground">
                Cited evidence is no longer available.
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          This account has been retired. Its revision history and prior
          citations remain available below.
        </p>
      )}
      <section className="mt-6">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider">
          Revision history
        </h3>
        <ol className="relative ml-2 space-y-4 border-l border-border pl-4">
          {revisions.map((revision) => (
            <li key={revision.id} className="relative">
              <span className="absolute -left-[21px] top-1 size-2 rounded-full border border-background bg-emerald-500" />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium capitalize">
                  {revision.action}
                </span>
                <time className="text-[10px] text-muted-foreground">
                  {stamp(revision.at)}
                </time>
                <TraceAction
                  ids={[revision.traceId]}
                  title={`Account ${revision.action} synthesis`}
                  onTrace={onTrace}
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {revision.reason}
              </p>
              <RevisionDiff
                before={revision.before}
                after={revision.after}
                onEvidence={onEvidence}
                onAccount={onAccount}
              />
            </li>
          ))}
        </ol>
        {revisionsError ? (
          <ErrorBox error={revisionsError} retry={onLoadMoreRevisions} />
        ) : null}
        {hasMoreRevisions ? (
          <button
            type="button"
            disabled={revisionsLoading}
            onClick={onLoadMoreRevisions}
            className="mt-3 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-state-hover disabled:opacity-50"
          >
            {revisionsLoading ? "Loading revisions…" : "Load earlier revisions"}
          </button>
        ) : null}
      </section>
    </>
  );
}
function RevisionDiff({
  before,
  after,
  onEvidence,
  onAccount,
}: {
  before: Belief | null;
  after: Belief | null;
  onEvidence: (id: string) => void;
  onAccount: (id: string) => void;
}) {
  if (!before && !after)
    return (
      <p className="mt-2 text-[10px] text-muted-foreground">
        No account snapshot recorded.
      </p>
    );
  const show = (label: string, value: Belief | null, tone: string) =>
    value ? (
      <div className={cn("rounded-md border p-2", tone)}>
        <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider">
          {label} · {value.name}
        </div>
        <p className="text-[11px] leading-relaxed">{value.narrative}</p>
        {value.questions.length ? (
          <p className="mt-1 text-[10px] text-muted-foreground">
            Questions: {value.questions.join(" · ")}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-1">
          {value.evidenceIds.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onEvidence(id)}
              className="understanding__revision-link font-mono text-[9px] underline decoration-dotted underline-offset-2"
            >
              {id}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onAccount(value.id)}
            className="understanding__revision-link font-mono text-[9px] text-muted-foreground underline decoration-dotted"
          >
            Open account
          </button>
        </div>
      </div>
    ) : null;
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      {show("Before", before, "border-rose-500/20 bg-rose-500/[0.03]")}
      {show("After", after, "border-emerald-500/20 bg-emerald-500/[0.03]")}
    </div>
  );
}
function EvidencePane({
  detail,
  onSelect,
  onTrace,
}: {
  detail: ObservationDetail;
  onSelect: (kind: "account" | "evidence", id: string) => void;
  onTrace: (ids: (string | null | undefined)[], title: string) => void;
}) {
  const item = detail.observation;
  if (!item)
    return (
      <EmptyState
        title="Evidence unavailable"
        detail="The evidence record may have been removed. Its opaque ID remains a useful reference."
      />
    );
  return (
    <>
      <SectionTitle
        eyebrow="Source observation · grounded record"
        title={roleLabel[item.epistemic]}
      >
        <span className="font-mono text-[10px] text-muted-foreground">
          {item.id}
        </span>
      </SectionTitle>
      <EvidenceCard item={item} onSelect={() => {}} />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] text-muted-foreground">
          Terms: {item.terms.join(" · ") || "none recorded"}
        </div>
        <TraceAction
          ids={[item.traceId]}
          title="Evidence extraction"
          onTrace={onTrace}
        />
      </div>
      <section className="mt-6">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider">
          Current accounts citing this evidence
        </h3>
        {detail.accounts.length ? (
          <div className="space-y-2">
            {detail.accounts.map((belief) => (
              <button
                key={belief.id}
                type="button"
                onClick={() => onSelect("account", belief.id)}
                className="block w-full rounded-md border border-border p-3 text-left hover:bg-state-hover"
              >
                <span className="text-xs font-medium">{belief.name}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {belief.narrative}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No current account cites this observation.
          </p>
        )}
      </section>
      <section className="mt-6">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider">
          Consumer snapshots citing this evidence
        </h3>
        {detail.retrievals.length ? (
          <div className="space-y-2">
            {detail.retrievals.map((snapshot) => (
              <SnapshotCard
                key={snapshot.id}
                snapshot={snapshot}
                onTrace={onTrace}
                onSelect={onSelect}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No recorded retrieval snapshot is linked to this evidence.
          </p>
        )}
      </section>
    </>
  );
}
function RetrievalLab({
  rpc,
  report,
  setReport,
  error,
  setError,
  loading,
  setLoading,
  budget,
  setBudget,
  onSelect,
}: {
  rpc: Rpc;
  report: RetrievalReport | null;
  setReport: (value: RetrievalReport) => void;
  error: string | null;
  setError: (value: string | null) => void;
  loading: boolean;
  setLoading: (value: boolean) => void;
  budget: number;
  setBudget: (value: number) => void;
  onSelect: (kind: "account" | "evidence", id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await rpc.call("understandingRetrieve", {
        query,
        budget,
        limit: 24,
      });
      if (current === generation.current) setReport(next);
    } catch (cause) {
      if (current === generation.current) setError(errorText(cause));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  };
  return (
    <section className="rounded-lg border border-border p-4">
      <SectionTitle
        eyebrow="Read-only · local retrieval · no model call"
        title="Retrieval lab"
      />
      <p className="-mt-2 mb-4 max-w-3xl text-xs leading-relaxed text-muted-foreground">
        Run the production retrieval algorithm against a query and character
        budget. This reads local records only; it does not change memory, call a
        model, or represent a replay.
      </p>
      <form
        onSubmit={(event) => void submit(event)}
        className="grid gap-3 rounded-md border border-border bg-surface-raised/30 p-3 sm:grid-cols-[minmax(0,1fr)_160px_auto]"
      >
        <label className="text-[10px] font-medium text-muted-foreground">
          Query
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={2000}
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            placeholder="What should this consumer understand?"
          />
        </label>
        <label className="text-[10px] font-medium text-muted-foreground">
          Context budget · characters
          <input
            type="number"
            min={500}
            max={8000}
            step={100}
            value={budget}
            onChange={(event) =>
              setBudget(
                Math.max(500, Math.min(8000, Number(event.target.value))),
              )
            }
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          />
        </label>
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="understanding__run self-end rounded-md bg-foreground px-3 py-2 text-xs font-medium text-background disabled:opacity-40"
        >
          {loading ? "Retrieving…" : "Run retrieval"}
        </button>
      </form>
      {error ? (
        <div className="mt-3">
          <ErrorBox
            error={error}
            retry={() => {
              const form = document.querySelector<HTMLFormElement>(
                ".understanding form",
              );
              form?.requestSubmit();
            }}
          />
        </div>
      ) : null}
      {report ? (
        <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs">
              <strong>{report.usedChars.toLocaleString()}</strong> /{" "}
              {report.budget.toLocaleString()} chars ·{" "}
              {report.accountIds.length} accounts ·{" "}
              {report.observationIds.length} observations
              {report.query !== query || report.budget !== budget ? (
                <span className="ml-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-800 dark:text-amber-200">
                  Previous run
                </span>
              ) : null}
            </div>
            <span className="text-[10px] text-muted-foreground">
              Terms: {report.terms.join(" · ") || "none"}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Results for:{" "}
            <span className="font-medium text-foreground">
              {report.query || "(empty query)"}
            </span>
            {report.budget !== budget
              ? ` · ${report.budget.toLocaleString()} character budget`
              : ""}
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {report.candidates.map((candidate) => (
              <article
                key={`${candidate.kind}:${candidate.id}`}
                className="rounded-md border border-border p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      onSelect(
                        candidate.kind === "account" ? "account" : "evidence",
                        candidate.id,
                      )
                    }
                    className="min-w-0 text-left text-xs font-medium underline decoration-dotted underline-offset-2"
                  >
                    {candidate.title}
                  </button>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-[9px]",
                      candidate.disposition === "included"
                        ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {dispositionLabel[candidate.disposition]}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
                  <span>{candidate.kind}</span>
                  <span>score {candidate.score.toFixed(2)}</span>
                  <span>{candidate.chars} chars</span>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Matched: {candidate.matchedTerms.join(", ") || "none"}
                </p>
              </article>
            ))}
          </div>
          <details className="mt-4 rounded-md border border-border">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
              Exact context sent to consumer
            </summary>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap border-t border-border p-3 font-mono text-[10px] leading-relaxed">
              {report.context || "(empty context)"}
            </pre>
          </details>
        </div>
      ) : (
        <EmptyState
          title="Run a local retrieval"
          detail="Results show candidate scores, exclusions, exact context, and budget use. No model replay or memory mutation occurs."
        />
      )}
      <span className="sr-only" aria-live="polite">
        {loading ? "Retrieval running" : ""}
      </span>
    </section>
  );
}
function Decisions({
  retrievals,
  error,
  reload,
  loadMore,
  hasMore,
  moreLoading,
  onTrace,
  onSelect,
}: {
  retrievals: RetrievalSnapshot[] | null;
  error: string | null;
  reload: () => void;
  loadMore: () => void;
  hasMore: boolean;
  moreLoading: boolean;
  onTrace: (ids: (string | null | undefined)[], title: string) => void;
  onSelect: (kind: "account" | "evidence", id: string) => void;
}) {
  return (
    <section className="rounded-lg border border-border p-4">
      <SectionTitle
        eyebrow="Recorded consumer input · not a replay"
        title="Decisions"
      >
        <button
          type="button"
          onClick={reload}
          className="rounded border border-border px-2 py-1 text-[10px] hover:bg-state-hover"
        >
          Refresh
        </button>
      </SectionTitle>
      <p className="-mt-2 mb-4 text-xs text-muted-foreground">
        These are actual retrieval snapshots used by analysis or routing.
        Replaying a linked model call is a separate, paid model operation and
        does not change stored memory.
      </p>
      {error ? <ErrorBox error={error} retry={reload} /> : null}
      {retrievals === null && !error ? (
        <Loading label="Loading consumer snapshots…" />
      ) : null}
      {retrievals?.length === 0 ? (
        <EmptyState
          title="No snapshots recorded"
          detail="Consumer retrieval snapshots will appear here when analysis or routing uses understanding context."
        />
      ) : null}
      <div className="space-y-3">
        {retrievals?.map((snapshot) => (
          <SnapshotCard
            key={snapshot.id}
            snapshot={snapshot}
            onTrace={onTrace}
            onSelect={onSelect}
          />
        ))}
      </div>
      {hasMore ? (
        <button
          type="button"
          disabled={moreLoading}
          onClick={loadMore}
          className="mt-3 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-state-hover disabled:opacity-50"
        >
          {moreLoading ? "Loading older snapshots…" : "Load older snapshots"}
        </button>
      ) : null}
    </section>
  );
}
function SnapshotCard({
  snapshot,
  onTrace,
  onSelect,
}: {
  snapshot: RetrievalSnapshot;
  onTrace: (ids: (string | null | undefined)[], title: string) => void;
  onSelect: (kind: "account" | "evidence", id: string) => void;
}) {
  return (
    <article className="rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium capitalize">
          {snapshot.consumer}
        </span>
        <time className="text-[10px] text-muted-foreground">
          {stamp(snapshot.at)}
        </time>
        {snapshot.threadId ? (
          <ThreadSource threadId={snapshot.threadId} />
        ) : (
          <span className="text-[10px] text-muted-foreground">
            No source thread
          </span>
        )}
        <span className="ml-auto font-mono text-[9px] text-muted-foreground">
          {snapshot.id}
        </span>
      </div>
      <p className="mt-2 text-xs">
        Query:{" "}
        <span className="text-muted-foreground">
          {snapshot.report.query || "(empty)"}
        </span>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
        <span>
          {snapshot.report.usedChars} / {snapshot.report.budget} chars
        </span>
        <span>{snapshot.report.accountIds.length} accounts</span>
        <span>{snapshot.report.observationIds.length} observations</span>
        <TraceAction
          ids={[snapshot.traceId]}
          title={`${snapshot.consumer} model call`}
          onTrace={onTrace}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {snapshot.report.accountIds.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onSelect("account", id)}
            className="rounded border border-border px-1.5 py-1 font-mono text-[9px] hover:bg-state-hover"
          >
            Account {id}
          </button>
        ))}
        {snapshot.report.observationIds.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onSelect("evidence", id)}
            className="rounded border border-border px-1.5 py-1 font-mono text-[9px] hover:bg-state-hover"
          >
            Evidence {id}
          </button>
        ))}
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-[10px] text-muted-foreground">
          Exact captured context
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-2 font-mono text-[10px]">
          {snapshot.report.context || "(empty context)"}
        </pre>
      </details>
    </article>
  );
}
function Health({
  overview,
  loading,
  moreLoading,
  onLoadMore,
}: {
  overview: DebugOverview | null;
  loading: boolean;
  moreLoading: boolean;
  onLoadMore: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(
        "bb workstreams understanding --observe <thread-id>",
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  const counts = overview?.counts;
  return (
    <section className="rounded-lg border border-border p-4">
      <SectionTitle
        eyebrow="Collection is observable, not controlled here"
        title="Collection health"
      >
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded border border-border px-2 py-1 text-[10px] hover:bg-state-hover"
        >
          {copied ? "Copied" : "Copy observe command"}
        </button>
      </SectionTitle>
      <p className="-mt-2 mb-4 text-xs leading-relaxed text-muted-foreground">
        This page is read-only. It never starts collection or destructive
        reindexing. To deliberately inspect/observe a conversation, use the CLI
        command below in a trusted local terminal.
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ["Accounts", counts?.accounts],
          ["Evidence", counts?.observations],
          ["Threads", counts?.threads],
          ["Failed", counts?.failed],
          ["Pending", counts?.pending],
        ].map(([label, value]) => (
          <div key={label} className="rounded-md border border-border p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {label}
            </div>
            <div className="mt-1 font-mono text-xl font-semibold">
              {loading && value === undefined ? "…" : (value ?? "—")}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-md border border-border bg-muted/20 p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Observe one conversation
        </div>
        <code className="mt-2 block overflow-auto whitespace-nowrap font-mono text-xs">
          bb workstreams understanding --observe &lt;thread-id&gt;
        </code>
        <p className="mt-2 text-[10px] text-muted-foreground">
          This explicit CLI operation may call the configured model and update
          collection. The workbench itself does not execute it.
        </p>
      </div>
      <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wider">
        Per-thread progress
      </h3>
      {overview?.progress.length ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[600px] text-left text-[10px]">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr>
                {[
                  "Source thread",
                  "Status",
                  "Updated",
                  "Revision",
                  "Cursor",
                  "Backlog",
                  "Dirty",
                  "Error",
                ].map((heading) => (
                  <th key={heading} className="px-2 py-2 font-medium">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {overview.progress.map((row) => (
                <tr key={row.threadId} className="border-t border-border">
                  <td className="px-2 py-2">
                    <ThreadSource threadId={row.threadId} />
                  </td>
                  <td className="px-2 py-2">{row.status}</td>
                  <td className="px-2 py-2">{stamp(row.updatedAt)}</td>
                  <td className="px-2 py-2 font-mono">
                    {row.completedRevision ?? "—"}
                  </td>
                  <td
                    className="max-w-28 truncate px-2 py-2 font-mono"
                    title={row.cursor ?? "—"}
                  >
                    {row.cursor ?? "—"}
                  </td>
                  <td className="px-2 py-2">{row.backlog}</td>
                  <td className="px-2 py-2">{row.dirty}</td>
                  <td
                    className="max-w-48 truncate px-2 py-2 text-destructive"
                    title={row.error ?? "—"}
                  >
                    {row.error ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title={
            loading ? "Loading collection status" : "No collection progress"
          }
          detail="Threads are listed after observation has been attempted."
        />
      )}
      {overview?.hasMoreProgress ? (
        <button
          type="button"
          disabled={moreLoading}
          onClick={onLoadMore}
          className="mt-3 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-state-hover disabled:opacity-50"
        >
          {moreLoading ? "Loading more…" : "Load more progress"}
        </button>
      ) : null}
    </section>
  );
}
