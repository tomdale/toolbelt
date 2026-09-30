import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown, useComposerView, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import { parseRecapLedger } from "../../domain/recap.ts";
import { useArchiveSuggestion } from "../archive/useArchiveSuggestion.ts";

type Recap = { summary: string; generatedAt: number };

const CARD_CLASS =
  "@container/recap relative mx-auto mb-3 w-full min-w-0 max-w-4xl rounded-lg border border-sky-200/80 bg-sky-50 px-4 py-3 text-sky-900 dark:border-sky-800/50 dark:bg-sky-950/60 dark:text-sky-200";

// Both columns share one body size and line height so their labels and first
// lines sit on the same baselines; hierarchy comes from weight and opacity.
const LABEL_CLASS =
  "mb-1 text-[10.5px] font-semibold uppercase leading-4 tracking-[0.08em] text-sky-900/50 dark:text-sky-200/45";
const BODY_CLASS =
  "text-[clamp(0.625rem,calc(0.4375rem+0.9375cqi),0.8125rem)] leading-[1.5] [text-wrap:pretty]";
const GOAL_CLASS =
  "text-[clamp(0.625rem,calc(0.375rem+1.25cqi),0.875rem)] leading-[1.43] [text-wrap:wrap]";

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
    <svg aria-hidden="true" viewBox="0 0 12 12" className="mt-[4px] h-3 w-3 opacity-60" fill="none">
      <path d="M2.5 6.25 4.9 8.5 9.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LedgerList({ items, label, done = false }: { items: string[]; label: string; done?: boolean }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3 className={LABEL_CLASS}>{label}</h3>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li
            key={index}
            className={`grid grid-cols-[12px_minmax(0,1fr)] gap-x-2 ${BODY_CLASS} ${done ? "opacity-70" : ""}`}
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
function RecapSummary({ summary }: { summary: string }) {
  const ledger = parseRecapLedger(summary);
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
        {ledger.latest.length > 0 ? (
          <section>
            <h3 className={LABEL_CLASS}>Latest</h3>
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
        ) : (
          <div />
        )}
        {hasLedger ? (
          <div className="space-y-2.5 border-sky-900/10 @lg/recap:border-l @lg/recap:pl-6 dark:border-sky-200/10">
            <LedgerList items={ledger.open} label="Open" />
            <LedgerList items={ledger.done} label="Done" done />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function useRecap(threadId: string | null): Recap | null {
  const rpc = useRpc<RpcContract>();
  const [recap, setRecap] = useState<Recap | null>(null);
  const load = () => {
    if (!threadId) return setRecap(null);
    void rpc.call("recap_get", { threadId }).then((value) => setRecap(value.recap));
  };
  useEffect(load, [rpc, threadId]);
  useRealtime("changed", load);
  return recap;
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
  const recap = useRecap(threadId);
  const archive = useArchiveSuggestion(threadId, continuing);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const [inlineEditor, setInlineEditor] = useState(false);

  // BB exposes no inline-editor flag on the composer view; its frame marker is
  // the only signal.
  useLayoutEffect(() => {
    setInlineEditor(Boolean(markerRef.current?.closest("[data-inline-message-editor-frame]")));
  });

  const visible =
    threadId !== null && !continuing && !inlineEditor && recap !== null && recap.generatedAt !== dismissedAt;

  return (
    <div ref={markerRef} className="contents">
      {visible ? (
        <div className={CARD_CLASS} role="region" aria-label="Latest recap">
          <div className="@max-[20rem]/recap:[&_*]:!text-[0.625rem] @max-[20rem]/recap:[&_*]:!font-normal @max-[20rem]/recap:[&_*]:!leading-[1.5] @max-[20rem]/recap:[&_*]:!tracking-normal">
            <RecapSummary summary={recap.summary} />
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
      ) : null}
    </div>
  );
}
