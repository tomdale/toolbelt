import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, type useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { BootstrapState } from "../../server/bootstrap.ts";
import { Icon } from "@/components/ui/icon";
import { InspectButton } from "../debug/InspectButton.tsx";
import { ghostButton, primaryButton, secondaryButton } from "./controls.ts";
import { WorkstreamName } from "../WorkstreamName.tsx";
import { compareGroupNames } from "../../domain/group-name-order.ts";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;
type Command = Parameters<Rpc["call"]>[1];

export function Organize({ rpc }: { rpc: Rpc; bootstrapped?: boolean }) {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requested = useRef(0);
  const settled = useRef(0);
  const command = useRef(0);
  const errorOwner = useRef<"read" | "command" | null>(null);
  const read = useCallback(async () => {
    const generation = ++requested.current;
    try {
      const result = await rpc.call("bootstrap", { action: "get" });
      if (generation < settled.current) return;
      settled.current = generation;
      setState(result.state as BootstrapState | null);
      if (errorOwner.current === "read") {
        errorOwner.current = null;
        setError(null);
      }
    } catch (cause) {
      if (generation < settled.current) return;
      settled.current = generation;
      if (errorOwner.current !== "command") {
        errorOwner.current = "read";
        setError(String(cause));
      }
    } finally {
      setLoaded(true);
    }
  }, [rpc]);
  const send = async (input: Command) => {
    const owner = ++command.current;
    const generation = ++requested.current;
    settled.current = generation;
    errorOwner.current = "command";
    setError(null);
    setBusy(true);
    try {
      const result = await rpc.call("bootstrap", input as never);
      if (command.current !== owner) return;
      errorOwner.current = null;
      setError(null);
      if (generation >= settled.current) {
        settled.current = generation;
        setState(result.state as BootstrapState | null);
      }
    } catch (cause) {
      if (command.current === owner) {
        errorOwner.current = "command";
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (command.current === owner) {
        setBusy(false);
        void read();
      }
    }
  };
  useEffect(() => {
    void read();
  }, [read]);
  useRealtime("changed", () => void read());
  const working = state?.status === "proposing" || state?.status === "applying";
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void read(), 1000);
    return () => clearInterval(timer);
  }, [working, read]);
  if (!loaded) return null;
  const preview = state?.status === "preview" ? state.preview : null;
  const titles = new Map(state?.roots.map((r) => [r.id, r.title]));
  const moveById = new Map(preview?.moves.map((m) => [m.threadId, m]));
  const renderThreads = (key: string | null) => (
    <ul className="mt-1.5">
      {preview?.assignments
        .filter((a) => a.workstream === key)
        .map((a) => {
          const move = moveById.get(a.threadId);
          return (
            <li key={a.threadId} className="text-[13px]">
              {move ? (
                <div
                  className="flex items-start gap-2.5 px-2 py-1"
                  title={a.reason}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {titles.get(a.threadId)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    from {move.fromName}
                  </span>
                </div>
              ) : (
                <span className="flex items-center gap-2.5 px-2 py-1 text-muted-foreground">
                  <span aria-hidden className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {titles.get(a.threadId)}
                  </span>
                </span>
              )}
            </li>
          );
        })}
    </ul>
  );
  const accepted = preview ? preview.moves.filter((m) => m.accepted).length : 0;
  return (
    <section aria-label="Organize" className="text-sm">
      {!preview ? (
        <div className="flex items-center gap-4 rounded-lg border border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-1.5 font-medium">
              Organize workstreams
              {state?.traceIds?.length ? (
                <InspectButton
                  target={{ traceIds: state.traceIds }}
                  title="Organizing pass"
                  label="Inspect organizing pass"
                />
              ) : null}
            </h2>
            <p className="text-xs text-muted-foreground">
              {working
                ? state.status === "proposing"
                  ? state.progress?.stage === "classifying"
                    ? `Classifying tasks ${state.progress.completed} of ${state.progress.total} · ${state.progress.cached} already classified${state.progress.unresolved ? ` · ${state.progress.unresolved} unresolved` : ""}`
                    : state.progress?.stage === "regrouping"
                      ? "Grouping current tasks by product and feature…"
                      : "Reading your open threads…"
                  : "Applying organization…"
                : state?.status === "applied"
                  ? "Organization applied. Undo it from Activity."
                  : "Groups open threads by product in one pass. Nothing moves until you apply."}
            </p>
          </div>
          {working ? (
            <span role="status" className="sr-only">
              {state?.progress?.stage === "classifying"
                ? `Classifying tasks ${state.progress.completed} of ${state.progress.total}`
                : state?.progress?.stage === "regrouping"
                  ? "Grouping current tasks"
                  : "Working"}
            </span>
          ) : null}
          {state?.status === "failed" || state?.status === "proposing" ? (
            <button
              type="button"
              className={ghostButton}
              disabled={state?.status === "failed" && busy}
              onClick={() => void send({ action: "cancel" })}
            >
              Cancel
            </button>
          ) : null}
          {!working ? (
            <button
              type="button"
              className={
                state?.status === "applied" ? secondaryButton : primaryButton
              }
              disabled={busy}
              onClick={() => void send({ action: "start" })}
            >
              {state?.status === "failed" ? "Start over" : "Organize…"}
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="sticky top-0 z-10 -mx-1 flex items-center gap-3 border-b border-border bg-background/95 px-1 py-2 backdrop-blur">
            <div className="min-w-0 flex-1">
              <h2 className="flex items-center gap-1.5 font-medium">
                Review organization
                {state?.traceIds?.length ? (
                  <InspectButton
                    target={{ traceIds: state.traceIds }}
                    title="Organizing pass"
                    label="Inspect organizing pass"
                  />
                ) : null}
              </h2>
              <p className="text-xs text-muted-foreground">
                {preview.workstreams.length} workstreams · {accepted} of{" "}
                {preview.moves.length} proposed moves
                {preview.removals?.length
                  ? ` · ${preview.removals.length} to remove`
                  : ""}
              </p>
            </div>
            <button
              type="button"
              className={ghostButton}
              disabled={busy}
              onClick={() => void send({ action: "cancel" })}
            >
              Cancel
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={busy}
              onClick={() =>
                void send({
                  action: "apply",
                  runId: state!.startedAt,
                  overrides: [],
                })
              }
            >
              Apply organization
            </button>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="px-2 py-2 font-medium">Workstream</th>
                  <th className="px-2 py-2 font-medium">Tasks</th>
                  <th className="px-2 py-2 font-medium">Proposed placement</th>
                </tr>
              </thead>
              <tbody>
                {[...preview.workstreams]
                  .sort((a, b) => compareGroupNames(a.name, b.name))
                  .map((w) => {
                    const renamed = preview.renames.find(
                      (r) => r.sectionId === w.sectionId,
                    );
                    return (
                      <tr
                        key={w.key}
                        className="border-b border-border align-top"
                      >
                        <td className="max-w-64 px-2 py-2">
                          <div className="flex items-baseline gap-2 font-medium">
                            <WorkstreamName name={w.name} />
                            {w.sectionId === null ? (
                              <span className="rounded bg-primary/15 px-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
                                New
                              </span>
                            ) : null}
                            {renamed ? (
                              <span className="text-xs font-normal text-muted-foreground">
                                was {renamed.from}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 text-muted-foreground">
                            {w.description}
                          </p>
                        </td>
                        <td className="px-2 py-2 tabular-nums">
                          {
                            preview.assignments.filter(
                              (a) => a.workstream === w.key,
                            ).length
                          }
                        </td>
                        <td className="py-1">{renderThreads(w.key)}</td>
                      </tr>
                    );
                  })}
                {preview.assignments.some((a) => a.workstream === null) ? (
                  <tr className="border-b border-border align-top">
                    <td className="px-2 py-2">Unfiled</td>
                    <td className="px-2 py-2">
                      {
                        preview.assignments.filter((a) => a.workstream === null)
                          .length
                      }
                    </td>
                    <td>{renderThreads(null)}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            {preview.removals?.length ? (
              <details className="group rounded-md px-2 text-xs text-muted-foreground">
                <summary className="flex w-fit cursor-pointer list-none items-center gap-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <Icon
                    name="ChevronRight"
                    className="size-3 transition-transform group-open:rotate-90"
                    aria-hidden
                  />
                  Remove {preview.removals.length} unused workstream
                  {preview.removals.length === 1 ? "" : "s"}
                </summary>
                <p className="mt-1.5 pl-4">
                  Empty, or holding only threads archived over a day ago.
                  Threads are kept; Undo restores the grouping.
                </p>
                <ul className="mt-1.5 pl-4">
                  {[...preview.removals]
                    .sort((a, b) => compareGroupNames(a.name, b.name))
                    .map((r) => (
                      <li key={r.sectionId} className="py-0.5">
                        <span className="text-foreground/80">{r.name}</span>
                        {r.archivedThreads.length
                          ? ` · ${r.archivedThreads.length} archived`
                          : ""}
                      </li>
                    ))}
                </ul>
              </details>
            ) : null}
            {!state?.roots.length ? (
              <p className="text-muted-foreground">No open threads.</p>
            ) : null}
          </div>
        </>
      )}
      {state?.error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
