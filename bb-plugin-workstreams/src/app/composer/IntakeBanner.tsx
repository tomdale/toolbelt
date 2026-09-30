import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useComposer, useSdk } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { useServerState } from "../useWorkstreams.ts";
import {
  suggestionAccepted,
  type Environment,
  type Intake,
  type IntakeState,
} from "./intake.ts";

export function statusText(state: IntakeState): string {
  if (!state.text) return "";
  if (state.selectionError) return "Couldn't apply placement";
  if (state.error) return "Couldn't choose a destination";
  if (state.loading) return "Choosing where this goes";
  if (state.decision?.outcome === "unsure") return "Pick a destination";
  if (
    state.decision &&
    state.decision.outcome !== "continue" &&
    !state.project.value
  )
    return "Pick a project";
  if (state.decision) {
    const status =
      state.destination.source === "manual"
        ? "Chosen manually"
        : "Filled automatically";
    return state.suggestion && !suggestionAccepted(state)
      ? `${status}. Suggested: continue ${state.suggestion.continuation.threadTitle}`
      : status;
  }
  return "";
}
export function IntakeStatus({ intake }: { intake: Intake }) {
  const state = useSyncExternalStore(intake.subscribe, intake.snapshot);
  return (
    <p
      id={intake.statusId}
      role="status"
      aria-live="polite"
      className="sr-only"
    >
      {state.announcement || statusText(state)}
    </p>
  );
}
type Option = { value: string; label: string; group?: string };
function Field({
  intake,
  field,
  label,
  value,
  automatic,
  implied = false,
  icon,
  options,
  onPick,
  locked = false,
  need = false,
  waiting = false,
}: {
  intake: Intake;
  field: "action" | "destination" | "project" | "environment";
  label?: string;
  value: string;
  automatic: boolean;
  implied?: boolean;
  icon: "Plus" | "Folder" | "Layers" | "MessageSquare" | "CircleDashed";
  options: Option[];
  onPick: (value: string) => void;
  locked?: boolean;
  need?: boolean;
  waiting?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const preview = intake.automaticPreview(field);
  const revertLabel = `Use automatic ${field}${preview ? `: ${preview}` : ""}`;
  const visible = options.filter((o) =>
    `${o.label} ${o.value === "none" ? "unassigned" : ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const close = () => {
    setOpen(false);
    setQuery("");
    trigger.current?.focus();
  };
  useEffect(() => {
    if (intake.focused === field) trigger.current?.focus();
  }, [intake, field]);
  useEffect(() => {
    if (!open) return;
    (
      menu.current?.querySelector<HTMLInputElement>("input") ??
      menu.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')
    )?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return (
    <div ref={anchor} className={`ws-intake-field ws-intake-${field}`}>
      <div className="ws-intake-chip" data-need={need} data-waiting={waiting}>
        <button
          ref={trigger}
          type="button"
          className="ws-intake-trigger"
          title={`${label ? `${label}: ` : ""}${value}`}
          aria-label={`${label ?? "Action"}: ${value || "unresolved"}, ${locked ? "locked" : automatic ? "automatic" : "chosen"}`}
          aria-haspopup={locked ? undefined : "menu"}
          aria-expanded={locked ? undefined : open}
          aria-describedby={intake.statusId}
          onFocus={() => {
            intake.focused = field;
          }}
          onBlur={() => {
            if (!open) intake.focused = null;
          }}
          onClick={() => !locked && setOpen(!open)}
          onKeyDown={(event) => {
            if (
              !locked &&
              (event.key === "Delete" || event.key === "Backspace") &&
              !automatic &&
              !implied
            ) {
              event.preventDefault();
              intake.revertField(field);
            }
            if (!locked && event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          {locked ? (
            <Icon
              name="Lock"
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : automatic ? (
            <span className="ws-intake-star" aria-hidden>
              ✦
            </span>
          ) : (
            <Icon
              name={icon}
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          )}
          {label ? <span className="ws-intake-type">{label}</span> : null}
          {value ? <span className="ws-intake-value">{value}</span> : null}
          {!locked ? (
            <Icon
              name="ChevronDown"
              className="size-3 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : null}
        </button>
        {!automatic && !implied && !locked ? (
          <button
            type="button"
            className="ws-intake-revert"
            aria-label={revertLabel}
            title={revertLabel}
            onClick={() => {
              intake.focused = field;
              intake.revertField(field);
              trigger.current?.focus();
            }}
          >
            ✧
          </button>
        ) : null}
      </div>
      {open ? (
        <div
          ref={menu}
          className="ws-intake-menu"
          role="menu"
          aria-label={`${label ?? "Action"} choices`}
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") {
              event.preventDefault();
              close();
              return;
            }
            const buttons = Array.from(
              menu.current!.querySelectorAll<HTMLButtonElement>(
                'button[role="menuitem"]',
              ),
            );
            const index = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : event.key === "ArrowDown"
                    ? (index + 1) % buttons.length
                    : event.key === "ArrowUp"
                      ? (index - 1 + buttons.length) % buttons.length
                      : -1;
            if (next >= 0) {
              event.preventDefault();
              buttons[next]?.focus();
            }
          }}
        >
          {field !== "action" ? (
            <input
              aria-label={`Search ${label?.toLowerCase()}`}
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              intake.revertField(field);
              close();
            }}
          >
            <span className="ws-intake-hollow" aria-hidden>
              ✧
            </span>
            <span>Automatic{preview ? <small>{preview}</small> : null}</span>
          </button>
          {visible.map((option, i) => (
            <div key={option.value}>
              {option.group && option.group !== visible[i - 1]?.group ? (
                <div className="ws-intake-menu-group">{option.group}</div>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onPick(option.value);
                  close();
                }}
              >
                {option.label}
              </button>
            </div>
          ))}
          {!visible.length ? (
            <p className="text-xs text-muted-foreground">No matches</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
export function environmentLabel(
  environment: Environment | null,
  state: IntakeState,
): string {
  if (!environment) return "";
  if (environment.type === "reuse")
    return (
      state.environments.find((e) => e.id === environment.environmentId)
        ?.name ?? "Unnamed environment"
    );
  if (environment.type === "project-default") return "Project default";
  if (environment.type === "host")
    return environment.workspace.type === "managed-worktree"
      ? "New worktree"
      : environment.workspace.type === "personal"
        ? "Personal workspace"
        : "Project checkout";
  return environment.type === "provider" ? "New environment" : "Environment";
}
export function IntakeBanner({ intake }: { intake: Intake }) {
  const state = useSyncExternalStore(intake.subscribe, intake.snapshot);
  const composer = useComposer();
  const sdk = useSdk();
  const { server } = useServerState();
  const projectId = state.project.value;
  useEffect(() => {
    void intake.loadCatalogs(sdk);
  }, [intake, sdk]);
  useEffect(() => {
    void intake.loadEnvironments(sdk, projectId);
  }, [intake, sdk, projectId]);
  useEffect(() => {
    intake.observe(composer.text);
  }, [intake, composer.text]);
  const selectedThreadId =
    state.destination.value.kind === "thread"
      ? state.destination.value.id
      : null;
  useEffect(() => {
    if (selectedThreadId) void intake.loadThread(sdk, selectedThreadId);
  }, [intake, sdk, selectedThreadId]);
  // Loading the suggested thread early lets accepting it apply at once.
  const suggestedThreadId = state.suggestion?.continuation.threadId ?? null;
  useEffect(() => {
    if (suggestedThreadId) void intake.loadThread(sdk, suggestedThreadId);
  }, [intake, sdk, suggestedThreadId]);
  useEffect(() => {
    const selection = intake.selection();
    if (selection)
      void composer.setSelection(selection).then(
        (applied) => intake.reconcileSelection(selection, applied),
        (error) => intake.selectionFailed(error, selection),
      );
  }, [
    composer,
    intake,
    state.project,
    state.environment,
    state.action,
    state.destination,
    state.threads,
    state.threadExecution,
    state.selectionRevision,
  ]);
  const action = intake.effectiveAction();
  const destination = state.destination.value;
  const workstreams = Object.values(server.workstreams);
  const locked = action === "send-message" && destination.kind === "thread";
  const thread = intake.lockedThread();
  const destinationOptions: Option[] = [];
  if (state.action.source !== "manual" || action === "new-thread") {
    destinationOptions.push(
      ...workstreams.map((w) => ({
        value: `workstream:${w.sectionId}`,
        label: w.name,
        group: "Workstreams",
      })),
      { value: "none", label: "No workstream", group: "Workstreams" },
    );
  }
  // Existing threads are classifier proposals, not a general message router.
  const hostId =
    state.projects.find((p) => p.id === projectId)?.hostId ?? state.hostId;
  const label =
    action === "send-message"
      ? "Thread"
      : action === "new-thread"
        ? "Workstream"
        : "Destination";
  const value =
    destination.kind === "workstream"
      ? destination.name
      : destination.kind === "thread"
        ? destination.title
        : destination.kind === "unassigned"
          ? "No workstream"
          : state.loading
            ? "Choosing…"
            : state.text
              ? "Choose one"
              : "";
  const pickDestination = (id: string) => {
    if (id === "none") intake.selectUnassigned();
    if (id.startsWith("workstream:")) {
      const w = workstreams.find((w) => w.sectionId === id.slice(11));
      if (w) intake.selectWorkstream(w.sectionId, w.name);
    }
    if (id.startsWith("thread:")) {
      const t = state.threads.find((t) => t.id === id.slice(7));
      if (t)
        intake.selectDestination({ kind: "thread", id: t.id, title: t.title });
    }
  };
  const projectName = (id: string | null | undefined) =>
    state.projects.find((p) => p.id === id)?.name ?? id ?? "";
  const suggestion = state.suggestion;
  const accepted = suggestionAccepted(state);
  const suggestionButton = useRef<HTMLButtonElement>(null);
  // Accepting can switch the project, which remounts this banner and drops
  // focus to the body. Focus that moved elsewhere stays where it is.
  useEffect(() => {
    const active = document.activeElement;
    if (
      intake.focused === "suggestion" &&
      (!active || active === document.body)
    )
      suggestionButton.current?.focus();
  }, [intake, suggestion]);
  const suggestionLabel = !suggestion
    ? ""
    : accepted
      ? "Start a new thread instead"
      : `Continue ${suggestion.continuation.threadTitle} instead`;
  return (
    <div className="ws-intake-controls">
      <div className="ws-intake-row ws-intake-route-row">
        <Field
          intake={intake}
          field="action"
          value={
            action === "automatic"
              ? "Action"
              : action === "new-thread"
                ? "New thread"
                : action === "send-message"
                  ? "Send message"
                  : "New workstream"
          }
          automatic={
            state.action.source === "automatic" &&
            state.destination.source === "automatic"
          }
          implied={
            state.action.source === "automatic" &&
            state.destination.source === "manual"
          }
          icon={
            action === "send-message"
              ? "MessageSquare"
              : action === "new-workstream"
                ? "Layers"
                : "Plus"
          }
          options={[
            { value: "new-thread", label: "New thread" },
            { value: "new-workstream", label: "New workstream" },
          ]}
          onPick={(value) =>
            intake.selectAction(
              value as "new-thread" | "send-message" | "new-workstream",
            )
          }
        />
        {action !== "new-workstream" && destination.kind !== "unassigned" ? (
          <span className="ws-intake-connector">
            {action === "send-message" ? "to" : "in"}
          </span>
        ) : null}
        {action === "new-workstream" ? (
          <div className="ws-intake-field ws-intake-destination">
            <div className="ws-intake-chip ws-intake-name">
              {state.name.source === "automatic" ? (
                <span className="ws-intake-star" aria-hidden>
                  ✦
                </span>
              ) : (
                <Icon name="Layers" className="size-3.5 shrink-0" aria-hidden />
              )}
              <span className="ws-intake-type">Name</span>
              <input
                aria-label="Workstream name"
                value={state.name.value}
                onChange={(e) => intake.selectName(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    (e.key === "Delete" || e.key === "Backspace") &&
                    !state.name.value
                  ) {
                    e.preventDefault();
                    intake.revertField("name");
                  }
                }}
              />
              {state.name.source === "manual" ? (
                <button
                  className="ws-intake-revert"
                  type="button"
                  aria-label={`Use automatic name: ${intake.automaticPreview("name")}`}
                  onClick={() => intake.revertField("name")}
                >
                  ✧
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <Field
            intake={intake}
            field="destination"
            label={label}
            value={value}
            automatic={state.destination.source === "automatic"}
            icon={
              destination.kind === "thread"
                ? "MessageSquare"
                : destination.kind === "unassigned"
                  ? "CircleDashed"
                  : "Layers"
            }
            need={state.decision?.outcome === "unsure"}
            options={destinationOptions}
            onPick={pickDestination}
          />
        )}
        {suggestion ? (
          // Offers whichever of the two routes the draft isn't taking, in the
          // same place, so accepting and declining never move the control.
          <button
            ref={suggestionButton}
            key={suggestion.continuation.threadId}
            type="button"
            className="ws-intake-suggestion"
            onFocus={() => {
              intake.focused = "suggestion";
            }}
            onBlur={(event) => {
              // No related target: the banner remounted or the window blurred.
              if (event.relatedTarget) intake.focused = null;
            }}
            aria-label={suggestionLabel}
            title={suggestionLabel}
            onClick={() =>
              accepted
                ? intake.declineSuggestion()
                : intake.acceptSuggestion(composer.selection)
            }
          >
            <Icon
              name={accepted ? "Plus" : "CornerDownRight"}
              className="size-3.5 shrink-0"
              aria-hidden
            />
            {accepted ? (
              <span className="ws-intake-value">New thread</span>
            ) : (
              <>
                <span className="ws-intake-type">Continue</span>
                <span className="ws-intake-value">
                  {suggestion.continuation.threadTitle}
                </span>
              </>
            )}
          </button>
        ) : null}
      </div>
      <div className="ws-intake-row ws-intake-placement-row">
        {locked ? (
          <span className="ws-intake-connector">Thread runs in</span>
        ) : null}
        <Field
          intake={intake}
          field="project"
          label="Project"
          need={!locked && !!state.decision && !projectId}
          value={
            locked
              ? projectName(thread?.projectId) || "Loading…"
              : projectName(projectId) ||
                (state.text && !state.loading ? "Choose one" : "")
          }
          automatic={state.project.source === "automatic"}
          icon="Folder"
          locked={locked}
          options={state.projects.map((p) => ({ value: p.id, label: p.name }))}
          onPick={(value) => intake.selectProject(value)}
        />
        <Field
          intake={intake}
          field="environment"
          label="Environment"
          waiting={!locked && !projectId}
          value={
            locked
              ? (thread?.environmentName ?? thread?.environmentId ?? "Loading…")
              : environmentLabel(state.environment.value, state)
          }
          automatic={state.environment.source === "automatic"}
          icon="Folder"
          locked={locked}
          options={[
            ...(hostId
              ? [
                  { value: "checkout", label: "Project checkout" },
                  ...(state.environment.value?.type === "host" &&
                  state.environment.value.workspace.type === "personal"
                    ? [{ value: "personal", label: "Personal workspace" }]
                    : [{ value: "worktree", label: "New worktree" }]),
                ]
              : []),
            ...state.environments.map((e) => ({
              value: e.id,
              label: e.name ?? e.id,
            })),
          ]}
          onPick={(value) =>
            intake.selectEnvironment(
              value === "checkout"
                ? {
                    type: "host",
                    hostId: hostId ?? undefined,
                    workspace: { type: "unmanaged", path: null },
                  }
                : value === "personal"
                  ? {
                      type: "host",
                      hostId: hostId ?? undefined,
                      workspace: { type: "personal" },
                    }
                  : value === "worktree"
                  ? {
                      type: "host",
                      hostId: hostId ?? undefined,
                      workspace: {
                        type: "managed-worktree",
                        baseBranch: { kind: "default" },
                      },
                    }
                  : { type: "reuse", environmentId: value },
            )
          }
        />
      </div>
      <p className="ws-intake-status sr-only" aria-live="polite">
        {statusText(state)}
      </p>
      {state.error || state.selectionError || state.catalogError ? (
        <div
          className="ws-intake-recovery"
          role="alert"
          data-error={!!(state.error || state.selectionError)}
        >
          <span>{state.error || state.selectionError || state.catalogError}</span>
          <button type="button" onClick={() => intake.retry()}>
            Retry
          </button>
          {state.catalogError ? (
            <button
              type="button"
              onClick={() => {
                void intake.loadCatalogs(sdk);
                void intake.loadEnvironments(sdk, projectId);
                if (selectedThreadId) void intake.loadThread(sdk, selectedThreadId);
              }}
            >
              Retry choices
            </button>
          ) : null}
        </div>
      ) : null}
      {state.decision?.outcome === "unsure" ? (
        <div
          role="group"
          aria-label="Possible destinations"
          className="ws-intake-candidates"
        >
          {state.decision.candidates.map((c) => (
            <button
              type="button"
              key={c.kind === "thread" ? c.threadId : c.sectionId}
              onClick={() =>
                c.kind === "thread"
                  ? intake.selectDestination({
                      kind: "thread",
                      id: c.threadId,
                      title: c.title,
                    })
                  : intake.selectWorkstream(c.sectionId, c.name)
              }
            >
              {c.kind === "thread"
                ? `Send message to ${c.title}`
                : `New thread in ${c.name}`}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
