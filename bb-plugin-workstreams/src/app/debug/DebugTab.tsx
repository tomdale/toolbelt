/**
 * The Workstreams page's Debug tab (SPEC §11.6): every recorded model call,
 * newest first, filterable by kind and failures. Selecting one opens the
 * inspector.
 */
import { useCallback, useEffect, useState } from "react";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import {
  TRACE_KINDS,
  TRACE_KIND_TITLE,
  TRACE_STATUS_TITLE,
  type TraceKind,
  type TraceSummary,
} from "../../domain/trace.ts";
import type { RpcContract } from "../../server/contract.ts";
import { ghostButton, secondaryButton } from "../page/controls.ts";
import { TraceInspector } from "./Inspector.tsx";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;
const PAGE = 100;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function DebugTab({ rpc }: { rpc: Rpc }) {
  const [kind, setKind] = useState<TraceKind | "">("");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [traces, setTraces] = useState<TraceSummary[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<TraceSummary | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(
    async (before?: { at: number; id: string }) => {
      setError(null);
      try {
        const result = await rpc.call("traces", {
          limit: PAGE,
          ...(kind ? { kind } : {}),
          ...(before ? { before } : {}),
        });
        setTraces((previous) =>
          before ? [...(previous ?? []), ...result.traces] : result.traces,
        );
        setMore(result.traces.length === PAGE);
      } catch (cause) {
        setError(message(cause));
      }
    },
    [rpc, kind],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const clear = async () => {
    setConfirmClear(false);
    try {
      await rpc.call("traceClear", null);
      await load();
    } catch (cause) {
      setError(message(cause));
    }
  };

  const shown = (traces ?? []).filter(
    (t) => !failuresOnly || t.status !== "ok",
  );
  const cost = shown.reduce((sum, t) => sum + (t.usage?.cost ?? 0), 0);

  return (
    <div className="mt-5">
      <p className="text-xs text-muted-foreground">
        Debug mode records each model call Workstreams makes: its prompt, the
        model's reasoning and response, and what Workstreams did with it.
        Records are kept for 7 days. Turn Debug mode off in the plugin's
        settings.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <select
          aria-label="Filter by kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as TraceKind | "")}
          className="h-7 rounded-md border border-input bg-transparent px-1"
        >
          <option value="">All model calls</option>
          {TRACE_KINDS.map((k) => (
            <option key={k} value={k}>
              {TRACE_KIND_TITLE[k]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={failuresOnly}
            onChange={(event) => setFailuresOnly(event.target.checked)}
          />
          Failures only
        </label>
        <span className="flex-1" />
        {traces ? (
          <span className="tabular-nums">
            {shown.length} shown · ${cost.toFixed(4)}
          </span>
        ) : null}
        {confirmClear ? (
          <span className="flex items-center gap-1.5">
            Delete every record?
            <button
              type="button"
              className={secondaryButton}
              onClick={() => void clear()}
            >
              Delete
            </button>
            <button
              type="button"
              className={ghostButton}
              onClick={() => setConfirmClear(false)}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={ghostButton}
            disabled={!traces?.length}
            onClick={() => setConfirmClear(true)}
          >
            Clear…
          </button>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {traces && shown.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No model calls recorded yet.
        </p>
      ) : null}
      <ul className="mt-3 divide-y divide-border">
        {shown.map((trace) => (
          <li key={trace.id}>
            <button
              type="button"
              onClick={() => setOpen(trace)}
              className="flex w-full cursor-pointer items-baseline gap-3 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-state-hover"
            >
              <time
                className="w-28 shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
                dateTime={new Date(trace.at).toISOString()}
                title={new Date(trace.at).toLocaleString()}
              >
                {new Date(trace.at).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
              <span className="w-40 shrink-0 truncate text-xs text-muted-foreground">
                {TRACE_KIND_TITLE[trace.kind]}
              </span>
              <span className="min-w-0 flex-1 truncate">{trace.label}</span>
              <span
                className={cn(
                  "shrink-0 text-xs",
                  trace.status === "ok"
                    ? "text-muted-foreground"
                    : "font-medium text-destructive",
                )}
              >
                {trace.status === "ok"
                  ? `${(trace.durationMs / 1000).toFixed(1)}s`
                  : TRACE_STATUS_TITLE[trace.status]}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {more ? (
        <button
          type="button"
          className={cn(secondaryButton, "mt-3")}
          onClick={() => {
            const last = traces?.at(-1);
            if (last) void load({ at: last.at, id: last.id });
          }}
        >
          Load more
        </button>
      ) : null}
      {open ? (
        <TraceInspector
          open
          onOpenChange={(next) => !next && setOpen(null)}
          target={{ traceIds: [open.id] }}
          title={`${TRACE_KIND_TITLE[open.kind]}: ${open.label}`}
        />
      ) : null}
    </div>
  );
}
