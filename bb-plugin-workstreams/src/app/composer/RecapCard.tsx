import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown, useComposerView, useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import { parseRecapLedger } from "../../domain/recap.ts";
import { useArchiveSuggestion } from "../archive/useArchiveSuggestion.ts";

type Recap = { summary: string; generatedAt: number };
type Layout = "detailed" | "compact" | "minimal";

const CARD_CLASS =
  "@container/recap relative mx-auto mb-3 w-full min-w-0 max-w-4xl rounded-lg border border-sky-400 bg-sky-50/40 px-4 py-3 text-sky-900 dark:border-sky-500/80 dark:bg-[color-mix(in_oklab,var(--background)_85%,oklch(29.3%_0.066_243.157))] dark:text-sky-200";

// Both columns share one body size and line height so their labels and first
// lines sit on the same baselines; hierarchy comes from weight and opacity.
const LABEL_CLASS =
  "mb-1 text-[10.5px] font-semibold uppercase leading-4 tracking-[0.08em] text-sky-900/50 dark:text-sky-200/45";
const BODY_CLASS =
  "text-[clamp(0.625rem,calc(0.4375rem+0.9375cqi),0.8125rem)] leading-[1.5] [text-wrap:pretty]";
const GOAL_CLASS =
  "text-[clamp(0.75rem,calc(0.5rem+1.5cqi),1rem)] leading-[1.4] [text-wrap:wrap]";

/**
 * One recap line through BB's markdown, so inline code, emphasis, and links
 * survive. The overrides keep BB's paragraph and code styles inside the
 * recap's type scale.
 */
function RecapText({
  text,
  className = "",
  typeClass = BODY_CLASS,
}: {
  text: string;
  className?: string;
  typeClass?: string;
}) {
  return (
    <Markdown
      content={text}
      className={`min-w-0 ${typeClass} text-inherit [&_*]:!text-inherit [&_*]:!text-[length:inherit] [&_*]:!leading-[inherit] [&_p]:!m-0 [&_code]:!rounded [&_code]:!px-1 [&_code]:!py-px [&_code]:!text-[0.923em] ${className}`}
    />
  );
}

function OpenMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="mt-[4px] h-3 w-3 opacity-60" fill="none">
      <circle cx="6" cy="6" r="4.25" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

function DoneMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="mt-[4px] h-3 w-3 text-sky-950 opacity-60 dark:text-sky-50" fill="none">
      <path d="M2.5 6.25 4.9 8.5 9.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LedgerList({ items, label, done = false }: { items: string[]; label: string; done?: boolean }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3 className="sr-only">{label}</h3>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li
            key={index}
            className={`grid grid-cols-[12px_minmax(0,1fr)] gap-x-2 ${BODY_CLASS} ${
              done
                ? "text-sky-900/60 dark:text-sky-200/60 [&_p]:line-through [&_p]:decoration-slate-400/60 dark:[&_p]:decoration-neutral-900"
                : "text-sky-950 dark:text-sky-50"
            }`}
          >
            {done ? <DoneMark /> : <OpenMark />}
            <RecapText text={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The goal as a heading, then the latest results beside an Open/Done column.
 * A recap that is not a ledger renders as plain markdown.
 */
function RecapSummary({
  summary,
  layout,
  needsInput,
}: {
  summary: string;
  layout: Layout;
  needsInput: string | null;
}) {
  const parsed = parseRecapLedger(summary);
  const ledger = parsed && {
    ...parsed,
    goal: layout === "minimal" ? null : parsed.goal,
    open: layout === "detailed" ? parsed.open : [],
    done: layout === "detailed" ? parsed.done : [],
  };
  if (!ledger) {
    return (
      <Markdown
        content={summary}
        className="pr-6 text-[clamp(0.625rem,calc(0.4375rem+0.9375cqi),0.8125rem)] leading-[1.75] text-inherit"
      />
    );
  }
  const hasLedger = ledger.open.length > 0 || ledger.done.length > 0;
  return (
    <div>
      {ledger.goal ? (
        <div role="heading" aria-level={2} className="pr-24 font-medium tracking-[-0.006em] text-sky-950 dark:text-sky-50">
          <RecapText text={ledger.goal} className="w-full max-w-none" typeClass={GOAL_CLASS} />
        </div>
      ) : null}
      <div
        className={`${ledger.goal ? "mt-2.5" : "pr-24"} grid gap-x-6 gap-y-3 ${
          hasLedger ? "@lg/recap:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]" : ""
        }`}
      >
        <div className="space-y-2.5">
        {needsInput ? (
          <section>
            <h3 className={`${LABEL_CLASS} !text-amber-700 dark:!text-amber-300/90`}>Needs input</h3>
            <RecapText text={needsInput} className="font-medium text-sky-950/90 dark:text-sky-100/90" />
          </section>
        ) : null}
        {ledger.latest.length > 0 ? (
          <section>
            <h3 className="sr-only">Latest</h3>
            {ledger.latest.length === 1 ? (
              <RecapText text={ledger.latest[0]!} className="text-sky-950/90 dark:text-sky-100/90" />
            ) : (
              <ul className="space-y-1">
                {ledger.latest.map((item, index) => (
                  <li
                    key={index}
                    className={`grid grid-cols-[12px_minmax(0,1fr)] gap-x-2 ${BODY_CLASS} text-sky-950/90 dark:text-sky-100/90`}
                  >
                    <span aria-hidden="true" className="ml-[4px] mt-[8px] h-1 w-1 rounded-full bg-current opacity-60" />
                    <RecapText text={item} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
        </div>
        {hasLedger ? (
          <div className="space-y-1 border-sky-900/10 @lg/recap:border-l @lg/recap:pl-6 dark:border-sky-200/10">
            <LedgerList items={ledger.open} label="Open" />
            <LedgerList items={ledger.done} label="Done" done />
          </div>
        ) : null}
      </div>
    </div>
  );
}

type RecapState = { recap: Recap | null; generating: boolean; needsInput: string | null };
const EMPTY: RecapState = { recap: null, generating: false, needsInput: null };

function useRecap(threadId: string | null) {
  const rpc = useRpc<RpcContract>();
  const [state, setState] = useState<RecapState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    if (!threadId) return setState(EMPTY);
    void rpc.call("recap_get", { threadId }).then(setState);
  };
  useEffect(load, [rpc, threadId]);
  useRealtime("changed", load);
  const generate = async () => {
    if (!threadId) return;
    setError(null);
    setState((current) => ({ ...current, generating: true }));
    try {
      const result = await rpc.call("recap_generate", { threadId });
      if (!result.generated) setError("Couldn't generate a recap for this thread yet.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    load();
  };
  return { ...state, error, generate };
}

const SETTLE_MS = 1_500;

/**
 * True once the thread has been idle for SETTLE_MS, so brief idle gaps
 * between agent steps don't flash Generate Recap.
 */
function useSettled(busy: boolean): boolean {
  const [settled, setSettled] = useState(!busy);
  useEffect(() => {
    if (busy) return setSettled(false);
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [busy]);
  return settled && !busy;
}

/** Holds the recap's place at a similar size so the result lands in place. */
function Skeleton({ layout }: { layout: Layout }) {
  const bar = "rounded-full bg-sky-900/10 dark:bg-sky-200/15";
  return (
    <div className={CARD_CLASS} role="status" aria-live="polite" aria-label="Generating recap">
      <div className="flex items-center gap-2 text-xs font-medium text-sky-900/70 dark:text-sky-200/70">
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 animate-spin" fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
          <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        Generating recap…
      </div>
      <div aria-hidden="true" className="mt-3 animate-pulse">
        {layout !== "minimal" ? <div className={`mb-3.5 h-2.5 w-2/5 ${bar}`} /> : null}
        <div className={`grid gap-x-6 gap-y-2 ${layout === "detailed" ? "@lg/recap:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]" : ""}`}>
          <div className="space-y-2">
            <div className={`h-2 w-full ${bar}`} />
            <div className={`h-2 w-3/4 ${bar}`} />
          </div>
          {layout === "detailed" ? (
            <div className="space-y-2 border-sky-900/10 @lg/recap:border-l @lg/recap:pl-6 dark:border-sky-200/10">
              <div className={`h-2 w-5/6 ${bar}`} />
              <div className={`h-2 w-2/3 ${bar}`} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The thread's recap above the composer, with Archive in its top-right corner
 * when the thread is eligible. Hidden while the thread runs, while the user
 * writes a continuation, and inside the inline message editor. Dismissal is
 * keyed by the recap's generation time, so a newer recap reappears.
 */
export function RecapCard() {
  const { scope, draft, run } = useComposerView();
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const continuing = !draft.isEmpty || draft.attachmentCount > 0 || run.isRunning || run.isSubmitting;
  const { recap, generating, needsInput, error, generate } = useRecap(threadId);
  const { values } = useSettings();
  const layout = ((values?.recapLayout as Layout | undefined) ?? "detailed");
  const automatic = values?.recapAutomatic !== false;
  const settled = useSettled(run.isRunning || run.isSubmitting);
  const archive = useArchiveSuggestion(threadId, continuing);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const [inlineEditor, setInlineEditor] = useState(false);

  // BB exposes no inline-editor flag on the composer view; its frame marker is
  // the only signal.
  useLayoutEffect(() => {
    setInlineEditor(Boolean(markerRef.current?.closest("[data-inline-message-editor-frame]")));
  });

  const available = threadId !== null && !continuing && !inlineEditor;
  const visible = available && recap !== null && recap.generatedAt !== dismissedAt;

  let content: ReactNode = null;
  if (available && generating && (!recap || !automatic)) content = <Skeleton layout={layout} />;
  else if (!visible && available && settled && (!automatic || !recap))
    content = (
      <div className="mx-auto mb-3 flex w-full min-w-0 max-w-4xl flex-col items-center gap-1">
        <button
          type="button"
          className="cursor-pointer rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
          onClick={() => void generate()}
        >
          Generate Recap
        </button>
        {error ? <p role="alert" className="text-[11px] text-red-700 dark:text-red-300">{error}</p> : null}
      </div>
    );

  return (
    <div ref={markerRef} className="contents">
      {content ?? (visible ? (
        <div className={CARD_CLASS} role="region" aria-label="Latest recap">
          <div className="@max-[20rem]/recap:[&_*]:!text-[0.625rem] @max-[20rem]/recap:[&_*]:!font-normal @max-[20rem]/recap:[&_*]:!leading-[1.5] @max-[20rem]/recap:[&_*]:!tracking-normal">
            <RecapSummary summary={recap.summary} layout={layout} needsInput={needsInput} />
          </div>
          <div className="absolute right-2.5 top-2.5 flex items-center gap-1">
            {archive.visible ? (
              <button
                type="button"
                aria-label="Archive thread"
                className="h-6 cursor-pointer rounded-md border border-sky-900/15 px-2 text-[11px] font-medium text-sky-900/70 transition-colors hover:bg-sky-900/10 hover:text-sky-900 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500 disabled:cursor-default disabled:opacity-50 dark:border-sky-200/20 dark:text-sky-200/70 dark:hover:bg-sky-200/10 dark:hover:text-sky-100"
                disabled={archive.busy}
                onClick={() => void archive.decide("archive")}
              >
                Archive
              </button>
            ) : null}
            <button
              type="button"
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-sky-900/50 transition-colors hover:bg-sky-900/10 hover:text-sky-900/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500 dark:text-sky-200/50 dark:hover:bg-sky-200/10 dark:hover:text-sky-200/80"
              aria-label="Dismiss recap"
              title="Dismiss recap"
              onClick={() => setDismissedAt(recap.generatedAt)}
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
          {archive.error ? (
            <p role="alert" className="mt-2 text-[11px] text-red-700 dark:text-red-300">
              {archive.error}
            </p>
          ) : null}
        </div>
      ) : null)}
    </div>
  );
}
