import { useComposerView } from "@get-bb/plugin-sdk/app";
import { ArchiveReview, useArchiveStyle } from "../archive/ArchiveControls.tsx";
import { useArchiveSuggestion } from "../archive/useArchiveSuggestion.ts";

export function ArchiveCard() {
  const style = useArchiveStyle();
  return style === "inline" || style === "floating" ? (
    <ArchiveBanner style={style} />
  ) : null;
}

function ArchiveBanner({ style }: { style: "inline" | "floating" }) {
  const { scope, draft, run } = useComposerView();
  const suggestion = useArchiveSuggestion(
    scope.kind === "thread" ? scope.threadId : null,
    style === "inline" || style === "floating",
  );
  if (
    !suggestion.visible ||
    !draft.isEmpty ||
    run.isRunning ||
    run.isSubmitting
  )
    return null;
  if (style === "inline")
    return (
      <div className="ws-archive-inline" role="status" aria-live="polite">
        <span>✓ Work finished</span>
        <button
          type="button"
          disabled={suggestion.busy}
          onClick={() => void suggestion.decide("archive")}
        >
          Archive thread
        </button>
        <button
          type="button"
          className="ws-archive-dismiss"
          aria-label="Dismiss archive suggestion"
          disabled={suggestion.busy}
          onClick={() => void suggestion.decide("dismiss")}
        >
          ×
        </button>
        {suggestion.error ? (
          <span className="ws-banner-error">{suggestion.error}</span>
        ) : null}
      </div>
    );
  return (
    <div className="ws-archive-anchor">
      <div className="ws-archive-card" role="status" aria-live="polite">
        <div className="ws-archive-copy">
          <strong>All done here?</strong>
          <span>This thread looks finished, with no outstanding work.</span>
          {suggestion.error ? (
            <span className="ws-banner-error">{suggestion.error}</span>
          ) : null}
        </div>
        <div className="ws-archive-actions">
          <button
            type="button"
            disabled={suggestion.busy}
            onClick={() => void suggestion.decide("dismiss")}
          >
            Dismiss
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
      </div>
    </div>
  );
}

export function ArchiveComposerAction() {
  const style = useArchiveStyle();
  const { layout } = useComposerView();
  return style === "action" && layout === "expanded" ? <ArchiveAction /> : null;
}

function ArchiveAction() {
  const { scope, draft, run } = useComposerView();
  const suggestion = useArchiveSuggestion(
    scope.kind === "thread" ? scope.threadId : null,
    true,
  );
  if (
    !suggestion.visible ||
    !draft.isEmpty ||
    run.isRunning ||
    run.isSubmitting
  )
    return null;
  return <ArchiveReview suggestion={suggestion} />;
}
