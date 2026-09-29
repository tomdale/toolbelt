/**
 * The workstream-proposal pill in a thread header, with its yellow floating
 * banner (SPEC §9). The header row is 28px tall, so the banner is portalled
 * and anchored below the pill. It never takes focus, collapses to the pill,
 * and on phone widths only the pill shows.
 *
 * Outside split view BB reports no pane geometry, so the banner's right edge
 * aligns under the pill; in split view it is also capped to the pane's width.
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  useBbNavigate,
  useSidebarSplitLayout,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { ProposalView } from "../../server/evolution.ts";
import { proposalsByThread, useServerState } from "../useWorkstreams.ts";

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

export function ProposalBanner({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const { rpc, server } = useServerState();
  const navigate = useBbNavigate();
  const split = useSidebarSplitLayout();
  const proposal = proposalsByThread(server.proposals).get(threadId);
  const { collapsed, toggle } = useCollapsedProposal(proposal?.id);
  const pill = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const measure = () =>
      setAnchor(pill.current?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (pill.current) observer?.observe(pill.current);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [proposal?.id, collapsed]);

  if (!proposal) return null;
  const pending = proposal.status === "pending";
  const act = async (action: "accept" | "dismiss" | "acknowledge") => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call("proposal", { id: proposal.id, action });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const undo = async () => {
    if (!proposal.entryId) return;
    setBusy(true);
    try {
      await rpc.call("undo", { entryId: proposal.entryId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const review = () =>
    navigate.toPluginPanel("home", { subPath: `activity/${proposal.id}` });

  const pane = split?.panes.find((p) => p.threadId === threadId);
  const maxWidth = pane
    ? Math.min(560, Math.max(280, pane.rect.width * window.innerWidth - 32))
    : 560;
  const showBanner = !collapsed && !isCompactViewport && anchor !== null;

  return (
    <>
      <button
        ref={pill}
        type="button"
        className="ws-pill"
        aria-expanded={isCompactViewport ? undefined : !collapsed}
        aria-label={`${proposal.text} ${pending ? "Show proposal" : "Show change"}`}
        title={proposal.text}
        onClick={() => (isCompactViewport ? review() : toggle())}
      >
        ✦ {proposal.targetName}
        {pending ? "?" : ""}
      </button>
      {showBanner
        ? createPortal(
            <BannerBody
              proposal={proposal}
              busy={busy}
              error={error}
              style={{
                top: anchor.bottom + 8,
                right: Math.max(8, window.innerWidth - anchor.right),
                maxWidth,
              }}
              onAccept={() => void act("accept")}
              onReview={review}
              onDismiss={() => void act("dismiss")}
              onUndo={() => void undo()}
              onOk={() => void act("acknowledge")}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function BannerBody({
  proposal,
  busy,
  error,
  style,
  onAccept,
  onReview,
  onDismiss,
  onUndo,
  onOk,
}: {
  proposal: ProposalView;
  busy: boolean;
  error: string | null;
  style: React.CSSProperties;
  onAccept: () => void;
  onReview: () => void;
  onDismiss: () => void;
  onUndo: () => void;
  onOk: () => void;
}) {
  const pending = proposal.status === "pending";
  return (
    <div
      className="ws-banner"
      role="status"
      aria-live="polite"
      style={style}
      data-workstreams-banner=""
    >
      <span aria-hidden="true" className="ws-banner-mark">
        ✦
      </span>
      <span className="ws-banner-text">
        {proposal.text}
        {error ? <span className="ws-banner-error"> {error}</span> : null}
      </span>
      <span className="ws-banner-actions">
        {pending ? (
          <>
            <button
              type="button"
              className="ws-banner-primary"
              disabled={busy}
              onClick={onAccept}
            >
              {proposal.accept}
            </button>
            <button type="button" disabled={busy} onClick={onReview}>
              Review…
            </button>
            <button type="button" disabled={busy} onClick={onDismiss}>
              Not now
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={onUndo}>
              Undo
            </button>
            <button
              type="button"
              className="ws-banner-primary"
              disabled={busy}
              onClick={onOk}
            >
              OK
            </button>
          </>
        )}
      </span>
    </div>
  );
}
