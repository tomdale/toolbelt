/**
 * The workstream-proposal pill in a thread header, with its yellow floating
 * banner (SPEC §9). With no proposal, the same surface carries the thread's
 * drift flag (§10): Hand off, Move, or Dismiss. The header row is 28px tall, so the banner is portalled
 * and anchored below the pill. It never takes focus, collapses to the pill,
 * and on phone widths only the pill shows.
 *
 * Outside split view BB reports no pane geometry, so the banner's right edge
 * aligns under the pill; in split view it is also capped to the pane's width.
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  experimental_useSidebarThreads,
  useBbNavigate,
  useSidebarSplitLayout,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { InspectButton } from "../debug/InspectButton.tsx";
import type { InspectTarget } from "../debug/debug.ts";
import {
  driftOf,
  proposalsByThread,
  useServerState,
} from "../useWorkstreams.ts";

const COLLAPSED_KEY = "workstreams:collapsed-proposals";

function readCollapsed(): Set<string> {
  try {
    return new Set(
      JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[],
    );
  } catch {
    return new Set();
  }
}

function useCollapsedProposal(id: string | undefined) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed());
  const toggle = useCallback(() => {
    if (!id) return;
    const next = readCollapsed();
    if (next.has(id)) next.delete(id);
    else next.add(id);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next].slice(-100)));
    setCollapsed(next);
  }, [id]);
  return { collapsed: id ? collapsed.has(id) : false, toggle };
}

type Action = {
  label: string;
  primary?: boolean;
  run: () => Promise<void> | void;
};
type Notice = {
  /** Collapse-state key. */
  id: string;
  pill: string;
  text: string;
  actions: Action[];
  /** Phone widths show only the pill; tapping it runs this. */
  onPill: () => void;
  /** The model calls behind it, for Debug mode's inspector. */
  inspect: { target: InspectTarget; title: string } | null;
};

export function ProposalBanner({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const { rpc, server } = useServerState();
  const navigate = useBbNavigate();
  const split = useSidebarSplitLayout();
  const { threads } = experimental_useSidebarThreads({
    experimental_lifecycles: ["active"],
  });
  const proposal = proposalsByThread(server.proposals).get(threadId);
  const drift = proposal
    ? null
    : driftOf(
        threads.find((t) => t.id === threadId),
        server,
      );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<unknown>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  let notice: Notice | null = null;
  // Initial automatic filing is shown inline in the thread composer rather
  // than as a floating header popover. Other applied moves remain visible so
  // the user can undo them.
  if (
    proposal &&
    !(
      proposal.status !== "pending" &&
      proposal.kind === "move" &&
      proposal.sourceSectionId === null
    )
  ) {
    const review = () =>
      navigate.toPluginPanel("home", { subPath: `activity/${proposal.id}` });
    const pending = proposal.status === "pending";
    notice = {
      id: proposal.id,
      pill: `✦ ${proposal.targetName}${pending ? "?" : ""}`,
      text: proposal.text,
      onPill: review,
      inspect: proposal.traceIds.length
        ? {
            target: { traceIds: proposal.traceIds },
            title: `Model calls behind: ${proposal.text}`,
          }
        : null,
      actions: pending
        ? [
            {
              label: proposal.accept,
              primary: true,
              run: run(() =>
                rpc.call("proposal", { id: proposal.id, action: "accept" }),
              ),
            },
            { label: "Review…", run: review },
            {
              label: "Not now",
              run: run(() =>
                rpc.call("proposal", { id: proposal.id, action: "dismiss" }),
              ),
            },
          ]
        : [
            {
              label: "Undo",
              run: run(async () => {
                if (proposal.entryId)
                  await rpc.call("undo", { entryId: proposal.entryId });
              }),
            },
            {
              label: "OK",
              primary: true,
              run: run(() =>
                rpc.call("proposal", {
                  id: proposal.id,
                  action: "acknowledge",
                }),
              ),
            },
          ],
    };
  } else if (drift) {
    const act = (action: "handoff" | "move" | "dismiss") =>
      run(async () => {
        const result = await rpc.call("drift", { threadId, action });
        if (action === "handoff" && result.threadId)
          navigate.toThread(result.threadId);
      });
    notice = {
      id: `drift:${threadId}:${drift.target}`,
      pill: `↗ ${drift.target}?`,
      text: `This thread's latest request looks like ${drift.target} work.`,
      onPill: act("handoff"),
      inspect: server.analysis[threadId]?.traceId
        ? {
            target: { traceIds: [server.analysis[threadId].traceId] },
            title: `Why this looks like ${drift.target} work`,
          }
        : null,
      actions: [
        { label: "Hand off", primary: true, run: act("handoff") },
        { label: `Move to ${drift.target}`, run: act("move") },
        { label: "Dismiss", run: act("dismiss") },
      ],
    };
  }

  const { collapsed, toggle } = useCollapsedProposal(notice?.id);
  const pill = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    // The header moves with sidebar toggles and split changes, which don't
    // resize the window, so re-measure on a light interval too.
    const measure = () => {
      const rect = pill.current?.getBoundingClientRect() ?? null;
      setAnchor((previous) =>
        previous &&
        rect &&
        previous.bottom === rect.bottom &&
        previous.right === rect.right
          ? previous
          : rect,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    const timer = setInterval(measure, 500);
    return () => {
      window.removeEventListener("resize", measure);
      clearInterval(timer);
    };
  }, [notice?.id, collapsed, split]);

  if (!notice) return null;
  const pane = split?.panes.find((p) => p.threadId === threadId);
  const maxWidth = pane
    ? Math.min(560, Math.max(280, pane.rect.width * window.innerWidth - 32))
    : 560;
  const showBanner = !collapsed && !isCompactViewport && anchor !== null;
  const shown = notice;

  return (
    <>
      <button
        ref={pill}
        type="button"
        className="ws-pill"
        aria-expanded={isCompactViewport ? undefined : !collapsed}
        aria-label={`${shown.text} ${proposal?.status === "pending" || drift ? "Show proposal" : "Show change"}`}
        title={shown.text}
        onClick={() => (isCompactViewport ? shown.onPill() : toggle())}
      >
        {shown.pill}
      </button>
      {showBanner
        ? createPortal(
            <div
              className="ws-banner"
              role="status"
              aria-live="polite"
              data-workstreams-banner=""
              style={{
                top: anchor.bottom + 8,
                right: Math.max(8, window.innerWidth - anchor.right),
                maxWidth,
              }}
            >
              <span aria-hidden="true" className="ws-banner-mark">
                ✦
              </span>
              <span className="ws-banner-text">
                {shown.text}
                {error ? (
                  <span className="ws-banner-error"> {error}</span>
                ) : null}
              </span>
              <span className="ws-banner-actions">
                {shown.actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className={action.primary ? "ws-banner-primary" : undefined}
                    disabled={busy}
                    onClick={() => void action.run()}
                  >
                    {action.label}
                  </button>
                ))}
              </span>
              {shown.inspect ? (
                <InspectButton
                  target={shown.inspect.target}
                  title={shown.inspect.title}
                  label="Inspect the model call behind this"
                />
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
