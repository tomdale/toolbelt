import { useState } from "react";
import { useComposerView } from "@get-bb/plugin-sdk/app";
import { useServerState } from "../useWorkstreams.ts";

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

/** A quiet, inline receipt for an automatic initial Unsorted filing. */
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

  return (
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
}
