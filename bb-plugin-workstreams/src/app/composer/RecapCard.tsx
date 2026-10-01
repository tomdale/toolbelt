import type { Dispatch, RefObject, SetStateAction } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Markdown,
  UrlLink,
  experimental_FileLink as FileLink,
  experimental_useSidebarThreads,
  useComposer,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { Recap, RecapLink } from "../../domain/recap.ts";
import type { RecapLayout } from "../../domain/recapPrefs.ts";
import { useRecapPrefs } from "../recap/prefs.ts";
import { useArchiveSuggestion } from "../archive/useArchiveSuggestion.ts";
import {
  animateCardIn,
  animateCardOut,
  followResizes,
  growSlot,
  holdSpace,
} from "./recapMotion.ts";
import { useContinuing } from "./useContinuing.ts";
import type { HeldSpace } from "./recapMotion.ts";

const CARD_CLASS =
  "@container/recap relative mx-auto mb-3 w-full min-w-0 max-w-4xl rounded-lg border border-sky-400 bg-sky-50/40 px-4 py-3 text-sky-900 dark:border-sky-500/80 dark:bg-[color-mix(in_oklab,var(--background)_85%,oklch(29.3%_0.066_243.157))] dark:text-sky-200";

// What happened is the card's primary text.
const BODY_CLASS =
  "text-[clamp(0.625rem,calc(0.4375rem+0.9375cqi),0.8125rem)] leading-[1.5] [text-wrap:pretty]";
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

function Bullets({ items }: { items: string[] }) {
  if (items.length === 1)
    return <RecapText text={items[0]!} className="text-foreground" />;
  return (
    <ul className="space-y-1">
      {items.map((item, index) => (
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
  );
}

function Links({
  links,
  environmentId,
}: {
  links: RecapLink[];
  environmentId: string | null;
}) {
  if (links.length === 0) return null;
  return (
    <ul
      aria-label="Links"
      className={`mt-1.5 flex flex-wrap gap-x-4 gap-y-1 ${BODY_CLASS} font-medium text-sky-700 dark:text-sky-300`}
    >
      {links.map((link, index) => (
        <li key={index} className="min-w-0 truncate">
          {link.location.startsWith("https://") ? (
            <UrlLink href={link.location}>{link.title}</UrlLink>
          ) : environmentId ? (
            <FileLink
              target={{ kind: "workspace", environmentId, path: link.location }}
            >
              {link.title}
            </FileLink>
          ) : (
            <span title={link.location}>{link.title}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The goal as a heading, the latest results, then the review check. */
function RecapSummary({
  recap,
  layout,
  environmentId,
}: {
  recap: Recap;
  layout: RecapLayout;
  environmentId: string | null;
}) {
  const goal = layout === "full" ? recap.goal : null;
  return (
    <div>
      {goal ? (
        <div
          role="heading"
          aria-level={2}
          className="pr-7 font-medium tracking-[-0.006em] text-sky-700 dark:text-sky-300"
        >
          <RecapText
            text={goal}
            className="w-full max-w-none"
            typeClass={GOAL_CLASS}
          />
        </div>
      ) : null}
      {/* The first line clears the dismiss button in the corner. */}
      <section className={goal ? "mt-1.5" : "pr-7"}>
        <h3 className="sr-only">Latest</h3>
        <Bullets items={recap.latest} />
      </section>
      {recap.review ? (
        <section className="mt-2.5 text-foreground">
          <h3 className={`${BODY_CLASS} font-medium`}>Review</h3>
          <RecapText text={recap.review} />
          <Links links={recap.links} environmentId={environmentId} />
        </section>
      ) : (
        <Links links={recap.links} environmentId={environmentId} />
      )}
    </div>
  );
}

type RecapResponse = {
  recap: Recap | null;
  capped: boolean;
  corrections: number;
  environmentId: string | null;
};
const EMPTY: RecapResponse = {
  recap: null,
  capped: false,
  corrections: 0,
  environmentId: null,
};

function useRecap(threadId: string | null) {
  const rpc = useRpc<RpcContract>();
  const [state, setState] = useState<RecapResponse>(EMPTY);
  const version = useRef(0);
  const load = () => {
    const current = ++version.current;
    if (!threadId) return setState(EMPTY);
    void rpc
      .call("recap_get", { threadId })
      .then((next) => {
        if (current === version.current) setState(next);
      })
      .catch(() => {});
  };
  useEffect(load, [rpc, threadId]);
  useRealtime("changed", load);
  const dismiss = async (recapId: string) => {
    if (!threadId) return;
    // Hidden at once; the server's copy keeps it hidden on every client.
    setState((current) =>
      current.recap?.id === recapId ? { ...current, recap: null } : current,
    );
    await rpc.call("recap_dismiss", { threadId, recapId }).catch(() => {});
    load();
  };
  return { ...state, dismiss };
}

type CardProps = {
  recap: Recap;
  layout: RecapLayout;
  environmentId: string | null;
  showArchive: boolean;
  archiveBusy: boolean;
  archiveError: string | null;
};

function CardBody({
  recap,
  layout,
  environmentId,
  showArchive,
  archiveBusy,
  archiveError,
  onArchive,
  onDismiss,
}: CardProps & { onArchive?: () => void; onDismiss?: () => void }) {
  return (
    <>
      <div className="@max-[20rem]/recap:[&_*]:!text-[0.625rem] @max-[20rem]/recap:[&_*]:!font-normal @max-[20rem]/recap:[&_*]:!leading-[1.5] @max-[20rem]/recap:[&_*]:!tracking-normal">
        <RecapSummary
          recap={recap}
          layout={layout}
          environmentId={environmentId}
        />
      </div>
      {archiveError ? (
        <p
          role="alert"
          className="mt-2 text-center text-[11px] text-red-700 dark:text-red-300"
        >
          {archiveError}
        </p>
      ) : null}
      {/* Archive is the card's only footer, so a card without it stays short. */}
      {showArchive ? (
        <div className="mt-3 flex justify-center">
          {/* The card's one action, filled in its own accent. Minimal
              recaps get a compact button to match. */}
          <Button
            size={layout === "full" ? "default" : "sm"}
            className={cn(
              "bg-sky-600 text-white shadow-sm hover:bg-sky-700 dark:bg-sky-400 dark:text-sky-950 dark:hover:bg-sky-300",
              layout === "full" && "px-5",
            )}
            disabled={archiveBusy}
            onClick={onArchive}
          >
            <Icon
              name="Archive"
              aria-hidden
              className={layout === "full" ? "size-4" : "size-3.5"}
            />
            Archive
          </Button>
        </div>
      ) : null}
      <button
        type="button"
        className="absolute right-2.5 top-2.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-sky-900/50 transition-colors hover:bg-sky-900/10 hover:text-sky-900/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500 dark:text-sky-200/50 dark:hover:bg-sky-200/10 dark:hover:text-sky-200/80"
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
    </>
  );
}

/**
 * The slot a hidden card leaves behind. `ghost` is the card as last shown,
 * dissolving inside the slot.
 */
type Hold = {
  /** Unique per exit, so a new exit never resumes an earlier one's effect. */
  id: number;
  height: number;
  ghost: CardProps | null;
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
 * Runs one hold: dissolves the ghost and keeps the slot's space until new
 * timeline content has used it (see recapMotion.ts), so nothing above the
 * card moves. Clears the hold once the slot is gone.
 */
function useHold(
  hold: Hold | null,
  slotRef: RefObject<HTMLDivElement | null>,
  ghostRef: RefObject<HTMLDivElement | null>,
  setHold: Dispatch<SetStateAction<Hold | null>>,
) {
  const id = hold?.id ?? null;

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
    const out = ghostRef.current ? animateCardOut(ghostRef.current) : null;
    slotReady = true;
    space = holdSpace(slot, clear, () => dissolving);
    clearIfUnheld();
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
      space?.dispose();
    };
    // One id is one exit; later updates to the same hold must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}

/**
 * The agent's recap of the thread's latest turn, above the composer, with
 * dismiss in its top-right corner and, when the thread can be archived,
 * Archive centered under it. It stays up while the user drafts,
 * so they can refer to it in their message, and hides once a message is sent
 * or the thread runs, while a question card is open, and inside the inline
 * message editor.
 *
 * Hiding never moves the thread: the card dissolves inside its slot, and the
 * slot shrinks only as new content grows into it.
 */
export function RecapCard() {
  const { scope, isEmpty, attachmentCount, isRunning, isSubmitting } =
    useComposer();
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const { threads } = experimental_useSidebarThreads();
  const hasPendingInteraction = threads.some(
    (thread) => thread.id === threadId && thread.hasPendingInteraction,
  );
  // Archive is no suggestion for a thread the user is writing into, but the
  // recap stays readable until the message goes out.
  const continuing = useContinuing({
    drafting: !isEmpty || attachmentCount > 0,
    isSubmitting,
    isRunning,
  });
  const sending = useContinuing({ drafting: false, isSubmitting, isRunning });
  const { recap, capped, corrections, environmentId, dismiss } =
    useRecap(threadId);
  const { prefs } = useRecapPrefs();
  const layout: RecapLayout = prefs?.layout ?? "full";
  const archive = useArchiveSuggestion(threadId, recap, continuing);
  const markerRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shownHeight = useRef(0);
  const lastFrame = useRef<CardProps | null>(null);
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

  // The live question card owns the turn's ending until it is resolved.
  const available =
    threadId !== null && !sending && !inlineEditor && !hasPendingInteraction;
  const frame: CardProps | null =
    available && recap
      ? {
          recap,
          layout,
          environmentId,
          showArchive: archive.visible,
          archiveBusy: archive.busy,
          archiveError: archive.error,
        }
      : null;

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
    if (!inlineEditor && lastFrame.current && shownHeight.current > 0)
      setHold({
        id: ++holdCount,
        height: shownHeight.current,
        ghost: lastFrame.current,
      });
  }

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
          <div
            ref={cardRef}
            className={CARD_CLASS}
            role="region"
            aria-label="Latest recap"
          >
            {/* The card's only in-flow child, so its height drives resizes. */}
            <div ref={bodyRef}>
              <CardBody
                {...frame}
                onArchive={() => void archive.archive()}
                onDismiss={() => void dismiss(frame.recap.id)}
              />
            </div>
          </div>
        </div>
      ) : hold ? (
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
                <CardBody {...hold.ghost} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {!frame && available && capped ? (
        <p
          role="status"
          className="mx-auto mb-3 w-full max-w-4xl px-1 text-center text-xs text-muted-foreground"
          style={FIRST}
        >
          No recap after {corrections}{" "}
          {corrections === 1 ? "reminder" : "reminders"}. Send a message to
          continue the thread.
        </p>
      ) : null}
    </div>
  );
}
