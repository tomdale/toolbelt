import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, type useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { BootstrapState } from "../../server/bootstrap.ts";
import { InspectButton } from "../debug/InspectButton.tsx";
import { ghostButton, primaryButton, secondaryButton } from "./controls.ts";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;
type Command = Parameters<Rpc["call"]>[1];

export function Organize({ rpc }: { rpc: Rpc; bootstrapped?: boolean }) {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
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
  useEffect(() => {
    setOverrides({});
  }, [state?.startedAt]);
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
    <ul className="mt-2 space-y-1">
      {preview?.assignments
        .filter((a) => a.workstream === key)
        .map((a) => {
          const move = moveById.get(a.threadId);
          return (
            <li key={a.threadId} className="text-sm">
              {move ? (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="ws-check mt-1"
                    checked={overrides[a.threadId] ?? move.accepted}
                    onChange={(e) =>
                      setOverrides((o) => ({
                        ...o,
                        [a.threadId]: e.target.checked,
                      }))
                    }
                  />
                  <span>
                    {titles.get(a.threadId)}{" "}
                    <span className="text-xs text-muted-foreground">
                      from {move.fromName}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {a.reason}
                    </span>
                  </span>
                </label>
              ) : (
                <span>
                  {titles.get(a.threadId)}{" "}
                  <span className="text-xs text-muted-foreground">
                    stays here
                  </span>
                </span>
              )}
            </li>
          );
        })}
    </ul>
  );
  return (
    <section
      aria-label="Organize"
      className="rounded-lg border border-border p-4 text-sm"
    >
      <div className="flex items-center gap-2">
        <h2 className="font-medium">Organize workstreams</h2>
        {state?.traceIds?.length ? (
          <InspectButton
            target={{ traceIds: state.traceIds }}
            title="Organizing pass"
            label="Inspect organizing pass"
          />
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Scan open threads together, review the whole map, then apply. The map
        stays put between runs.
      </p>
      {working ? (
        <p role="status" className="my-4">
          {state.status === "proposing"
            ? "Building the map and thread placements…"
            : "Applying the reviewed map…"}
        </p>
      ) : null}
      {state?.error ? (
        <p role="alert" className="my-3 text-destructive">
          {state.error}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="my-3 text-destructive">
          {error}
        </p>
      ) : null}
      {preview ? (
        <div className="my-4 space-y-4">
          <h3 className="font-medium">Review the map</h3>
          <p className="text-xs text-muted-foreground">
            {preview.workstreams.length} workstreams ·{" "}
            {state?.roots.length ?? 0} root threads · {preview.moves.length}{" "}
            proposed moves. Uncheck a move to keep its current home. Children
            follow their parent. Empty prior homes remain dormant for history.
          </p>
          {preview.workstreams.map((w) => (
            <div key={w.key} className="rounded border border-border p-3">
              <h4 className="font-medium">
                {w.name}
                {w.sectionId === null ? " · New" : ""}
              </h4>
              {preview.renames.find((r) => r.sectionId === w.sectionId) ? (
                <p className="text-xs text-muted-foreground">
                  Renamed from{" "}
                  {
                    preview.renames.find((r) => r.sectionId === w.sectionId)
                      ?.from
                  }
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">{w.description}</p>
              {w.aliases.length ? (
                <p className="text-xs text-muted-foreground">
                  Also known as: {w.aliases.join(", ")}
                </p>
              ) : null}
              {renderThreads(w.key)}
            </div>
          ))}
          {preview.assignments.some((a) => a.workstream === null) ? (
            <div className="rounded border border-border p-3">
              <h4 className="font-medium">Unsorted</h4>
              {renderThreads(null)}
            </div>
          ) : null}
          {!state?.roots.length ? <p>No open threads to organize.</p> : null}
        </div>
      ) : null}
      {state?.status === "applied" ? (
        <p className="my-3">Map applied. Undo is available in Activity.</p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        {preview ||
        state?.status === "failed" ||
        state?.status === "proposing" ? (
          <button
            type="button"
            className={ghostButton}
            disabled={busy}
            onClick={() => void send({ action: "cancel" })}
          >
            Cancel
          </button>
        ) : null}
        {preview ? (
          <button
            type="button"
            className={primaryButton}
            disabled={busy}
            onClick={() =>
              void send({
                action: "apply",
                runId: state!.startedAt,
                overrides: Object.entries(overrides).map(
                  ([threadId, accepted]) => ({ threadId, accepted }),
                ),
              })
            }
          >
            Apply map
          </button>
        ) : !working ? (
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
    </section>
  );
}
