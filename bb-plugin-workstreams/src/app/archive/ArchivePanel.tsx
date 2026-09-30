import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { useArchiveSuggestion } from "./useArchiveSuggestion.ts";

export function ArchivePanel({ threadId }: PluginThreadPanelProps) {
  const suggestion = useArchiveSuggestion(threadId);
  return (
    <section className="ws-archive-review-panel">
      <h2>Archive this thread?</h2>
      <p>
        {suggestion.visible
          ? "This thread looks finished, with no outstanding work. Archiving clears it from the sidebar."
          : "There is no current archive suggestion for this thread. It may still have unfinished work, be waiting for classification, or you may have dismissed the suggestion."}
      </p>
      <p className="text-muted-foreground">
        The check applies to the whole thread, not just the response you
        clicked.
      </p>
      {suggestion.error ? (
        <p role="alert" className="ws-banner-error">
          {suggestion.error}
        </p>
      ) : null}
      {suggestion.visible ? (
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
      ) : null}
    </section>
  );
}
