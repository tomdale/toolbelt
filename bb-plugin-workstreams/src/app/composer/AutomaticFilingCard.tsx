import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useComposerView } from "@get-bb/plugin-sdk/app";
import { useServerState } from "../useWorkstreams.ts";
import { useTranscriptTail } from "./transcriptPortal.ts";

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * A quiet receipt for an automatic initial Unsorted filing. Registered as a
 * composer banner for its thread scope, but portaled to the end of the
 * transcript when the host timeline can be found.
 */
export function AutomaticFilingCard() {
  const { scope } = useComposerView();
  const { rpc, server, refresh } = useServerState();
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const proposal = threadId
    ? server.proposals.find(
        (item) =>
          item.threadIds.includes(threadId) &&
          item.status !== "pending" &&
          item.kind === "move" &&
          item.sourceSectionId === null &&
          item.entryId !== null,
      )
    : undefined;

  const visible = Boolean(proposal) && !hidden;
  const anchor = useRef<HTMLSpanElement>(null);
  const { host: tail, resolved } = useTranscriptTail(anchor, visible);

  if (!proposal || hidden) return null;

  const undo = async () => {
    if (!proposal.entryId || busy) return;
    setBusy(true);
    try {
      await rpc.call("undo", { entryId: proposal.entryId });
      setHidden(true);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const notice = (
    <div className="ws-filing-notice" role="status">
      <span>
        Moved to the <strong>{proposal.targetName}</strong> workstream
        automatically · {relativeTime(proposal.updatedAt)}
      </span>
      <button type="button" disabled={busy} onClick={() => void undo()}>
        Undo
      </button>
    </div>
  );

  return (
    <>
      <span ref={anchor} hidden />
      {resolved ? (tail ? createPortal(notice, tail) : notice) : null}
    </>
  );
}
