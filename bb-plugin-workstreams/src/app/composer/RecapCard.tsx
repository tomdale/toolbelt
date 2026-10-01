import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
import {
  fileTarget,
  recapSegments,
  type Recap,
  type RecapFiles,
  type RecapLink,
  type ReviewStep,
} from "../../domain/recap.ts";
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
import { ActivityThreadLink } from "../page/ActivityThreadLink.tsx";
import type { HeldSpace } from "./recapMotion.ts";

const CARD_CLASS =
  "@container/recap relative mx-auto mb-3 w-full min-w-0 max-w-4xl rounded-lg border text-foreground";

/**
 * Each state's accent colors the card's border, background, state line, row
 * labels, and row rules; everything else stays neutral. Dark backgrounds mix
 * the accent's 950 shade into the page background.
 */
const ACCENT: Record<
  Recap["state"],
  { card: string; text: string; rules: string; footer: string }
> = {
  continuing: {
    card: "border-violet-400 bg-violet-50/40 dark:border-violet-500/70 dark:bg-violet-950/20",
    text: "text-violet-700 dark:text-violet-300",
    rules:
      "[&>section+section]:border-violet-900/10 dark:[&>section+section]:border-violet-200/15",
    footer: "border-violet-900/10 dark:border-violet-200/15",
  },
  review: {
    card: "border-sky-400 bg-sky-50/40 dark:border-sky-500/80 dark:bg-[color-mix(in_oklab,var(--background)_85%,oklch(29.3%_0.066_243.157))]",
    text: "text-sky-700 dark:text-sky-300",
    rules:
      "[&>section+section]:border-sky-900/10 dark:[&>section+section]:border-sky-200/15",
    footer:
      "border-sky-900/10 bg-sky-500/[0.05] dark:border-sky-200/15 dark:bg-sky-300/[0.04]",
  },
  complete: {
    card: "border-emerald-400 bg-emerald-50/40 dark:border-emerald-500/70 dark:bg-[color-mix(in_oklab,var(--background)_85%,oklch(26.2%_0.051_172.552))]",
    text: "text-emerald-700 dark:text-emerald-300",
    rules:
      "[&>section+section]:border-emerald-900/10 dark:[&>section+section]:border-emerald-200/15",
    footer:
      "border-emerald-900/10 bg-emerald-500/[0.05] dark:border-emerald-200/15 dark:bg-emerald-300/[0.04]",
  },
};

function cardClass(state: Recap["state"], layout: RecapLayout) {
  return cn(
    CARD_CLASS,
    layout === "minimal" ? "px-3 py-2" : "px-4 py-3",
    ACCENT[state].card,
  );
}

// What happened is the card's primary text.
const BODY_CLASS =
  "text-[clamp(0.625rem,calc(0.4375rem+0.9375cqi),0.8125rem)] leading-[1.5] [text-wrap:pretty]";
const GOAL_CLASS =
  "text-[clamp(0.8125rem,calc(0.5rem+1.75cqi),1.0625rem)] leading-[1.4] [text-wrap:wrap]";
// The compact layout steps every size down so the card stays short.
const COMPACT_BODY_CLASS =
  "text-[clamp(0.625rem,calc(0.375rem+0.875cqi),0.75rem)] leading-[1.45] [text-wrap:pretty]";
const COMPACT_GOAL_CLASS =
  "text-[clamp(0.6875rem,calc(0.375rem+1.375cqi),0.875rem)] leading-[1.35] [text-wrap:wrap]";

/** True inside a compact card; selects the smaller type scale. */
const CompactContext = createContext(false);
const useBodyClass = () =>
  useContext(CompactContext) ? COMPACT_BODY_CLASS : BODY_CLASS;

const MARKDOWN_CLASS =
  "text-inherit [&_*]:!text-inherit [&_*]:!text-[length:inherit] [&_*]:!leading-[inherit] [&_p]:!m-0 [&_code]:!rounded [&_code]:!px-1 [&_code]:!py-px [&_code]:!text-[0.923em]";

/**
 * A commit hash, shortened, in two faint tints that set letters apart from
 * digits rather than styling it as a link. A copy icon follows it, and clicking
 * copies the full hash.
 */
function Sha({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={copied ? "Copied" : `Copy ${sha}`}
      aria-label={`Copy commit ${sha}`}
      onClick={() => {
        void navigator.clipboard?.writeText(sha).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="group/sha inline-flex cursor-pointer items-baseline gap-0.5 font-mono text-[0.923em] text-sky-900/75 hover:text-sky-950 dark:text-sky-100/75 dark:hover:text-sky-50"
    >
      <span>
        {[...sha.slice(0, 7)].map((char, index) =>
          /[a-f]/.test(char) ? (
            <span
              key={index}
              className="text-violet-800/70 dark:text-violet-200/70"
            >
              {char}
            </span>
          ) : (
            char
          ),
        )}
      </span>
      <Icon
        name={copied ? "Check" : "Copy"}
        aria-hidden
        className="size-[0.9em] shrink-0 self-center opacity-50 transition-opacity group-hover/sha:opacity-90"
      />
    </button>
  );
}

/**
 * One recap line through BB's markdown, so inline code, emphasis, and links
 * survive. BB's Markdown leaves thread mentions and commit hashes as text,
 * so those segments render here between inline Markdown runs. The
 * overrides keep BB's paragraph and code styles inside the recap's type
 * scale.
 */
function RecapText({
  text,
  className = "",
  typeClass,
}: {
  text: string;
  className?: string;
  typeClass?: string;
}) {
  const scale = useBodyClass();
  typeClass ??= scale;
  const segments = recapSegments(text);
  if (segments.length === 1 && segments[0]!.kind === "markdown")
    return (
      <Markdown
        content={text}
        className={`min-w-0 ${typeClass} ${MARKDOWN_CLASS} ${className}`}
      />
    );
  return (
    <div className={`min-w-0 ${typeClass} ${className}`}>
      {segments.map((segment, index) => {
        if (segment.kind === "thread")
          return (
            <span
              key={index}
              className="inline-block max-w-[16rem] align-middle [&>a]:text-[0.85em]"
            >
              <ActivityThreadLink threadId={segment.threadId} />
            </span>
          );
        if (segment.kind === "sha")
          return <Sha key={index} sha={segment.sha} />;
        // Markdown trims its source, so edge spaces are kept outside it.
        const body = segment.text.trim();
        return (
          <Fragment key={index}>
            {/^\s/.test(segment.text) ? " " : null}
            {body ? (
              <Markdown
                content={body}
                className={`!inline !text-[length:inherit] !leading-[inherit] [&_p]:!inline ${MARKDOWN_CLASS}`}
              />
            ) : null}
            {/\s$/.test(segment.text) && body ? " " : null}
          </Fragment>
        );
      })}
    </div>
  );
}

// Labels sit in a gutter beside their row, and above it on narrow cards.
const ROW_CLASS =
  "grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 py-2 @max-[24rem]/recap:grid-cols-1";
const LABEL_CLASS = "pt-px text-[11px] font-medium leading-[1.6]";

function Glyph({
  path,
  className,
  filled = false,
}: {
  path: string;
  className: string;
  filled?: boolean;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={className}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
}
const CHECK = "M3.5 8.5 6.5 11.5 12.5 4.5";
/** A solid dot: work still in progress. */
const ACTIVE = "M8 5.75a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 1 0 0-4.5Z";
const FILE =
  "M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5Z M9.5 1.5V5H13";
const LINK =
  "M6.5 9.5a3 3 0 0 0 4.24 0l2-2a3 3 0 0 0-4.24-4.24l-.5.5 M9.5 6.5a3 3 0 0 0-4.24 0l-2 2a3 3 0 0 0 4.24 4.24l.5-.5";

/** Where the turn's result stands, above the goal. */
function StateLine({
  state,
  clearance,
}: {
  state: Recap["state"];
  clearance: string;
}) {
  return (
    <p
      className={cn(
        "text-[11px] font-medium leading-[1.6]",
        clearance,
        ACCENT[state].text,
      )}
    >
      {state === "review"
        ? "Ready for Review"
        : state === "continuing"
          ? "Working"
          : "Complete"}
    </p>
  );
}

function Row({
  label,
  accent,
  children,
}: {
  /** Omitted when the row stands alone and needs no heading. */
  label?: string;
  /** The label's accent text color. */
  accent: string;
  children: ReactNode;
}) {
  const compact = useContext(CompactContext);
  return (
    <section
      className={cn(label ? ROW_CLASS : "py-2", compact && "py-1 first:pt-1.5")}
    >
      {label ? <h3 className={cn(LABEL_CLASS, accent)}>{label}</h3> : null}
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/**
 * Progress items: solid dots for work still in progress, then checks for
 * finished results, both in the state's accent text color. A working recap
 * with a single shown item reads as plain text.
 */
function Results({
  active = [],
  done,
  accent,
}: {
  active?: string[];
  done: string[];
  accent: string;
}) {
  const body = useBodyClass();
  const items = [
    ...active.map((text) => ({ text, path: ACTIVE, label: "In progress" })),
    ...done.map((text) => ({ text, path: CHECK, label: "Done" })),
  ];
  if (active.length > 0 && items.length === 1)
    return (
      <p
        data-progress="active"
        className={`m-0 min-w-0 ${body} text-foreground`}
      >
        <RecapText text={items[0]!.text} />
      </p>
    );
  return (
    <ul className="m-0 list-none space-y-0.5 p-0">
      {items.map((item, index) => (
        <li
          key={index}
          data-progress={item.path === ACTIVE ? "active" : "done"}
          className={`grid grid-cols-[14px_minmax(0,1fr)] gap-x-1.5 ${body} text-foreground`}
        >
          <Glyph
            path={item.path}
            filled={item.path === ACTIVE}
            className={cn("mt-[0.2em] h-3.5 w-3.5", accent)}
          />
          <span className="sr-only">{item.label}: </span>
          <RecapText text={item.text} />
        </li>
      ))}
    </ul>
  );
}

function StepText({ item }: { item: ReviewStep }) {
  if (typeof item === "string") return <RecapText text={item} />;
  return (
    <div className="min-w-0">
      <RecapText text={item.step} />
      {item.expect ? (
        <RecapText
          text={item.expect}
          className="mt-0.5 text-muted-foreground"
        />
      ) : null}
    </div>
  );
}

/** Review steps: one reads as plain text, more as a list. */
function Steps({ items }: { items: ReviewStep[] }) {
  const body = useBodyClass();
  if (items.length === 1)
    return (
      <div className={`${body} text-foreground`}>
        <StepText item={items[0]!} />
      </div>
    );
  return (
    <ol className="m-0 list-none space-y-0.5 p-0">
      {items.map((item, index) => (
        <li
          key={index}
          className={`grid grid-cols-[14px_minmax(0,1fr)] gap-x-1.5 ${body} text-foreground`}
        >
          <span
            aria-hidden="true"
            className="text-[0.85em] font-medium tabular-nums text-foreground/60"
          >
            {index + 1}.
          </span>
          <StepText item={item} />
        </li>
      ))}
    </ol>
  );
}

const CHIP_CLASS =
  "inline-flex max-w-full items-center gap-1.5 truncate rounded-full no-underline hover:no-underline border border-border bg-background/60 px-2 py-px text-[11.5px] font-medium leading-[1.6] text-foreground/80 hover:border-foreground/25 hover:text-foreground";

function Links({
  links,
  files,
}: {
  links: RecapLink[];
  files: RecapFiles | null;
}) {
  return (
    <ul
      aria-label="Links"
      className="m-0 mt-2 flex list-none flex-wrap gap-1.5 p-0"
    >
      {links.map((link, index) => {
        const web = link.location.startsWith("https://");
        const target = web ? null : fileTarget(link.location, files);
        const label = (
          <>
            <Glyph
              path={web ? LINK : FILE}
              className="h-3 w-3 shrink-0 opacity-70"
            />
            <span className="truncate">{link.title}</span>
          </>
        );
        return (
          <li key={index} className="min-w-0 max-w-full">
            {web ? (
              <UrlLink href={link.location} className={CHIP_CLASS}>
                {label}
              </UrlLink>
            ) : target ? (
              <FileLink
                target={target}
                title={link.location}
                className={CHIP_CLASS}
              >
                {label}
              </FileLink>
            ) : (
              <span title={link.location} className={CHIP_CLASS}>
                {label}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The state line and goal, then the rows for the recap's state. Full shows
 * every row with labels: Progress and Next while working, Done and Review for
 * review, results alone when complete. Compact keeps the essential row
 * unlabeled: in-progress items while working, the review steps for review,
 * results when complete.
 */
function RecapSummary({
  recap,
  layout,
  files,
  clearance,
}: {
  recap: Recap;
  layout: RecapLayout;
  files: RecapFiles | null;
  /** Room the top line leaves for the corner buttons. */
  clearance: string;
}) {
  const compact = layout === "minimal";
  const body = compact ? COMPACT_BODY_CLASS : BODY_CLASS;
  const review = recap.state === "review" && recap.review.length > 0;
  const working = recap.state === "continuing";
  const next = working ? (recap.next ?? []) : [];
  const accent = ACCENT[recap.state];
  const links =
    review && recap.links.length > 0 ? (
      <Links links={recap.links} files={files} />
    ) : null;
  let rows: ReactNode;
  if (compact) {
    rows = working ? (
      <Row accent={accent.text}>
        <Results active={recap.active} done={[]} accent={accent.text} />
      </Row>
    ) : review ? (
      <Row accent={accent.text}>
        <Steps items={recap.review} />
        {links}
      </Row>
    ) : (
      <Row accent={accent.text}>
        <Results done={recap.latest} accent={accent.text} />
      </Row>
    );
  } else {
    rows = (
      <>
        <Row
          label={working ? "Progress" : review ? "Done" : undefined}
          accent={accent.text}
        >
          <Results
            active={working ? recap.active : []}
            done={recap.latest}
            accent={accent.text}
          />
        </Row>
        {next.length ? (
          <Row label="Next" accent={accent.text}>
            <Steps items={next} />
          </Row>
        ) : null}
        {review ? (
          <Row label="Review" accent={accent.text}>
            <Steps items={recap.review} />
            {links}
          </Row>
        ) : null}
      </>
    );
  }
  return (
    <CompactContext.Provider value={compact}>
      {/* The top line clears the corner buttons. */}
      <StateLine state={recap.state} clearance={clearance} />
      <div
        role="heading"
        aria-level={2}
        className={cn(
          "font-medium tracking-[-0.006em] text-foreground",
          clearance,
        )}
      >
        <RecapText
          text={recap.goal}
          className="w-full max-w-none"
          typeClass={compact ? COMPACT_GOAL_CLASS : GOAL_CLASS}
        />
      </div>
      <div
        className={cn(
          compact ? "mt-0.5" : "mt-1.5",
          "[&>section+section]:border-t",
          accent.rules,
          body,
        )}
      >
        {rows}
      </div>
    </CompactContext.Provider>
  );
}

type RecapResponse = {
  recap: Recap | null;
  dismissed: boolean;
  capped: boolean;
  corrections: number;
  files: RecapFiles | null;
};
const EMPTY: RecapResponse = {
  recap: null,
  dismissed: false,
  capped: false,
  corrections: 0,
  files: null,
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
    // Hide at once; retain the recap so the card can be restored.
    setState((current) =>
      current.recap?.id === recapId ? { ...current, dismissed: true } : current,
    );
    await rpc.call("recap_dismiss", { threadId, recapId }).catch(() => {});
    load();
  };
  const restore = async (recapId: string) => {
    if (!threadId) return;
    setState((current) =>
      current.recap?.id === recapId
        ? { ...current, dismissed: false }
        : current,
    );
    await rpc.call("recap_restore", { threadId, recapId }).catch(() => {});
    load();
  };
  return { ...state, dismiss, restore };
}

const CORNER_BUTTON =
  "absolute top-2.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";

type CardProps = {
  recap: Recap;
  layout: RecapLayout;
  files: RecapFiles | null;
  showArchive: boolean;
  archiveBusy: boolean;
  archiveError: string | null;
};

function CardBody({
  recap,
  layout,
  files,
  showArchive,
  archiveBusy,
  archiveError,
  onArchive,
  onDismiss,
}: CardProps & { onArchive?: () => void; onDismiss?: () => void }) {
  const compact = layout === "minimal";
  const compactArchive = compact && showArchive;
  return (
    <>
      <div className="@max-[20rem]/recap:[&_*]:!text-[0.625rem] @max-[20rem]/recap:[&_*]:!font-normal @max-[20rem]/recap:[&_*]:!leading-[1.5] @max-[20rem]/recap:[&_*]:!tracking-normal">
        <RecapSummary
          recap={recap}
          layout={layout}
          files={files}
          clearance={compactArchive ? "pr-14" : "pr-7"}
        />
      </div>
      {compactArchive ? (
        // Compact cards keep Archive beside dismiss, icon only, so it adds
        // no footer height.
        <button
          type="button"
          className={cn(CORNER_BUTTON, "right-9")}
          aria-label="Archive"
          title="Archive"
          disabled={archiveBusy}
          onClick={onArchive}
        >
          <Icon name="Archive" aria-hidden className="size-3.5" />
        </button>
      ) : null}
      {/* The footer strip runs edge to edge under the rows, so the card
          without Archive (or an error) stays short. */}
      {(showArchive && !compact) || archiveError ? (
        <div
          className={cn(
            compact ? "-mx-3 -mb-2" : "-mx-4 -mb-3",
            "mt-1.5 flex items-center justify-end gap-3 rounded-b-[7px] border-t px-3 py-2",
            ACCENT[recap.state].footer,
          )}
        >
          {archiveError ? (
            <p
              role="alert"
              className="mr-auto min-w-0 text-[11px] text-red-700 dark:text-red-300"
            >
              {archiveError}
            </p>
          ) : null}
          {showArchive && !compact ? (
            // Outline, so it offers the next step without outweighing the
            // recap.
            <Button
              variant="outline"
              size="sm"
              className="bg-background/60"
              disabled={archiveBusy}
              onClick={onArchive}
            >
              <Icon name="Archive" aria-hidden className="size-3.5" />
              Archive
            </Button>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className={cn(CORNER_BUTTON, "right-2.5")}
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
 * A recap card as it appears above the composer, for showing outside a
 * thread. It is inert: dismiss, Archive, and links do nothing.
 */
export function RecapCardPreview({
  recap,
  layout,
  showArchive = false,
  className,
}: {
  recap: Recap;
  layout: RecapLayout;
  showArchive?: boolean;
  className?: string;
}) {
  return (
    <div inert className={cn(cardClass(recap.state, layout), className)}>
      <CardBody
        recap={recap}
        layout={layout}
        files={null}
        showArchive={showArchive}
        archiveBusy={false}
        archiveError={null}
      />
    </div>
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
 * Archive at the right of a footer strip under it. It stays up while the user drafts,
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
  const { recap, dismissed, capped, files, dismiss, restore } =
    useRecap(threadId);
  const { prefs } = useRecapPrefs();
  const layout: RecapLayout = prefs?.layout ?? "full";
  const visibleRecap = dismissed ? null : recap;
  const archive = useArchiveSuggestion(threadId, visibleRecap, continuing);
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
    available && visibleRecap
      ? {
          recap: visibleRecap,
          layout,
          files,
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
            className={cardClass(frame.recap.state, frame.layout)}
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
              <div
                className={cardClass(hold.ghost.recap.state, hold.ghost.layout)}
              >
                <CardBody {...hold.ghost} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {!frame && available && dismissed && recap ? (
        <div
          className="mx-auto mb-3 flex w-full max-w-4xl justify-end px-1"
          style={FIRST}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => void restore(recap.id)}
          >
            Show recap
          </Button>
        </div>
      ) : null}
      {!frame && available && capped ? (
        <p
          role="status"
          className="mx-auto mb-3 w-full max-w-4xl px-1 text-center text-xs text-muted-foreground"
          style={FIRST}
        >
          No recap recorded. Automatic continuation is paused. Send a message to
          continue the thread.
        </p>
      ) : null}
    </div>
  );
}
