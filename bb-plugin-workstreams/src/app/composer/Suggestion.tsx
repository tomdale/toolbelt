/**
 * New work's magic suggestion: the home classification found for the draft,
 * shown under the composer once a result arrives. Two keys accept it, and
 * each has a button showing it:
 *
 * - Tab applies a workstream suggestion to the pickers without submitting,
 *   as Tab accepts an inline completion. It acts only from the prompt editor,
 *   and only when the editor didn't use the key itself (a mention menu, a
 *   list indent).
 * - ⌘⏎ (Ctrl+⏎ elsewhere), BB's alternate send, submits with the
 *   suggestion: it applies a workstream suggestion and starts the thread, or
 *   sends the draft to a suggested thread. When an automatic destination
 *   already fills the pickers — the row's own workstream suggestions are
 *   hidden then — the same key submits what the pickers show, as Enter does.
 *
 * ⏎ still starts the thread the pickers show.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { WorkstreamIcon } from "../WorkstreamIcon.tsx";
import type { Placement } from "../../server/router.ts";
import {
  hasDestination,
  shownSuggestion,
  type NewWork,
  type Suggestion,
} from "./new-work.ts";

/** Tab with no modifiers. */
export function isApplyShortcut(event: KeyboardEvent): boolean {
  return (
    event.key === "Tab" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.isComposing
  );
}

/** Whether `target` is where the draft is typed. */
function inEditor(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target instanceof HTMLTextAreaElement)
  );
}

export function isSubmitShortcut(event: KeyboardEvent): boolean {
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
export function useProjects(): Map<string, ProjectInfo> {
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
  // An automatic destination has no row of its own — it already fills the
  // pickers — so ⌘⏎ submits what they show, as Enter does.
  const autoDestination = !suggestion && !state.pinned && hasDestination(state);
  const projects = useProjects();
  const row = useRef<HTMLDivElement>(null);
  const applies = !!suggestion && suggestion.kind !== "thread";
  useEffect(() => {
    if (!suggestion && !autoDestination) return;
    const inDialog = (target: EventTarget | null) => {
      const scope = row.current?.closest('[role="dialog"]');
      return !!scope && target instanceof Node && scope.contains(target);
    };
    // Capturing runs before the editor's own ⌘⏎ handling, which would start
    // the thread from the pickers as they are.
    const onSubmitKey = (event: KeyboardEvent) => {
      if (!isSubmitShortcut(event) || !inDialog(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (suggestion) void newWork.accept({ submit: true });
      else void newWork.submitComposer();
    };
    // Bubbling runs after the editor, which claims Tab for its own menus.
    const onApplyKey = (event: KeyboardEvent) => {
      if (!applies || !isApplyShortcut(event) || event.defaultPrevented) return;
      if (!inEditor(event.target) || !inDialog(event.target)) return;
      event.preventDefault();
      void newWork.accept({ submit: false });
    };
    document.addEventListener("keydown", onSubmitKey, true);
    document.addEventListener("keydown", onApplyKey);
    return () => {
      document.removeEventListener("keydown", onSubmitKey, true);
      document.removeEventListener("keydown", onApplyKey);
    };
  }, [newWork, suggestion, applies, autoDestination]);
  const mac = macKeyboard();
  const submitKey = mac ? "⌘⏎" : "Ctrl ⏎";
  const submitLabel = suggestion?.kind === "thread" ? "Send" : "Start";
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
            aria-label={`${applies ? "Apply" : "Accept"} suggestion: ${sentence}`}
            aria-busy={state.accepting || undefined}
            disabled={state.accepting}
            onClick={() => void newWork.accept({ submit: !applies })}
          >
            <span className="ws-suggestion-spark" aria-hidden>
              ✦
            </span>
            <span className="ws-suggestion-text">
              <span className="ws-suggestion-action">{described.action}</span>{" "}
              <span className="ws-suggestion-target">
                {suggestion.kind === "thread" ? null : (
                  <WorkstreamIcon className="mr-1 inline-block size-3 align-[-2px] text-current" />
                )}
                {described.target}
              </span>
              {described.details.map((detail) => (
                <span key={detail} className="ws-suggestion-detail">
                  {" · "}
                  {detail}
                </span>
              ))}
            </span>
          </button>
          {applies ? (
            <button
              type="button"
              className="ws-suggestion-key"
              aria-label="Apply to the composer"
              aria-keyshortcuts="Tab"
              title="Fill the pickers without starting (Tab)"
              disabled={state.accepting}
              onClick={() => void newWork.accept({ submit: false })}
            >
              <kbd className="ws-suggestion-kbd">Tab</kbd>
              Apply
            </button>
          ) : null}
          <button
            type="button"
            className="ws-suggestion-key"
            aria-label={
              applies
                ? "Apply and start the thread"
                : `Send to ${described.target}`
            }
            aria-keyshortcuts={mac ? "Meta+Enter" : "Control+Enter"}
            title={`${applies ? "Apply and start" : "Send there"} (${submitKey})`}
            disabled={state.accepting}
            onClick={() => void newWork.accept({ submit: true })}
          >
            <kbd className="ws-suggestion-kbd">{submitKey}</kbd>
            {submitLabel}
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
