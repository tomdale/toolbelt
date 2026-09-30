import { useComposerView } from "@get-bb/plugin-sdk/app";
import { useArchiveSuggestion } from "../archive/useArchiveSuggestion.ts";

/** Composer toolbar action offering to archive a finished, idle thread. */
export function ArchiveCard() {
  const { scope, draft, run } = useComposerView();
  const continuing =
    !draft.isEmpty ||
    draft.attachmentCount > 0 ||
    run.isRunning ||
    run.isSubmitting;
  const suggestion = useArchiveSuggestion(
    scope.kind === "thread" ? scope.threadId : null,
    continuing,
  );
  if (!suggestion.visible || continuing) return null;
  return (
    <span className="ws-archive-suggestion">
      {suggestion.error ? (
        <span className="ws-banner-error" role="alert">
          {suggestion.error}
        </span>
      ) : null}
      <button
        type="button"
        className="ws-archive-button"
        aria-label="Archive thread"
        disabled={suggestion.busy}
        onClick={() => void suggestion.decide("archive")}
      >
        Archive
      </button>
    </span>
  );
}
