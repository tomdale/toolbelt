/**
 * New work's magic suggestion: the home classification found for the draft,
 * shown under the composer once a result arrives. Clicking it, or ⌘⏎
 * (Ctrl+⏎ elsewhere), accepts it; ⏎ still starts the thread the pickers
 * show. ⌘⏎ is BB's alternate send, which fits the one suggestion that sends:
 * continuing an existing thread.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import type { Placement } from "../../server/router.ts";
import { shownSuggestion, type NewWork, type Suggestion } from "./new-work.ts";

export function isAcceptShortcut(event: KeyboardEvent): boolean {
  return (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.isComposing
  );
}

function macKeyboard(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  );
}

const ENVIRONMENT_LABELS: Record<string, string> = {
  worktree: "New worktree",
  checkout: "Project checkout",
  "personal workspace": "Personal workspace",
  "existing environment": "Existing environment",
  "provider environment": "Provider environment",
  "project default": "Project default",
};

type ProjectInfo = { name: string; personal: boolean };

/** Project names for placements; the router reports only ids. */
function useProjects(): Map<string, ProjectInfo> {
  const sdk = useSdk();
  const [projects, setProjects] = useState(new Map<string, ProjectInfo>());
  useEffect(() => {
    let live = true;
    sdk.projects
      .list({ includePersonal: true })
      .then((list) => {
        if (live)
          setProjects(
            new Map(
              list.map((p) => [
                p.id,
                { name: p.name, personal: p.kind === "personal" },
              ]),
            ),
          );
      })
      .catch(() => {
        // Without names the suggestion still names its workstream or thread.
      });
    return () => {
      live = false;
    };
  }, [sdk]);
  return projects;
}

function placementText(
  placement: Placement | null,
  projects: Map<string, ProjectInfo>,
): string[] {
  if (!placement) return [];
  const project = projects.get(placement.projectId);
  if (project?.personal) return ["No project"];
  return [
    project?.name ?? null,
    ENVIRONMENT_LABELS[placement.label] ?? placement.label,
  ].filter((part): part is string => !!part);
}

/** The suggestion's action, its target, and the details it would also set. */
export function describeSuggestion(
  suggestion: Suggestion,
  projects: Map<string, ProjectInfo>,
): { action: string; target: string; details: string[] } {
  switch (suggestion.kind) {
    case "thread":
      return {
        action: "Send to",
        target: suggestion.title,
        details: suggestion.workstream ? [suggestion.workstream] : [],
      };
    case "workstream":
      return {
        action: "Start in",
        target: suggestion.name,
        details: placementText(suggestion.placement, projects),
      };
    case "new-workstream":
      return {
        action: "New workstream",
        target: suggestion.name,
        details: placementText(suggestion.placement, projects),
      };
  }
}

export function SuggestionRow({ newWork }: { newWork: NewWork }) {
  const state = useSyncExternalStore(newWork.subscribe, newWork.snapshot);
  const suggestion = shownSuggestion(state);
  const projects = useProjects();
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!suggestion) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isAcceptShortcut(event)) return;
      // Capturing on the document runs before the editor's own ⌘⏎ handling,
      // which would start the thread. Keys outside this dialog stay alone.
      const scope = row.current?.closest('[role="dialog"]');
      if (!scope || !(event.target instanceof Node)) return;
      if (!scope.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      void newWork.accept();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [newWork, suggestion]);
  const mac = macKeyboard();
  const shortcut = mac ? "⌘⏎" : "Ctrl ⏎";
  const described = suggestion
    ? describeSuggestion(suggestion, projects)
    : null;
  const sentence = described
    ? [`${described.action} ${described.target}`, ...described.details].join(
        " · ",
      )
    : "";
  return (
    <div ref={row} className="ws-suggestion-area">
      <p role="status" aria-live="polite" className="sr-only">
        {sentence ? `Suggested: ${sentence}` : ""}
      </p>
      {suggestion && described ? (
        <div
          className="ws-suggestion"
          data-kind={suggestion.kind}
          data-stale={state.classifying || undefined}
        >
          <button
            type="button"
            className="ws-suggestion-accept"
            title={suggestion.reason || undefined}
            aria-label={`Suggested: ${sentence}`}
            aria-keyshortcuts={mac ? "Meta+Enter" : "Control+Enter"}
            aria-busy={state.accepting || undefined}
            disabled={state.accepting}
            onClick={() => void newWork.accept()}
          >
            <span className="ws-suggestion-spark" aria-hidden>
              ✦
            </span>
            <span className="ws-suggestion-text">
              <span className="ws-suggestion-action">{described.action}</span>{" "}
              <span className="ws-suggestion-target">{described.target}</span>
              {described.details.map((detail) => (
                <span key={detail} className="ws-suggestion-detail">
                  {" · "}
                  {detail}
                </span>
              ))}
            </span>
            <kbd className="ws-suggestion-kbd">{shortcut}</kbd>
          </button>
          <button
            type="button"
            className="ws-suggestion-dismiss"
            aria-label="Dismiss suggestion"
            title="Dismiss suggestion"
            onClick={() => newWork.dismiss()}
          >
            <Icon name="X" className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}
      {state.error ? (
        <p key={state.errors} role="alert" className="ws-suggestion-error">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
