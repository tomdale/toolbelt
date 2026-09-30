/**
 * The model-call inspector (SPEC §11.6): a side pane listing the recorded
 * calls behind one surface, with the selected call's parsed result, what
 * Workstreams did with it, the model's reasoning, the raw response, and the
 * exact prompt. "Run again" replays the prompt to show how stable the answer
 * is; a replay changes nothing Workstreams stores.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ThreadTitle, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import { relativeAge } from "../../domain/presentation.ts";
import {
  TRACE_KIND_TITLE,
  TRACE_STATUS_TITLE,
  type Trace,
  type TraceStatus,
  type TraceSummary,
} from "../../domain/trace.ts";
import type { RpcContract } from "../../server/contract.ts";
import { traceIdsOf, type InspectTarget } from "./debug.ts";
import { RetrievalLineage } from "./RetrievalLineage.tsx";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type Stoppable = { stopPropagation(): void };
const stop = (event: Stoppable) => event.stopPropagation();

/**
 * Keeps pane events from reaching whatever the pane was opened from (a row
 * that navigates, a composer that submits on Enter). React events bubble
 * through portals, so the pane stops them itself. Focus events are left
 * alone: the dialog's focus trap listens for them on the document. Radix
 * handles Escape in the capture phase, before this runs.
 */
const containContent = {
  onClick: stop,
  onDoubleClick: stop,
  onContextMenu: stop,
  onPointerDown: stop,
  onPointerUp: stop,
  onMouseDown: stop,
  onMouseUp: stop,
  onKeyDown: stop,
  onKeyUp: stop,
};
/** The overlay's pointer and mouse downs must reach the document: they close the pane. */
const containOverlay = {
  onClick: stop,
  onDoubleClick: stop,
  onContextMenu: stop,
  onPointerUp: stop,
  onMouseUp: stop,
};

export function TraceInspector({
  open,
  onOpenChange,
  target,
  title,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: InspectTarget;
  title: string;
  /** Where focus goes on close; the pane has no Radix trigger to return to. */
  returnFocus?: () => void;
}) {
  const scope = usePortalScopeProps();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          {...scope}
          {...containOverlay}
          className="fixed inset-0 z-50 bg-black/20 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        />
        <DialogPrimitive.Content
          {...scope}
          {...containContent}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!returnFocus) return;
            event.preventDefault();
            returnFocus();
          }}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[760px] flex-col border-l border-border bg-background text-foreground shadow-2xl outline-none duration-200 data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right motion-reduce:animate-none"
        >
          <InspectorBody
            target={target}
            title={title}
            close={() => onOpenChange(false)}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function InspectorBody({
  target,
  title,
  close,
}: {
  target: InspectTarget;
  title: string;
  close: () => void;
}) {
  const rpc = useRpc<RpcContract>();
  const [list, setList] = useState<TraceSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(target);
  useEffect(() => {
    let live = true;
    const ids = traceIdsOf(target);
    setList(null);
    setError(null);
    rpc
      .call(
        "traces",
        "link" in target
          ? { link: target.link, limit: 200 }
          : { ids: ids!.slice(0, 500), limit: 500 },
      )
      .then(
        ({ traces }) => {
          if (!live) return;
          // Given ids keep their order: the first is the decision's own call.
          const ordered = ids
            ? ids.flatMap((id) => traces.filter((t) => t.id === id))
            : traces;
          setList(ordered);
          setSelected(ordered[0]?.id ?? null);
        },
        (cause: unknown) => live && setError(message(cause)),
      );
    return () => {
      live = false;
    };
    // `key` is the target's identity; the object itself is new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, key]);

  return (
    <>
      <header className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3">
        <Icon
          name="Bug"
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <DialogPrimitive.Title className="truncate text-sm font-semibold">
            {title}
          </DialogPrimitive.Title>
          <p className="text-xs text-muted-foreground">
            {list === null
              ? "Loading model calls…"
              : `${list.length} model call${list.length === 1 ? "" : "s"} recorded in Debug mode`}
          </p>
        </div>
        <DialogPrimitive.Close className="-mr-1.5 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <Icon name="X" aria-hidden className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </header>
      {error ? (
        <p role="alert" className="px-4 py-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {list && list.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          No model calls were recorded for this. Debug mode records calls made
          while it is on and keeps them for 7 days.
        </p>
      ) : null}
      {list && list.length > 1 ? (
        <TraceList list={list} selected={selected} onSelect={setSelected} />
      ) : null}
      {selected ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TraceDetail key={selected} rpc={rpc} id={selected} close={close} />
        </div>
      ) : null}
    </>
  );
}

function StatusBadge({ status }: { status: TraceStatus }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded px-1.5 text-[11px] font-medium",
        status === "ok"
          ? "bg-state-hover text-muted-foreground"
          : "bg-destructive/15 text-destructive",
      )}
    >
      {TRACE_STATUS_TITLE[status]}
    </span>
  );
}

function TraceList({
  list,
  selected,
  onSelect,
}: {
  list: TraceSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const now = Date.now();
  return (
    <nav
      aria-label="Model calls"
      className="max-h-[32vh] shrink-0 overflow-y-auto border-b border-border p-1.5"
    >
      <ul>
        {list.map((trace) => (
          <li key={trace.id}>
            <button
              type="button"
              aria-current={trace.id === selected ? "true" : undefined}
              onClick={() => onSelect(trace.id)}
              className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-state-hover aria-[current=true]:bg-state-active"
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  trace.status === "ok"
                    ? "bg-muted-foreground/50"
                    : "bg-destructive",
                )}
              />
              <span className="w-36 shrink-0 truncate text-muted-foreground">
                {TRACE_KIND_TITLE[trace.kind]}
              </span>
              <span className="min-w-0 flex-1 truncate">{trace.label}</span>
              {trace.status === "ok" ? null : (
                <span className="sr-only">
                  {TRACE_STATUS_TITLE[trace.status]}
                </span>
              )}
              <time
                dateTime={new Date(trace.at).toISOString()}
                title={new Date(trace.at).toLocaleString()}
                className="w-9 shrink-0 text-right tabular-nums text-muted-foreground"
              >
                {relativeAge(trace.at, now)}
              </time>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** JSON with keys sorted, so two answers compare by content. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, item]) => [k, sort(item)]),
          )
        : v;
  return JSON.stringify(sort(value));
}

/**
 * Which top-level fields of two parsed results differ: none when they match,
 * `["*"]` when they aren't comparable objects.
 */
function changedFields(a: unknown, b: unknown): string[] {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    Boolean(v) && typeof v === "object" && !Array.isArray(v);
  if (!isObject(a) || !isObject(b))
    return canonical(a) === canonical(b) ? [] : ["*"];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (key) => canonical(a[key]) !== canonical(b[key]),
  );
}

function TraceDetail({
  rpc,
  id,
  close,
}: {
  rpc: Rpc;
  id: string;
  close: () => void;
}) {
  const navigate = useBbNavigate();
  const [trace, setTrace] = useState<Trace | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    const result = await rpc.call("trace", { id });
    setTrace(result.trace);
  }, [rpc, id]);
  useEffect(() => {
    load().catch((cause: unknown) => setError(message(cause)));
  }, [load]);

  if (trace === undefined)
    return (
      <p className="px-4 py-4 text-xs text-muted-foreground">
        {error ?? "Loading…"}
      </p>
    );
  if (trace === null)
    return (
      <p className="px-4 py-4 text-sm text-muted-foreground">
        This model call is no longer stored.
      </p>
    );

  const replay = async () => {
    setReplaying(true);
    setError(null);
    try {
      await rpc.call("traceReplay", { id: trace.id });
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setReplaying(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json(trace));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (cause) {
      setError(message(cause));
    }
  };
  const threads = trace.links.filter((l) => l.kind === "thread");
  const usage = trace.usage;

  return (
    <article
      aria-label={TRACE_KIND_TITLE[trace.kind]}
      className="px-4 pb-8 pt-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{TRACE_KIND_TITLE[trace.kind]}</h3>
        <StatusBadge status={trace.status} />
        <span className="flex-1" />
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
          {copied ? "Copied" : "Copy JSON"}
        </button>
        <button
          type="button"
          onClick={() => void replay()}
          disabled={replaying}
          title="Makes a paid model call using the recorded prompt. Stores a comparison trace without changing memory or placements."
          className={smallButton}
        >
          <Icon
            name={replaying ? "Loading" : "ArrowReloadHorizontal"}
            aria-hidden
            className={cn(
              "size-3.5",
              replaying && "animate-spin motion-reduce:animate-none",
            )}
          />
          {replaying ? "Running…" : "Run again"}
        </button>
      </div>
      <p className="mt-1 text-sm">{trace.label}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        <time dateTime={new Date(trace.at).toISOString()}>
          {new Date(trace.at).toLocaleString()}
        </time>
        {" · "}
        {trace.model}
        {" · "}
        {(trace.durationMs / 1000).toFixed(1)}s
        {usage
          ? ` · ${usage.input.toLocaleString()} in / ${usage.output.toLocaleString()} out · $${usage.cost.toFixed(4)}`
          : ""}
      </p>
      {threads.length ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          About
          {threads.slice(0, 8).map((link) => (
            <button
              key={link.ref}
              type="button"
              onClick={() => {
                navigate.toThread(link.ref);
                close();
              }}
              className="max-w-56 cursor-pointer truncate rounded border border-border px-1.5 py-px text-foreground hover:bg-state-hover"
            >
              <ThreadTitle threadId={link.ref} />
            </button>
          ))}
          {threads.length > 8 ? `and ${threads.length - 8} more` : null}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {trace.error ? (
        <p className="mt-3 whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
          {trace.error}
        </p>
      ) : null}

      {(trace.kind === "route" || trace.kind === "analysis") &&
      !trace.replayOf ? (
        <RetrievalLineage rpc={rpc} traceId={trace.id} close={close} />
      ) : null}
      {trace.links.some(
        (l) => l.kind === "account" || l.kind === "observation",
      ) ? (
        <div
          className="mt-3 flex flex-wrap gap-2 text-xs"
          aria-label="Memory provenance"
        >
          {trace.links
            .filter((l) => l.kind === "account" || l.kind === "observation")
            .slice(0, 30)
            .map((link) => (
              <button
                key={`${link.kind}:${link.ref}`}
                type="button"
                className={smallButton}
                onClick={() => {
                  navigate.toPluginPanel("home", {
                    subPath: `understanding/${link.kind === "account" ? "accounts" : "evidence"}/${encodeURIComponent(link.ref)}`,
                  });
                  close();
                }}
              >
                {link.kind === "account"
                  ? "Explore account"
                  : "Explore evidence"}{" "}
                · {link.ref.slice(0, 8)}
              </button>
            ))}
        </div>
      ) : null}
      <div className="mt-4 flex flex-col gap-1">
        {trace.parsed !== null ? (
          <Section
            title="Result"
            hint="The validated model response; application is recorded separately"
            open
          >
            <Code content={json(trace.parsed)} label="Result" />
          </Section>
        ) : null}
        {trace.outcome !== null ? (
          <Section title="What Workstreams did" open>
            <Code content={json(trace.outcome)} label="What Workstreams did" />
          </Section>
        ) : null}
        <Section
          title="Reasoning"
          hint="The model's own summary of its thinking"
          open
        >
          {trace.reasoning ? (
            <Reasoning text={trace.reasoning} />
          ) : (
            <p className="text-xs text-muted-foreground">
              The model returned no reasoning for this call (thinking:{" "}
              {trace.thinking || "off"}).
            </p>
          )}
        </Section>
        <Section
          title="Raw response"
          hint={
            trace.stopReason ? `stop reason: ${trace.stopReason}` : undefined
          }
          open={trace.status === "invalid"}
        >
          {trace.response !== null ? (
            <Code content={trace.response} label="Raw response" />
          ) : (
            <p className="text-xs text-muted-foreground">No response.</p>
          )}
        </Section>
        <Section
          title="Prompt"
          hint={`${trace.prompt.length.toLocaleString()} characters`}
        >
          <p className="mb-2 text-xs text-muted-foreground">
            System: {trace.system} · {trace.provider} · thinking{" "}
            {trace.thinking || "off"}
          </p>
          <Code content={trace.prompt} label="Prompt" />
        </Section>
        {trace.input !== null ? (
          <Section
            title="Input"
            hint="What the prompt was built from, redacted"
          >
            <Code content={json(trace.input)} label="Input" />
          </Section>
        ) : null}
        {trace.replays.length ? (
          <Section
            title="Replays"
            hint={`${trace.replays.length} run${trace.replays.length === 1 ? "" : "s"} of the same prompt`}
            open
          >
            <ul className="flex flex-col gap-2">
              {trace.replays.map((summary) => (
                <Replay
                  key={summary.id}
                  rpc={rpc}
                  id={summary.id}
                  original={trace}
                />
              ))}
            </ul>
          </Section>
        ) : null}
      </div>
    </article>
  );
}

const smallButton =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60";

function Replay({
  rpc,
  id,
  original,
}: {
  rpc: Rpc;
  id: string;
  original: Trace;
}) {
  const [trace, setTrace] = useState<Trace | null>(null);
  useEffect(() => {
    let live = true;
    void rpc
      .call("trace", { id })
      .then((result) => live && setTrace(result.trace))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [rpc, id]);
  if (!trace)
    return <li className="text-xs text-muted-foreground">Loading…</li>;
  const changed = changedFields(original.parsed, trace.parsed);
  return (
    <li className="rounded-md border border-border">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-xs [&::-webkit-details-marker]:hidden">
          <span
            aria-hidden
            className="inline-block text-muted-foreground transition-transform group-open:rotate-90"
          >
            ›
          </span>
          <time
            dateTime={new Date(trace.at).toISOString()}
            className="tabular-nums text-muted-foreground"
          >
            {new Date(trace.at).toLocaleTimeString()}
          </time>
          <span className="text-muted-foreground">
            {(trace.durationMs / 1000).toFixed(1)}s
          </span>
          <span className="flex-1" />
          {trace.status !== "ok" ? (
            <StatusBadge status={trace.status} />
          ) : (
            <span
              className={
                changed.length === 0
                  ? "text-muted-foreground"
                  : "min-w-0 truncate font-medium text-foreground"
              }
            >
              {changed.length === 0
                ? "Same result"
                : changed[0] === "*"
                  ? "Different result"
                  : `Differs in ${changed.join(", ")}`}
            </span>
          )}
        </summary>
        <div className="flex flex-col gap-3 border-t border-border px-2.5 py-2">
          {trace.error ? (
            <p className="font-mono text-xs text-destructive">{trace.error}</p>
          ) : null}
          {trace.parsed !== null ? (
            <Code content={json(trace.parsed)} label="Replay result" />
          ) : null}
          {trace.reasoning ? <Reasoning text={trace.reasoning} /> : null}
          {trace.parsed === null && trace.response !== null ? (
            <Code content={trace.response} label="Replay response" />
          ) : null}
        </div>
      </details>
    </li>
  );
}

/**
 * A reasoning summary as paragraphs with bold and inline code. It is model
 * output steered by thread text, so nothing else renders: no links, no
 * images.
 */
function Reasoning({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 text-[13px] leading-relaxed">
      {text.split(/\n{2,}/).map((paragraph, i) => (
        <p key={i} className="whitespace-pre-wrap break-words">
          {paragraph.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, j) =>
            part.length > 4 && part.startsWith("**") && part.endsWith("**") ? (
              <strong key={j}>{part.slice(2, -2)}</strong>
            ) : part.length > 2 &&
              part.startsWith("`") &&
              part.endsWith("`") ? (
              <code
                key={j}
                className="rounded bg-state-hover px-1 font-mono text-xs"
              >
                {part.slice(1, -1)}
              </code>
            ) : (
              part
            ),
          )}
        </p>
      ))}
    </div>
  );
}

function Section({
  title,
  hint,
  open = false,
  children,
}: {
  title: string;
  hint?: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open} className="group rounded-md">
      <summary className="-mx-1.5 flex cursor-pointer list-none items-baseline gap-1.5 rounded-md px-1.5 py-1.5 text-xs hover:bg-state-hover [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="inline-block w-2 text-muted-foreground transition-transform group-open:rotate-90"
        >
          ›
        </span>
        <span className="font-semibold">{title}</span>
        {hint ? (
          <span className="truncate text-muted-foreground">{hint}</span>
        ) : null}
      </summary>
      <div className="pb-3 pl-3.5 pt-1">{children}</div>
    </details>
  );
}

/**
 * Monospace text that wraps. Long blocks scroll inside the section so the pane
 * stays navigable. (BB's source viewer needs a fixed-height container, which
 * these content-sized blocks don't have.)
 */
function Code({ content, label }: { content: string; label: string }) {
  return (
    <pre
      aria-label={label}
      className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-state-hover/40 p-3 font-mono text-xs leading-[18px]"
    >
      {content}
    </pre>
  );
}
