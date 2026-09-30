import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Markdown,
  useComposer,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import { parseRecapLedger } from "../../domain/recap.ts";
import { useRecapPrefs } from "../recap/prefs.ts";
import { useArchiveSuggestion } from "../archive/useArchiveSuggestion.ts";
import {
  animateCardIn,
  animateCardOut,
  collapseSlot,
  crossfadeIn,
  followResizes,
  growSlot,
  holdSpace,
} from "./recapMotion.ts";
import { useContinuing } from "./useContinuing.ts";
import type { HeldSpace } from "./recapMotion.ts";

type Recap = { summary: string; generatedAt: number };
type Layout = "detailed" | "compact" | "minimal";

const CARD_CLASS =
  "@container/recap relative mx-auto mb-3 w-full min-w-0 max-w-4xl rounded-lg border border-sky-400 bg-sky-50/40 px-4 py-3 text-sky-900 dark:border-sky-500/80 dark:bg-[color-mix(in_oklab,var(--background)_85%,oklch(29.3%_0.066_243.157))] dark:text-sky-200";

// What happened is the card's primary text.
const BODY_CLASS =
  "text-[clamp(0.625rem,calc(0.4375rem+0.9375cqi),0.8125rem)] leading-[1.5] [text-wrap:pretty]";
// Open and Done are supplementary reference, a step below the body size.
const LEDGER_CLASS =
  "text-[clamp(0.625rem,calc(0.4375rem+0.75cqi),0.71875rem)] leading-[1.5] [text-wrap:pretty]";
// The For you ask sits between the goal and the body in the hierarchy.
const ASK_CLASS =
  "text-[clamp(0.6875rem,calc(0.4375rem+1.25cqi),0.9375rem)] leading-[1.45] [text-wrap:pretty]";
const GOAL_CLASS =
  "text-[clamp(0.8125rem,calc(0.5rem+1.75cqi),1.0625rem)] leading-[1.4] [text-wrap:wrap]";

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
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      className="mt-[0.2em] h-3 w-3 opacity-60"
      fill="none"
    >
      <circle cx="6" cy="6" r="4.25" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

function DoneMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      className="mt-[0.2em] h-3 w-3 opacity-80"
      fill="none"
    >
      <path
        d="M2.5 6.25 4.9 8.5 9.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LedgerList({
  items,
  label,
  done = false,
}: {
  items: string[];
  label: string;
  done?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3 className="sr-only">{label}</h3>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li
            key={index}
            className={`grid grid-cols-[12px_minmax(0,1fr)] gap-x-2 ${LEDGER_CLASS} ${
              done
                ? "text-sky-900/45 dark:text-sky-200/35 [&_p]:line-through [&_p]:decoration-sky-900/25 [&_p]:decoration-1 dark:[&_p]:decoration-sky-200/25"
                : "text-sky-900/70 dark:text-sky-200/65"
            }`}
          >
            {done ? <DoneMark /> : <OpenMark />}
            <RecapText text={item} typeClass={LEDGER_CLASS} />
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
    // The For you ask is shown on its own; the model often repeats it as an
    // Open item.
    open:
      layout === "detailed"
        ? parsed.open.filter((item) => !sameText(item, needsInput))
        : [],
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
        <div
          role="heading"
          aria-level={2}
          className="pr-24 font-medium tracking-[-0.006em] text-sky-950 dark:text-sky-50"
        >
          <RecapText
            text={ledger.goal}
            className="w-full max-w-none"
            typeClass={GOAL_CLASS}
          />
        </div>
      ) : null}
      {needsInput ? (
        <section
          className={`${ledger.goal ? "mt-1.5" : "pr-24"} ws-amber-text font-medium`}
        >
          <h3 className="sr-only">For you</h3>
          {/* RecapText inherits its color, so the amber goes on the wrapper. */}
          <RecapText text={needsInput} typeClass={ASK_CLASS} />
        </section>
      ) : null}
      <div
        className={`${ledger.goal || needsInput ? "mt-2.5" : "pr-24"} grid gap-x-6 gap-y-3 ${
          hasLedger ? "@lg/recap:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]" : ""
        }`}
      >
        <div className="space-y-2.5">
          {ledger.latest.length > 0 ? (
            <section>
              <h3 className="sr-only">Latest</h3>
              {ledger.latest.length === 1 ? (
                <RecapText
                  text={ledger.latest[0]!}
                  className="text-foreground"
                />
              ) : (
                <ul className="space-y-1">
                  {ledger.latest.map((item, index) => (
                    <li
                      key={index}
                      className={`grid grid-cols-[12px_minmax(0,1fr)] gap-x-2 ${BODY_CLASS} text-foreground`}
                    >
                      <span
                        aria-hidden="true"
                        className="ml-[4px] mt-[0.65em] h-1 w-1 rounded-full bg-current opacity-60"
                      />
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

type RecapState = {
  recap: Recap | null;
  generating: boolean;
  needsInput: string | null;
};
const EMPTY: RecapState = { recap: null, generating: false, needsInput: null };

function sameText(a: string, b: string | null): boolean {
  const norm = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return b !== null && norm(a) === norm(b);
}

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
      if (!result.generated)
        setError("Couldn't generate a recap for this thread yet.");
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

/**
 * Holds the recap's place at a similar size while it generates; the card
 * then eases to the recap's actual size.
 */
function SkeletonBody({ layout }: { layout: Layout }) {
  const bar = "rounded-full bg-sky-900/10 dark:bg-sky-200/15";
  return (
    <>
      <div className="flex items-center gap-2 text-xs font-medium text-sky-900/70 dark:text-sky-200/70">
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5 animate-spin"
          fill="none"
        >
          <circle
            cx="8"
            cy="8"
            r="6"
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="2"
          />
          <path
            d="M14 8a6 6 0 0 0-6-6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        Generating recap…
      </div>
      <div aria-hidden="true" className="mt-3 animate-pulse">
        {layout !== "minimal" ? (
          <div className={`mb-3.5 h-2.5 w-2/5 ${bar}`} />
        ) : null}
        <div
          className={`grid gap-x-6 gap-y-2 ${layout === "detailed" ? "@lg/recap:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]" : ""}`}
        >
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
    </>
  );
}

type CardProps = {
  recap: Recap;
  layout: Layout;
  needsInput: string | null;
  showArchive: boolean;
  archiveBusy: boolean;
  archiveError: string | null;
  onArchive?: () => void;
  onDismiss?: () => void;
};

function CardBody({
  recap,
  layout,
  needsInput,
  showArchive,
  archiveBusy,
  archiveError,
  onArchive,
  onDismiss,
}: CardProps) {
  return (
    <>
      <div className="@max-[20rem]/recap:[&_*]:!text-[0.625rem] @max-[20rem]/recap:[&_*]:!font-normal @max-[20rem]/recap:[&_*]:!leading-[1.5] @max-[20rem]/recap:[&_*]:!tracking-normal">
        <RecapSummary
          summary={recap.summary}
          layout={layout}
          needsInput={needsInput}
        />
      </div>
      <div className="absolute right-2.5 top-2.5 flex items-center gap-1">
        {showArchive ? (
          <button
            type="button"
            aria-label="Archive thread"
            className="h-6 cursor-pointer rounded-md border border-sky-900/15 px-2 text-[11px] font-medium text-sky-900/70 transition-colors hover:bg-sky-900/10 hover:text-sky-900 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500 disabled:cursor-default disabled:opacity-50 dark:border-sky-200/20 dark:text-sky-200/70 dark:hover:bg-sky-200/10 dark:hover:text-sky-100"
            disabled={archiveBusy}
            onClick={onArchive}
          >
            Archive
          </button>
        ) : null}
        <button
          type="button"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-sky-900/50 transition-colors hover:bg-sky-900/10 hover:text-sky-900/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500 dark:text-sky-200/50 dark:hover:bg-sky-200/10 dark:hover:text-sky-200/80"
          aria-label="Dismiss recap"
          title="Dismiss recap"
          onClick={onDismiss}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      {archiveError ? (
        <p
          role="alert"
          className="mt-2 text-[11px] text-red-700 dark:text-red-300"
        >
          {archiveError}
        </p>
      ) : null}
    </>
  );
}

/** What the card shows: its generating skeleton, or a recap. */
type Frame =
  | { kind: "skeleton"; layout: Layout }
  | ({ kind: "recap" } & Omit<CardProps, "onArchive" | "onDismiss">);

/** The card's outer element's accessible identity for what it shows. */
function frameRole(frame: Frame) {
  return frame.kind === "recap"
    ? ({ role: "region", "aria-label": "Latest recap" } as const)
    : ({
        role: "status",
        "aria-live": "polite",
        "aria-label": "Generating recap",
      } as const);
}

function FrameBody({
  frame,
  onArchive,
  onDismiss,
}: {
  frame: Frame;
  onArchive?: () => void;
  onDismiss?: () => void;
}) {
  if (frame.kind === "skeleton") return <SkeletonBody layout={frame.layout} />;
  const { kind: _kind, ...card } = frame;
  return <CardBody {...card} onArchive={onArchive} onDismiss={onDismiss} />;
}

/**
 * The slot a hidden card leaves behind. `ghost` is the card as last shown,
 * dissolving inside the slot; `dismissed` eases the slot shut rather than
 * holding it for new content.
 */
type Hold = {
  /** Unique per exit, so a new exit never resumes an earlier one's effect. */
  id: number;
  height: number;
  dismissed: boolean;
  ghost: Frame | null;
};

let holdCount = 0;

/**
 * The recap goes first in the composer stack. Its slot gives space back from
 * its top edge, so anything stacked above it would jump each time new
 * content fills the slot; first, it only ever borders the thread.
 */
const FIRST = { order: -1 } as const;

/** Appearances this soon after mount are the thread loading, not news. */
const ENTRANCE_AFTER_MS = 1_000;

/**
 * Runs one hold: dissolves the ghost, eases the slot shut for a dismissal,
 * and otherwise keeps the slot's space until new timeline content has used
 * it (see recapMotion.ts). Clears the hold once the slot is gone.
 */
function useHold(
  hold: Hold | null,
  slotRef: RefObject<HTMLDivElement | null>,
  ghostRef: RefObject<HTMLDivElement | null>,
  setHold: Dispatch<SetStateAction<Hold | null>>,
) {
  const id = hold?.id ?? null;
  const dismissed = hold?.dismissed ?? false;

  // A layout effect, so the dissolve starts on the frame the card hides.
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (id === null || !slot) return;
    let live = true;
    let dissolving = true;
    let slotReady = false;
    let space: HeldSpace | null = null;
    const clear = () =>
      setHold((current) => (current?.id === id ? null : current));
    // Outside BB's thread scroller there's no pinned thread to protect, so
    // the slot goes as soon as the ghost has.
    const clearIfUnheld = () => {
      if (live && slotReady && !dissolving && !space) clear();
    };
    const ready = () => {
      if (!live) return;
      slotReady = true;
      space = holdSpace(slot, clear, () => dissolving);
      clearIfUnheld();
    };

    const out = ghostRef.current ? animateCardOut(ghostRef.current) : null;
    const collapse = dismissed
      ? collapseSlot(slot, slot.getBoundingClientRect().height)
      : null;
    if (collapse) void collapse.finished.then(ready);
    else ready();
    void (out?.finished ?? Promise.resolve()).then(() => {
      if (!live) return;
      dissolving = false;
      setHold((current) =>
        current?.id === id && current.ghost
          ? { ...current, ghost: null }
          : current,
      );
      // Releases deferred while the card dissolved can happen now.
      space?.settle();
      clearIfUnheld();
    });
    return () => {
      live = false;
      out?.cancel();
      collapse?.cancel();
      space?.dispose();
    };
    // One id is one exit; later updates to the same hold must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}

/**
 * The thread's recap above the composer, with Archive in its top-right corner
 * when the thread is eligible. It stays up while the user drafts, so they can
 * refer to it in their message, and hides once a message is sent or the
 * thread runs, and inside the inline message editor. Dismissal is
 * keyed by the recap's generation time, so a newer recap reappears.
 *
 * The card eases between sizes as its contents change, e.g. from its
 * generating skeleton to the recap. Hiding never moves the thread: the card
 * dissolves inside its slot, and the slot shrinks only as new content grows
 * into it.
 */
export function RecapCard() {
  const { scope, isEmpty, attachmentCount, isRunning, isSubmitting } =
    useComposer();
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  // Archive is no suggestion for a thread the user is writing into, but the
  // recap stays readable until the message goes out.
  const continuing = useContinuing({
    drafting: !isEmpty || attachmentCount > 0,
    isSubmitting,
    isRunning,
  });
  const sending = useContinuing({ drafting: false, isSubmitting, isRunning });
  const { recap, generating, needsInput, error, generate } = useRecap(threadId);
  const { prefs } = useRecapPrefs();
  const layout: Layout = prefs?.layout ?? "detailed";
  const automatic = prefs?.automatic ?? true;
  const settled = useSettled(isRunning || isSubmitting);
  const archive = useArchiveSuggestion(threadId, continuing);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shownHeight = useRef(0);
  const lastFrame = useRef<Frame | null>(null);
  const [inlineEditor, setInlineEditor] = useState(false);
  const [shown, setShown] = useState(false);
  const [hold, setHold] = useState<Hold | null>(null);
  // How a card that appears after mount comes in: its slot grows from the
  // height it starts at (nothing, or what a hold had left) so the thread
  // makes room gradually, while the card fades in.
  const [entrance, setEntrance] = useState<{ from: number } | null>(null);
  const mountedAt = useRef<number | null>(null);
  useEffect(() => {
    mountedAt.current = performance.now();
  }, []);

  // BB exposes no inline-editor flag on the composer view; its frame marker is
  // the only signal.
  useLayoutEffect(() => {
    setInlineEditor(
      Boolean(markerRef.current?.closest("[data-inline-message-editor-frame]")),
    );
  });

  const available = threadId !== null && !sending && !inlineEditor;
  const dismissedRecap = recap !== null && recap.generatedAt === dismissedAt;
  const visible = available && recap !== null && !dismissedRecap;

  const frame: Frame | null =
    available && generating && (!recap || !automatic)
      ? { kind: "skeleton", layout }
      : visible
        ? {
            kind: "recap",
            recap,
            layout,
            needsInput,
            showArchive: archive.visible,
            archiveBusy: archive.busy,
            archiveError: archive.error,
          }
        : null;

  const content: ReactNode =
    // Generate Recap takes the card's place when there's none to show: no
    // automatic recaps, none written yet, or the user dismissed this one.
    !frame &&
    available &&
    settled &&
    (!automatic || !recap || dismissedRecap) ? (
      <div
        className={cn(
          "mx-auto mb-3 flex w-full min-w-0 max-w-4xl flex-col items-center gap-1",
          // Fades in under the dismissed card as its slot eases shut.
          hold?.dismissed && "ws-fade-in",
        )}
        style={FIRST}
      >
        <button
          type="button"
          className="cursor-pointer rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
          onClick={() => void generate()}
        >
          Generate Recap
        </button>
        {error ? (
          <p
            role="alert"
            className="text-[11px] text-red-700 dark:text-red-300"
          >
            {error}
          </p>
        ) : null}
      </div>
    ) : null;

  // Hide and return transitions are derived during render, so the card's DOM
  // is never removed in a commit that doesn't also add its held slot; any
  // layout in between would clamp the thread's scroll position.
  if (frame) {
    if (!shown) {
      setShown(true);
      // A card that loads with the thread just appears; later ones grow in.
      if (
        !hold &&
        mountedAt.current !== null &&
        performance.now() - mountedAt.current > ENTRANCE_AFTER_MS
      )
        setEntrance({ from: 0 });
    }
    if (hold) {
      setHold(null);
      // The hold's slot is still in the DOM until this render commits, and it
      // may have given back some of its space by now.
      setEntrance({
        from: slotRef.current?.getBoundingClientRect().height ?? 0,
      });
    }
  } else if (shown) {
    setShown(false);
    // A dismissal always eases out, even with Generate Recap taking the
    // card's place below it.
    if (
      (content === null || dismissedRecap) &&
      !inlineEditor &&
      lastFrame.current &&
      shownHeight.current > 0
    )
      setHold({
        id: ++holdCount,
        height: shownHeight.current,
        dismissed: dismissedRecap,
        ghost: lastFrame.current,
      });
  } else if (hold && content !== null && !hold.dismissed) setHold(null);

  useHold(hold, slotRef, ghostRef, setHold);

  // What a hold keeps: the card as last committed, and its slot's height
  // including the card's margin.
  useLayoutEffect(() => {
    if (frame) lastFrame.current = frame;
  });
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!shown || !slot) return;
    const measure = () => {
      shownHeight.current = slot.getBoundingClientRect().height;
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(slot);
    return () => observer.disconnect();
  }, [shown]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    const body = bodyRef.current;
    if (!shown || !card || !body) return;
    return followResizes(card, body);
  }, [shown]);

  // A recap replacing its skeleton fades in while the card grows to fit it.
  const kind = frame?.kind ?? null;
  const lastKind = useRef(kind);
  useLayoutEffect(() => {
    const previous = lastKind.current;
    lastKind.current = kind;
    if (previous === null || kind === null || previous === kind) return;
    if (!bodyRef.current) return;
    return crossfadeIn(bodyRef.current).cancel;
  }, [kind]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    const slot = slotRef.current;
    if (!entrance || !card || !slot) return;
    const grow = growSlot(slot, entrance.from);
    const enter = animateCardIn(card);
    void Promise.all([enter.finished, grow.finished]).then(() =>
      setEntrance(null),
    );
    return () => {
      enter.cancel();
      grow.cancel();
    };
  }, [entrance]);

  return (
    <div ref={markerRef} className="contents">
      {frame ? (
        // flow-root keeps the card's bottom margin inside the measured slot.
        <div key="shown" ref={slotRef} className="flow-root" style={FIRST}>
          <div ref={cardRef} className={CARD_CLASS} {...frameRole(frame)}>
            {/* The card's only in-flow child, so its height drives resizes. */}
            <div ref={bodyRef}>
              <FrameBody
                frame={frame}
                onArchive={() => void archive.decide("archive")}
                onDismiss={() =>
                  frame.kind === "recap" &&
                  setDismissedAt(frame.recap.generatedAt)
                }
              />
            </div>
          </div>
        </div>
      ) : hold && (content === null || hold.dismissed) ? (
        <div
          key={`hold-${hold.id}`}
          ref={slotRef}
          aria-hidden="true"
          className="relative flow-root"
          // Clip only the top edge: content filling the slot from above
          // covers the dissolving card, while its blur and drift stay whole.
          style={{
            ...FIRST,
            height: hold.height,
            clipPath: "inset(0 -3rem -3rem -3rem)",
          }}
        >
          {hold.ghost ? (
            <div
              ref={ghostRef}
              inert
              className="pointer-events-none absolute inset-x-0 bottom-0"
            >
              <div className={CARD_CLASS}>
                <FrameBody frame={hold.ghost} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {content}
    </div>
  );
}
