import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type FocusEvent,
} from "react";
import { useComposer, useComposerView } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useServerState } from "../useWorkstreams.ts";
import type { Intake, IntakeState } from "./intake.ts";

type Mark = "auto" | "busy" | "workstream" | "new" | "continue";

/** What the destination control shows, and what it announces. */
type Destination = {
  mark: Mark;
  /** Muted lead-in when the work doesn't start a thread in a workstream. */
  verb?: string;
  name: string;
  /** Placeholders are muted so a chosen destination reads as the value. */
  muted?: boolean;
  status: string;
};

/**
 * Reads only `Intake` state, whose `text` tracks the draft except while the
 * host has cleared the editor for a submit, when it keeps the submitted text.
 */
function destinationOf(route: IntakeState): Destination {
  if (route.workstreamId) {
    const name = route.workstreamName ?? "Selected workstream";
    return { mark: "workstream", name, status: `New thread in ${name}` };
  }
  if (!route.text)
    return { mark: "auto", name: "Automatic", muted: true, status: "" };
  if (route.loading)
    return {
      mark: "busy",
      name: "Choosing…",
      muted: true,
      // Announcing every typing pause is noise; the result is announced.
      status: "",
    };
  const decision = route.decision;
  if (!decision && route.error)
    return { mark: "auto", name: "Automatic", muted: true, status: "" };
  if (decision?.outcome === "new-thread")
    return {
      mark: "auto",
      name: decision.workstream,
      status: `New thread in ${decision.workstream}`,
    };
  if (decision?.outcome === "new-workstream")
    return {
      mark: "new",
      verb: "New workstream",
      name: decision.name,
      status: `New workstream ${decision.name}`,
    };
  const chosen =
    decision?.outcome === "unsure"
      ? decision.candidates.find(
          (c) => c.kind === "thread" && c.threadId === route.choice?.threadId,
        )
      : undefined;
  const continued =
    decision?.outcome === "continue"
      ? decision.threadTitle
      : chosen?.kind === "thread"
        ? chosen.title
        : null;
  if (continued !== null)
    return {
      mark: "continue",
      verb: "Continue",
      name: continued,
      status: `Continue ${continued}`,
    };
  return {
    mark: "auto",
    name: "Choose where this goes",
    status: "Choose where this goes",
  };
}

/**
 * Announces the destination. It renders outside the banner because the host
 * remounts banners on every project change, and a replaced live region can
 * drop the announcement it was about to make.
 */
export function IntakeStatus({ intake }: { intake: Intake }) {
  const route = useSyncExternalStore(intake.subscribe, intake.snapshot);
  return (
    <p
      id={intake.statusId}
      role="status"
      aria-live="polite"
      className="sr-only"
    >
      {destinationOf(route).status}
    </p>
  );
}

function DestinationMark({ mark }: { mark: Mark }) {
  if (mark === "auto")
    return (
      <span
        aria-hidden="true"
        className="w-3.5 shrink-0 text-center text-xs leading-none text-muted-foreground"
      >
        ✦
      </span>
    );
  const name = {
    busy: "Loading",
    workstream: "Layers",
    new: "Plus",
    continue: "CornerDownRight",
  }[mark];
  return (
    <Icon
      name={name}
      aria-hidden
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground",
        mark === "busy" && "animate-spin motion-reduce:animate-none",
      )}
    />
  );
}

/**
 * The destination row above the New work prompt: where the draft will go, a
 * native workstream select over it, and the toggle for the host's placement
 * row. The host remounts this banner when the project changes, so all state,
 * including which of its controls had focus, lives in the dialog's `Intake`.
 */
export function IntakeBanner({ intake }: { intake: Intake }) {
  const route = useSyncExternalStore(intake.subscribe, intake.snapshot);
  const composer = useComposer();
  const view = useComposerView();
  const { server } = useServerState();
  const select = useRef<HTMLSelectElement>(null);
  const settings = useRef<HTMLButtonElement>(null);
  const projectId =
    view.scope.kind === "new-thread" ? view.scope.projectId : null;
  const text = view.draft.text;
  useEffect(() => intake.observe(text, projectId), [intake, text, projectId]);
  useLayoutEffect(() => {
    // Removing the previous banner dropped focus to the body. The desktop host
    // may then move focus to its editor after the project change.
    if (document.activeElement && document.activeElement !== document.body)
      return;
    const target =
      intake.focused === "workstream"
        ? select
        : intake.focused === "settings"
          ? settings
          : null;
    target?.current?.focus();
  }, [intake]);
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

  const track = (control: NonNullable<Intake["focused"]>) => ({
    onFocus: () => {
      intake.focused = control;
    },
    // A null related target means the node was removed or focus left the
    // document; either way this control should get focus back.
    onBlur: (event: FocusEvent) => {
      if (event.relatedTarget) intake.focused = null;
    },
  });
  const workstreams = Object.values(server.workstreams);
  const destination = destinationOf(route);
  const candidates = decision?.outcome === "unsure" ? decision.candidates : [];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div
          className={cn(
            "relative inline-flex h-7 min-w-28 max-w-80 items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] font-medium hover:bg-state-hover has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring max-md:pointer-coarse:h-9",
            destination.muted ? "text-muted-foreground" : "text-foreground",
          )}
        >
          <DestinationMark mark={destination.mark} />
          <span className="min-w-0 truncate">
            {destination.verb ? (
              <span className="text-muted-foreground">{destination.verb} </span>
            ) : null}
            {destination.name}
          </span>
          <Icon
            name="ChevronDown"
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground"
          />
          {/* The chip is visual only. This transparent native select covers
              it for keyboard, screen reader, and platform picker behavior;
              16px text keeps iOS from zooming on focus. */}
          <select
            ref={select}
            aria-label="Workstream"
            aria-describedby={intake.statusId}
            title={destination.status || undefined}
            className="absolute inset-0 size-full cursor-pointer appearance-none text-base opacity-0"
            value={route.workstreamId ?? ""}
            {...track("workstream")}
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
              <option value={route.workstreamId}>{destination.name}</option>
            ) : null}
            {workstreams.map((w) => (
              <option key={w.sectionId} value={w.sectionId}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <button
          ref={settings}
          type="button"
          aria-expanded={route.settings}
          {...track("settings")}
          onClick={() => intake.toggleSettings()}
          className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-expanded:text-foreground max-md:pointer-coarse:h-9"
        >
          <Icon name="SlidersHorizontal" aria-hidden className="size-3.5" />
          Settings
          <Icon
            name="ChevronDown"
            aria-hidden
            className={cn(
              "size-3 transition-transform motion-reduce:transition-none",
              route.settings && "rotate-180",
            )}
          />
        </button>
      </div>
      {candidates.length > 0 ? (
        <div
          role="group"
          aria-label="Possible destinations"
          className="flex flex-wrap gap-1.5"
        >
          {candidates.map((candidate) => {
            const label =
              candidate.kind === "thread" ? candidate.title : candidate.name;
            return (
              <button
                type="button"
                title={label}
                className="inline-flex h-6 min-w-0 max-w-60 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-state-active aria-pressed:text-foreground max-md:pointer-coarse:h-9"
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
                onClick={() => {
                  if (candidate.kind === "thread") {
                    intake.selectThread(candidate.threadId);
                    return;
                  }
                  // The pills go away once the workstream routes; the select
                  // now shows the choice.
                  select.current?.focus();
                  intake.selectWorkstream(candidate.sectionId, candidate.name);
                }}
              >
                <Icon
                  name={
                    candidate.kind === "thread" ? "CornerDownRight" : "Layers"
                  }
                  aria-hidden
                  className="size-3 shrink-0"
                />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
