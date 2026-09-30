import { useState } from "react";
import {
  useSettings,
  useSidebarThreadDraft,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../../components/ui/dialog.tsx";
import { Icon } from "../../../components/ui/icon.tsx";
import { useArchiveSuggestion } from "./useArchiveSuggestion.ts";

export type ArchiveStyle = "inline" | "header" | "action" | "floating" | "off";
export function useArchiveStyle(): ArchiveStyle {
  const { values } = useSettings();
  const value = values?.archiveSuggestionStyle;
  return value === "header" ||
    value === "action" ||
    value === "floating" ||
    value === "off"
    ? value
    : "inline";
}

export function ArchiveReview({
  suggestion,
  header = false,
}: {
  suggestion: ReturnType<typeof useArchiveSuggestion>;
  header?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={header ? "ws-archive-chip" : "ws-archive-icon"}
        aria-label="Review archive suggestion"
        title="This thread looks finished — review archive suggestion"
        onClick={() => setOpen(true)}
      >
        <Icon name="Archive" className={header ? "size-3" : "size-4"} />
        {header ? <span>Finished</span> : null}
      </button>
      <Dialog open={open && suggestion.visible} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive this thread?</DialogTitle>
            <DialogDescription>
              The work looks finished, with no outstanding tasks. Archive it to
              clear it from the sidebar, or dismiss this suggestion to keep
              going.
            </DialogDescription>
          </DialogHeader>
          {suggestion.error ? (
            <p className="ws-banner-error" role="alert">
              {suggestion.error}
            </p>
          ) : null}
          <div className="ws-archive-actions">
            <button
              type="button"
              disabled={suggestion.busy}
              onClick={() => void suggestion.decide("dismiss")}
            >
              Keep open
            </button>
            <button
              type="button"
              className="ws-archive-primary"
              disabled={suggestion.busy}
              onClick={() => void suggestion.decide("archive")}
            >
              Archive thread
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ArchiveHeader(props: PluginThreadHeaderActionProps) {
  const style = useArchiveStyle();
  return style === "header" ? <ArchiveHeaderSuggestion {...props} /> : null;
}

function ArchiveHeaderSuggestion({ threadId }: PluginThreadHeaderActionProps) {
  const draft = useSidebarThreadDraft(threadId);
  const suggestion = useArchiveSuggestion(threadId);
  if (!suggestion.visible || draft.hasUnsubmittedDraft) return null;
  return <ArchiveReview suggestion={suggestion} header />;
}
