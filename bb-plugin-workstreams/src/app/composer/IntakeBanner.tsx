import { useEffect, useSyncExternalStore } from "react";
import { useComposer, useComposerView } from "@get-bb/plugin-sdk/app";
import { useServerState } from "../useWorkstreams.ts";
import type { Intake } from "./intake.ts";

export function IntakeBanner({ intake }: { intake: Intake }) {
  const route = useSyncExternalStore(intake.subscribe, intake.snapshot);
  const composer = useComposer();
  const view = useComposerView();
  const { server } = useServerState();
  const projectId =
    view.scope.kind === "new-thread" ? view.scope.projectId : null;
  const text = view.draft.text;
  useEffect(() => intake.observe(text, projectId), [intake, text, projectId]);
  const decision = route.decision;
  useEffect(() => {
    if (
      !decision ||
      (decision.outcome !== "new-thread" &&
        decision.outcome !== "new-workstream") ||
      !intake.shouldPreset(decision.id, decision.placement)
    )
      return;
    void composer
      .experimental_setSelection({
        projectId: decision.placement.projectId,
        environment: decision.placement.environment,
      })
      .catch(() => {
        // The server uses the preview's placement even if a host picker cannot
        // represent it. The native picker does not determine the destination.
      });
  }, [intake, decision, composer]);

  const current = route.text === text.trim();
  const label = route.workstreamName
    ? `New thread in ${route.workstreamName}`
    : !text.trim()
      ? "New thread"
      : !current || route.loading
        ? "Choosing a workstream…"
        : decision?.outcome === "new-thread"
          ? `New thread in ${decision.workstream}`
          : decision?.outcome === "new-workstream"
            ? `New workstream ${decision.name}`
            : decision?.outcome === "continue"
              ? `Continue ${decision.threadTitle}`
              : "Choose where this goes";
  const selectedThread =
    decision?.outcome === "unsure"
      ? decision.candidates.find(
          (c) => c.kind === "thread" && c.threadId === route.choice?.threadId,
        )
      : null;
  const workstreams = Object.values(server.workstreams);
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <p role="status" aria-live="polite">
          {selectedThread?.kind === "thread"
            ? `Continue ${selectedThread.title}`
            : label}
        </p>
        <select
          aria-label="Workstream"
          className="max-w-48 rounded bg-transparent text-xs text-muted-foreground"
          value={route.workstreamId ?? ""}
          onChange={(event) => {
            const id = event.target.value || null;
            intake.selectWorkstream(
              id,
              workstreams.find((w) => w.sectionId === id)?.name ?? null,
            );
          }}
        >
          <option value="">Automatic</option>
          {route.workstreamId &&
          !workstreams.some((w) => w.sectionId === route.workstreamId) ? (
            <option value={route.workstreamId}>
              {route.workstreamName ?? "Selected workstream"}
            </option>
          ) : null}
          {workstreams.map((w) => (
            <option key={w.sectionId} value={w.sectionId}>
              {w.name}
            </option>
          ))}
        </select>
      </div>
      {current && decision?.outcome === "unsure" ? (
        <div className="flex flex-wrap gap-2">
          {decision.candidates.map((candidate) => (
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs aria-pressed:bg-accent aria-pressed:text-accent-foreground"
              key={
                candidate.kind === "thread"
                  ? candidate.threadId
                  : candidate.sectionId
              }
              aria-pressed={
                candidate.kind === "thread"
                  ? route.choice?.threadId === candidate.threadId
                  : undefined
              }
              onClick={() =>
                candidate.kind === "thread"
                  ? intake.selectThread(candidate.threadId)
                  : intake.selectWorkstream(candidate.sectionId, candidate.name)
              }
            >
              {candidate.kind === "thread" ? candidate.title : candidate.name}
            </button>
          ))}
        </div>
      ) : null}
      {route.error ? (
        <p role="alert" className="text-xs text-destructive">
          {route.error}
        </p>
      ) : null}
    </div>
  );
}
