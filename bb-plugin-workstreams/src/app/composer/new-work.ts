/**
 * New work's state outside React: the workstream the next thread is filed in,
 * the classification that runs while the user pauses typing, and accepting
 * its suggestion.
 *
 * BB's composer owns the draft, project, environment and execution settings,
 * exactly as in its own New thread view. Workstreams adds one field, the
 * workstream. The field starts Automatic: each classification moves the
 * workstream, project and environment pickers to the home it names, marked
 * with the magic tint, and Enter starts the thread the pickers show. Any
 * manual change — a picked workstream, No workstream, a different project or
 * environment — pins every picker and stops the automatic updates; choosing
 * Automatic again unpins. A suggested thread changes nothing until it is
 * accepted, so Enter never silently sends a draft to a thread.
 */
import { createContext } from "react";
import type {
  ComposerSelection,
  NewThreadRequest,
  PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import type { Placement, RouteDecision } from "../../server/router.ts";
import type { DraftSubjectProposal } from "../../domain/corpus.ts";
import { routeDelay } from "./timing.ts";

export type IdentityChoice = {
  entityId: string | null;
  proposal: DraftSubjectProposal | null;
  label: string;
  provenance: "manual" | "automatic";
} | null;

export type WorkstreamChoice = {
  id: string;
  name: string;
  subjectId?: string;
} | null;

/** A workstream the classification proposed and no one has created yet.
 *  While the pickers are Automatic it shows in the field, and submitting
 *  creates it and files the thread there. */
export type PendingWorkstream = {
  name: string;
  description: string;
  subjectId?: string;
};

type SuggestionBase = {
  /** Identifies one classification result, so accepting or dismissing it sticks. */
  key: string;
  reason: string;
  traceId: string | null;
  identity?: {
    entityId?: string | null;
    proposal?: DraftSubjectProposal | null;
    label: string;
  } | null;
};

/** The single most likely home for the draft, as New work shows it. */
export type Suggestion =
  | (SuggestionBase & {
      kind: "thread";
      threadId: string;
      title: string;
      workstream: string | null;
    })
  | (SuggestionBase & {
      kind: "workstream";
      sectionId: string;
      name: string;
      placement: Placement | null;
    })
  | (SuggestionBase & {
      kind: "new-workstream";
      name: string;
      description: string;
      placement: Placement | null;
    });

/** The suggestion a route decision makes, or null when it names no home. */
export function suggestionFrom(decision: RouteDecision): Suggestion | null {
  const identity =
    decision.subjectId || decision.proposal || decision.subject
      ? {
          entityId: decision.subjectId ?? null,
          proposal: decision.proposal ?? null,
          label:
            decision.subject ??
            decision.proposal?.name ??
            decision.subjectId ??
            "",
        }
      : null;
  const base = {
    key: decision.id,
    reason: decision.reason,
    traceId: decision.traceId,
    identity,
  };
  switch (decision.outcome) {
    case "continue":
      return {
        ...base,
        kind: "thread",
        threadId: decision.threadId,
        title: decision.threadTitle,
        workstream: decision.workstream,
      };
    case "new-thread":
      return decision.sectionId
        ? {
            ...base,
            kind: "workstream",
            sectionId: decision.sectionId,
            name: decision.workstream ?? decision.sectionId,
            placement: decision.placement,
          }
        : null;
    case "new-workstream":
      return {
        ...base,
        kind: "new-workstream",
        name: decision.name,
        description: decision.description,
        placement: decision.placement,
      };
    case "unsure":
      return null;
  }
}

/**
 * One thing the dialog did, for Debug mode's Copy diagnostics: a classification of the draft,
 * accepting or dismissing a suggestion, picking or creating a workstream, or
 * a submit. Each records its inputs and its result or error.
 */
export type NewWorkEvent = {
  id: number;
  at: number;
  kind:
    | "classify"
    | "accept"
    | "apply"
    | "dismiss"
    | "select-workstream"
    | "select-identity"
    | "create-workstream"
    | "submit";
  /** `superseded`: newer text replaced the draft before the answer came. */
  status: "pending" | "ok" | "failed" | "superseded";
  durationMs: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
};

/** The newest events the dialog keeps for Debug mode. */
const EVENT_LIMIT = 100;

export type NewWorkState = {
  /** The draft's trimmed plain text, as last observed from the composer. */
  text: string;
  workstream: WorkstreamChoice;
  identity: IdentityChoice;
  /**
   * True while the pickers are the user's: a preset workstream, a picked
   * value (including No workstream), or a manual project or environment
   * change. While false, each classification moves the pickers to the home
   * it names.
   */
  pinned: boolean;
  /** A proposed workstream no one has created; Automatic mode only. */
  pendingNew: PendingWorkstream | null;
  /** The composer's own picker values. */
  selection: ComposerSelection | null;
  /**
   * The latest classification. It stays up while a newer draft is being
   * classified, so it doesn't flicker with each pause, and is replaced when
   * that result arrives.
   */
  suggestion: Suggestion | null;
  /** The route decision the suggestion came from, as the server sent it. */
  decision: RouteDecision | null;
  classifying: boolean;
  /** The key of the suggestion the user accepted or dismissed. */
  settled: string | null;
  accepting: boolean;
  acceptedRoute: {
    routeId: string;
    sectionId?: string;
    subjectId?: string;
  } | null;
  /** Why the last submit or acceptance failed. */
  error: string | null;
  /** Counts failures, so a repeated message is announced again. */
  errors: number;
  /** What the dialog did, oldest first, for Debug mode. */
  events: readonly NewWorkEvent[];
};

export type NewWorkDeps = {
  /**
   * Classifies `prompt` for a suggestion, telling the model to prefer
   * `workstreamId` (the field's value) when the request fits. A newer call
   * supersedes it.
   */
  route(
    prompt: string,
    workstreamId: string | null,
    pickedProjectId?: string | null,
  ): Promise<RouteDecision>;
  /** Aborts the classification in flight. */
  cancelRoute(): void;
  /** Resolves with the name BB stored, which may be normalized. */
  createWorkstream(
    name: string,
    description: string,
  ): Promise<{ sectionId: string; name: string }>;
  startThread(
    sectionId: string | null,
    request: NewThreadRequest,
    options?: {
      identity?: {
        entityId?: string | null;
        proposal?: DraftSubjectProposal | null;
        provenance?: "manual" | "automatic";
      } | null;
      newWorkstream?: { name: string; description?: string } | null;
    },
  ): Promise<{ threadId: string }>;
  sendToThread(
    threadId: string,
    input: NewThreadRequest["input"],
    traceId: string | null,
  ): Promise<void>;
  sendDraftToThread?(threadId: string, traceId: string | null): Promise<void>;
  submitWithRoute?(
    routeId: string | null,
    sectionId?: string | null,
    options?: {
      newWorkstream?: { name: string; description?: string } | null;
      identity?: {
        entityId?: string | null;
        proposal?: DraftSubjectProposal | null;
        provenance?: "manual" | "automatic";
      } | null;
    },
  ): Promise<void>;
};

export type SubmitResult =
  | { kind: "started"; threadId: string }
  | { kind: "sent"; threadId: string; title: string };

/**
 * Whether the pickers already say what a workstream suggestion would set.
 * The environment isn't compared: BB reports a resolved environment in its
 * own shape, and the workstream and project are what the suggestion is about.
 * An automatically applied destination counts: the automatic classification
 * fills the pickers before the row would offer the same home again.
 */
function alreadyApplied(suggestion: Suggestion, state: NewWorkState): boolean {
  if (suggestion.kind === "new-workstream")
    return state.pendingNew?.name === suggestion.name;
  if (suggestion.kind !== "workstream") return false;
  if (state.workstream?.id !== suggestion.sectionId) return false;
  return (
    !suggestion.placement ||
    state.selection?.projectId === suggestion.placement.projectId
  );
}

/** The placement part of a selection, as a comparable string. Accepts the
 *  shape a suggestion's placement would apply, so an applied destination can
 *  be compared with what the composer reports. */
function placementSignature(
  selection: { projectId?: string; environment?: unknown } | null | undefined,
): string {
  return JSON.stringify({
    projectId: selection?.projectId ?? null,
    environment: selection?.environment ?? null,
  });
}

/**
 * What the Workstream field shows: the picked or automatic workstream, the
 * proposed one submitting would create, or one of the two rest states.
 * `auto` picks the magic treatment; `reason` is the classification's one-line
 * why, shown as the field's tooltip.
 */
export function pickerDisplay(state: NewWorkState): {
  id: string | null;
  label: string;
  auto: boolean;
  /** The field names a destination, not a rest state. */
  destination: boolean;
  /** Submitting would create this workstream first. */
  creating: boolean;
  reason: string | null;
} {
  if (state.pendingNew)
    return {
      id: null,
      label: state.pendingNew.name,
      auto: true,
      destination: true,
      creating: true,
      reason: state.decision?.reason ?? null,
    };
  if (state.workstream)
    return {
      id: state.workstream.id,
      label: state.workstream.name,
      auto: !state.pinned,
      destination: true,
      creating: false,
      reason: state.pinned ? null : (state.decision?.reason ?? null),
    };
  if (!state.pinned)
    return {
      id: null,
      label: "Automatic",
      auto: true,
      destination: false,
      creating: false,
      reason: null,
    };
  return {
    id: null,
    label: "No workstream",
    auto: false,
    destination: false,
    creating: false,
    reason: null,
  };
}

export function identityDisplay(state: NewWorkState): {
  id: string | null;
  label: string;
  auto: boolean;
  selected: boolean;
  reason: string | null;
} {
  if (state.identity)
    return {
      id: state.identity.entityId,
      label: state.identity.label,
      auto: state.identity.provenance === "automatic",
      selected: true,
      reason:
        state.identity.provenance === "automatic"
          ? (state.decision?.reason ?? null)
          : null,
    };
  return {
    id: null,
    label: "Automatic",
    auto: true,
    selected: false,
    reason: null,
  };
}

export function composerSummary(state: NewWorkState): {
  identityLabel: string;
  placementLabel: string;
  text: string;
} {
  const ident = state.identity ? state.identity.label : "Unresolved";
  const place = pickerDisplay(state).label;
  return {
    identityLabel: ident,
    placementLabel: place,
    text: `Concerning ${ident} · In ${place}`,
  };
}

/** Whether ⏎ would file into a destination the pickers show. */
export function hasDestination(state: NewWorkState): boolean {
  return !!(state.workstream || state.pendingNew);
}

/** Why the suggestion is or isn't showing, in Debug mode's words. */
export function suggestionVisibility(state: NewWorkState): string {
  const { suggestion } = state;
  if (!state.text) return "Hidden: the draft is empty.";
  if (!suggestion)
    return state.classifying
      ? "Waiting for the first classification."
      : state.decision
        ? "None: the router named no home."
        : "None yet: classification runs once typing pauses.";
  if (suggestion.key === state.settled)
    return "Hidden: you accepted or dismissed it.";
  if (alreadyApplied(suggestion, state))
    return "Hidden: the pickers already match it.";
  return state.classifying
    ? "Shown, while newer text is being classified."
    : "Shown.";
}

/** The suggestion New work shows now, if any. */
export function shownSuggestion(state: NewWorkState): Suggestion | null {
  const { suggestion } = state;
  if (!state.text || !suggestion || suggestion.key === state.settled)
    return null;
  return alreadyApplied(suggestion, state) ? null : suggestion;
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class NewWork {
  private state: NewWorkState;
  private listeners = new Set<() => void>();
  private composer: PluginComposerApi | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private pending = false;
  /** The thread the next composer submit goes to instead of a new thread. */
  private sendTarget: Extract<Suggestion, { kind: "thread" }> | null = null;
  private eventIds = 0;
  /** Set while this model applies a selection itself, so the composer's echo
   *  of that change doesn't count as the user pinning the pickers. */
  private applying = 0;
  /** The placement this model last applied; a later observation that matches
   *  it is the composer reconciling, not a user override. */
  private lastAppliedSignature: string | null = null;

  constructor(
    private deps: NewWorkDeps,
    workstream: WorkstreamChoice = null,
    private nativeFlow = false,
  ) {
    this.state = {
      text: "",
      workstream,
      identity: null,
      pinned: workstream !== null,
      pendingNew: null,
      selection: null,
      suggestion: null,
      decision: null,
      classifying: false,
      settled: null,
      accepting: false,
      acceptedRoute: null,
      error: null,
      errors: 0,
      events: [],
    };
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<NewWorkState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  /** Starts an event; `finish` settles it with a result or an error. */
  private begin(
    kind: NewWorkEvent["kind"],
    input: unknown,
  ): (
    status: Exclude<NewWorkEvent["status"], "pending">,
    result?: { output?: unknown; error?: unknown },
  ) => void {
    const id = ++this.eventIds;
    const at = Date.now();
    const event: NewWorkEvent = {
      id,
      at,
      kind,
      status: "pending",
      durationMs: null,
      input,
      output: null,
      error: null,
    };
    this.set({ events: [...this.state.events, event].slice(-EVENT_LIMIT) });
    return (status, result = {}) => {
      this.set({
        events: this.state.events.map((e) =>
          e.id === id
            ? {
                ...e,
                status,
                durationMs: Date.now() - at,
                output: result.output ?? null,
                error:
                  result.error === undefined ? null : messageOf(result.error),
              }
            : e,
        ),
      });
    };
  }

  /** The composer this dialog embeds; its slot remounts on a project change. */
  attach(composer: PluginComposerApi) {
    this.composer = composer;
  }

  observe(text: string) {
    const trimmed = text.trim();
    if (trimmed === this.state.text) return;
    this.set({
      text: trimmed,
      acceptedRoute: null,
      error: null,
      ...(trimmed
        ? {}
        : {
            suggestion: null,
            decision: null,
            // An emptied draft has no automatic destination; manual selections stay.
            identity:
              this.state.identity?.provenance === "manual"
                ? this.state.identity
                : null,
            ...this.withdrawn(),
          }),
    });
    this.schedule();
  }

  observeSelection(selection: ComposerSelection | null) {
    const prev = this.state.selection;
    if (selection === prev) return;
    this.set({ selection });
    // In Automatic mode, a placement change the model didn't apply itself is
    // the user overriding the pickers: everything pins from then on.
    if (
      !this.state.pinned &&
      !this.applying &&
      prev &&
      selection &&
      placementSignature(selection) !== placementSignature(prev) &&
      placementSignature(selection) !== this.lastAppliedSignature
    ) {
      this.set({ pinned: true, pendingNew: null });
    }
  }

  selectWorkstream(choice: WorkstreamChoice) {
    this.begin("select-workstream", {
      from: this.state.workstream,
      to: choice,
    })("ok");
    this.set({
      workstream: choice,
      pendingNew: null,
      acceptedRoute: null,
      pinned: true,
      error: null,
    });
  }

  selectIdentity(
    choice: {
      entityId?: string | null;
      proposal?: DraftSubjectProposal | null;
      label?: string;
    } | null,
    provenance: "manual" | "automatic" = "manual",
  ) {
    const nextChoice: NonNullable<IdentityChoice> = choice
      ? {
          entityId: choice.entityId ?? null,
          proposal: choice.proposal ?? null,
          label:
            choice.label ?? (choice.entityId ? choice.entityId : "Unresolved"),
          provenance,
        }
      : {
          entityId: null,
          proposal: null,
          label: "Unresolved",
          provenance,
        };
    this.begin("select-identity", {
      from: this.state.identity,
      to: nextChoice,
      provenance,
    })("ok");
    this.set({
      identity: nextChoice,
      error: null,
    });
  }

  selectAutomaticIdentity() {
    this.begin("select-identity", {
      from: this.state.identity,
      to: "automatic",
    })("ok");
    let identity: IdentityChoice = null;
    if (this.state.decision?.subjectId) {
      identity = {
        entityId: this.state.decision.subjectId,
        proposal: null,
        label: this.state.decision.subject ?? this.state.decision.subjectId,
        provenance: "automatic",
      };
    } else if (this.state.decision?.proposal) {
      identity = {
        entityId: null,
        proposal: this.state.decision.proposal,
        label: this.state.decision.subject ?? this.state.decision.proposal.name,
        provenance: "automatic",
      };
    }
    this.set({
      identity,
      error: null,
    });
  }

  /**
   * Returns the field to Automatic: the next classification moves the pickers
   * again, starting with the one the current decision already named.
   */
  selectAutomatic() {
    const display = pickerDisplay(this.state);
    this.begin("select-workstream", {
      from: display.label,
      to: "automatic",
    })("ok");
    this.set({
      workstream: null,
      pendingNew: null,
      acceptedRoute: null,
      pinned: false,
      error: null,
    });
    void this.autoApply(shownSuggestion(this.state));
  }

  /** The automatic state with no destination, when the pickers aren't pinned. */
  private withdrawn(): Partial<NewWorkState> {
    return this.state.pinned ? {} : { workstream: null, pendingNew: null };
  }

  reportError(error: unknown) {
    this.set({ error: messageOf(error), errors: this.state.errors + 1 });
  }

  /** Creates a workstream the user named in the picker and selects it. */
  async createWorkstream(name: string): Promise<void> {
    const clean = name.trim();
    if (!clean) return;
    const finish = this.begin("create-workstream", { name: clean });
    try {
      const created = await this.deps.createWorkstream(clean, "");
      finish("ok", { output: created });
      this.selectWorkstream({ id: created.sectionId, name: created.name });
    } catch (error) {
      finish("failed", { error });
      this.reportError(error);
    }
  }

  dismiss() {
    const suggestion = shownSuggestion(this.state);
    if (!suggestion) return;
    this.begin("dismiss", { suggestion })("ok");
    this.set({ settled: suggestion.key, error: null });
  }

  /**
   * Accepts the shown suggestion. A workstream suggestion fills the
   * Workstream, Project and Environment pickers, creating the workstream
   * first when it's new; with `submit`, the composer then starts the thread
   * with them. A thread suggestion has no pickers to fill, so it only
   * submits: the draft goes to that thread through the composer's own
   * submit, so attachments and mentions travel with it, and the dialog
   * closes as for any submit.
   */
  async accept({ submit }: { submit: boolean }): Promise<void> {
    const suggestion = shownSuggestion(this.state);
    const composer = this.composer;
    if (!suggestion || !composer || this.state.accepting) return;
    if (suggestion.kind === "thread" && !submit) return;
    this.set({ accepting: true, error: null });
    const finish = this.begin("accept", { suggestion, submit });
    try {
      if (suggestion.kind === "thread") {
        if (this.nativeFlow && this.deps.sendDraftToThread) {
          await this.deps.sendDraftToThread(
            suggestion.threadId,
            suggestion.traceId,
          );
          this.set({ settled: suggestion.key });
          finish("ok", { output: "Sent the draft to the suggested thread." });
          return;
        }
        this.sendTarget = suggestion;
        await composer.submit({ experimental_data: null });
        finish("ok", { output: "Submitted the draft to the thread." });
        return;
      }
      let acceptedSectionId: string | undefined;
      let workstream = this.state.workstream;
      let pendingNew = this.state.pendingNew;
      if (suggestion.kind === "workstream") {
        workstream = { id: suggestion.sectionId, name: suggestion.name };
        pendingNew = null;
        acceptedSectionId = suggestion.sectionId;
      } else {
        const created = await this.deps.createWorkstream(
          suggestion.name,
          suggestion.description,
        );
        workstream = { id: created.sectionId, name: created.name };
        pendingNew = null;
        acceptedSectionId = created.sectionId;
      }

      let identity = this.state.identity;
      if (this.state.identity?.provenance !== "manual") {
        if (this.state.decision?.subjectId) {
          identity = {
            entityId: this.state.decision.subjectId,
            proposal: null,
            label: this.state.decision.subject ?? this.state.decision.subjectId,
            provenance: "automatic",
          };
        } else if (this.state.decision?.proposal) {
          identity = {
            entityId: null,
            proposal: this.state.decision.proposal,
            label:
              this.state.decision.subject ?? this.state.decision.proposal.name,
            provenance: "automatic",
          };
        }
      }

      this.set({
        workstream,
        pendingNew,
        identity,
        pinned: true,
        acceptedRoute: {
          routeId: suggestion.key,
          sectionId: workstream?.id,
          subjectId: this.state.decision?.subjectId ?? undefined,
        },
      });
      let requested: ComposerSelection | null = null;
      let applied: ComposerSelection | null = null;
      if (suggestion.placement) {
        const appliedPlacement = await this.applyPlacement(
          suggestion.placement,
        );
        requested = appliedPlacement.requested;
        applied = appliedPlacement.applied;
      }
      finish("ok", {
        output: {
          workstream,
          selection: suggestion.placement
            ? { requested, applied }
            : "No placement; the project and environment were left alone.",
          submitted: submit,
        },
      });
      if (submit) {
        await afterHostCommit();
        if (this.nativeFlow && this.deps.submitWithRoute) {
          await this.deps.submitWithRoute(
            suggestion.key,
            acceptedSectionId ?? workstream?.id,
          );
          this.set({ settled: suggestion.key });
        } else {
          await composer.submit({ experimental_data: null });
        }
      } else {
        // The suggestion disappears; typing carries on in the draft.
        composer.focus();
      }
    } catch (error) {
      finish("failed", { error });
      // A failed submit has already been reported by `submit`'s caller.
      if (this.state.error === null) this.reportError(error);
    } finally {
      // The composer has called `submit` by the time its own submit settles;
      // a target it never consumed must not redirect a later Enter.
      this.sendTarget = null;
      this.set({ accepting: false });
    }
  }

  /** Acts on a composer submit: the accepted thread, or a new thread. */
  async submit(request: NewThreadRequest): Promise<SubmitResult> {
    if (this.state.error) this.set({ error: null });
    const target = this.sendTarget;
    this.sendTarget = null;
    this.invalidate();

    let sectionId = this.state.workstream?.id ?? null;
    const newWorkstream =
      !target && !sectionId && this.state.pendingNew
        ? {
            name: this.state.pendingNew.name,
            description: this.state.pendingNew.description,
          }
        : null;

    const identityPayload = this.state.identity
      ? {
          entityId: this.state.identity.entityId,
          proposal: this.state.identity.proposal,
          provenance: this.state.identity.provenance,
        }
      : null;

    const finish = this.begin(
      "submit",
      target
        ? { sendTo: target.threadId, request }
        : {
            startIn: sectionId,
            identity: identityPayload,
            request,
          },
    );
    try {
      if (target) {
        await this.deps.sendToThread(
          target.threadId,
          request.input,
          target.traceId,
        );
        finish("ok", { output: { sentTo: target.threadId } });
        return {
          kind: "sent",
          threadId: target.threadId,
          title: target.title,
        };
      }
      const options = {
        ...(identityPayload ? { identity: identityPayload } : {}),
        ...(newWorkstream ? { newWorkstream } : {}),
      };
      const { threadId } =
        Object.keys(options).length > 0
          ? await this.deps.startThread(sectionId, request, options)
          : await this.deps.startThread(sectionId, request);

      if (this.state.pendingNew) {
        this.set({ pendingNew: null });
      }

      finish("ok", { output: { started: threadId, sectionId } });
      return { kind: "started", threadId };
    } catch (error) {
      finish("failed", { error });
      throw error;
    }
  }

  /**
   * Creates the proposed workstream, as submitting does. The native flow
   * calls this before handing the section to the host composer's submit;
   * the field keeps showing the created name.
   */
  async createPending(): Promise<string> {
    const pending = this.state.pendingNew;
    if (!pending) return this.state.workstream?.id ?? "";
    const created = await this.deps.createWorkstream(
      pending.name,
      pending.description,
    );
    const accepted = this.state.acceptedRoute;
    this.set({
      workstream: { id: created.sectionId, name: created.name },
      pendingNew: null,
      acceptedRoute: accepted
        ? { ...accepted, sectionId: created.sectionId }
        : { sectionId: created.sectionId, routeId: "" },
    });
    return created.sectionId;
  }

  /** Submits through the embedded composer, as plain Enter does; the dialog's
   *  ⌘⏎ shortcut uses it when an automatic destination already stands in the
   *  pickers, so the alternate send keeps working there. */
  async submitComposer(): Promise<void> {
    await this.composer?.submit({ experimental_data: null });
  }

  /**
   * Applies a placement's project and environment through the composer,
   * keeping the model's own change from counting as a user override. Returns
   * the requested and applied selections for Debug mode's record.
   */
  private async applyPlacement(placement: Placement): Promise<{
    requested: ComposerSelection;
    applied: ComposerSelection | null;
  }> {
    const composer = this.composer;
    const { projectId, environment } = placement;
    const {
      projectId: _projectId,
      environment: _environment,
      ...execution
    } = composer?.selection ?? {};
    const requested: ComposerSelection = {
      ...execution,
      projectId,
      ...(environment.type === "project-default" ? {} : { environment }),
    };
    if (!composer) return { requested, applied: null };
    this.applying++;
    try {
      const applied = await composer.setSelection(requested);
      this.lastAppliedSignature = placementSignature(applied);
      this.observeSelection(applied);
      return { requested, applied };
    } finally {
      this.applying--;
    }
  }

  /**
   * Moves the Automatic pickers to the home the classification named: an
   * existing workstream, or a proposal submitting would create. A placement
   * applies with its workstream, so the pair the pickers show stays together;
   * when it can't be applied the pickers stay as they were and the suggestion
   * row keeps offering the home for a manual acceptance. A classification
   * that names no workstream withdraws the previous automatic destination.
   */
  private async autoApply(
    suggestion: Suggestion | null,
    mine = this.generation,
  ) {
    if (this.state.pinned) return;
    if (!suggestion || suggestion.kind === "thread") {
      if (this.state.workstream || this.state.pendingNew)
        this.set({ ...this.withdrawn(), acceptedRoute: null });
      return;
    }
    if (suggestion.kind === "workstream") {
      const unchanged =
        this.state.workstream?.id === suggestion.sectionId &&
        (!suggestion.placement ||
          placementSignature(this.state.selection) ===
            placementSignature({
              projectId: suggestion.placement.projectId,
              environment:
                suggestion.placement.environment.type === "project-default"
                  ? null
                  : suggestion.placement.environment,
            }));
      if (!unchanged) {
        if (suggestion.placement) {
          try {
            await this.applyPlacement(suggestion.placement);
          } catch (error) {
            if (mine === this.generation)
              this.begin("apply", suggestion)("failed", { error });
            return;
          }
          if (mine !== this.generation) return;
        }
        this.set({
          workstream: { id: suggestion.sectionId, name: suggestion.name },
          pendingNew: null,
          acceptedRoute: {
            routeId: suggestion.key,
            sectionId: suggestion.sectionId,
            subjectId: this.state.decision?.subjectId ?? undefined,
          },
        });
        this.begin("apply", suggestion)("ok", {
          output: this.state.workstream,
        });
      } else {
        // Same home again: keep the pickers untouched, refresh the trace link.
        this.set({
          acceptedRoute: {
            routeId: suggestion.key,
            sectionId: suggestion.sectionId,
            subjectId: this.state.decision?.subjectId ?? undefined,
          },
        });
      }
      return;
    }
    // A proposed new workstream: show it, create only on submit.
    const unchanged =
      this.state.pendingNew?.name === suggestion.name &&
      this.state.pendingNew?.description === suggestion.description;
    if (!unchanged) {
      if (suggestion.placement) {
        try {
          await this.applyPlacement(suggestion.placement);
        } catch (error) {
          if (mine === this.generation)
            this.begin("apply", suggestion)("failed", { error });
          return;
        }
        if (mine !== this.generation) return;
      }
      this.set({
        workstream: null,
        pendingNew: {
          name: suggestion.name,
          description: suggestion.description,
          subjectId: this.state.decision?.subjectId ?? undefined,
        },
        acceptedRoute: {
          routeId: suggestion.key,
          subjectId: this.state.decision?.subjectId ?? undefined,
        },
      });
      this.begin("apply", suggestion)("ok", {
        output: this.state.pendingNew,
      });
    }
  }

  dispose() {
    this.invalidate();
  }

  private invalidate() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.generation++;
    if (this.pending) this.deps.cancelRoute();
    this.pending = false;
  }

  private schedule() {
    this.invalidate();
    const text = this.state.text;
    if (!text) {
      if (this.state.classifying) this.set({ classifying: false });
      return;
    }
    this.timer = setTimeout(() => void this.classify(), routeDelay(text));
  }

  private async classify() {
    this.timer = null;
    const mine = ++this.generation;
    this.pending = true;
    this.set({ classifying: true });
    const prompt = this.state.text;
    const workstream = this.state.workstream;
    const pickedProjectId = this.state.selection?.projectId ?? null;
    const finish = this.begin(
      "classify",
      this.nativeFlow
        ? { prompt, workstream, pickedProjectId }
        : { prompt, workstream },
    );
    try {
      const decision = this.nativeFlow
        ? await this.deps.route(prompt, workstream?.id ?? null, pickedProjectId)
        : await this.deps.route(prompt, workstream?.id ?? null);
      if (mine !== this.generation) {
        finish("superseded", { output: decision });
        return;
      }
      const suggestion = suggestionFrom(decision);
      finish("ok", { output: { decision, suggestion } });

      let nextIdentity = this.state.identity;
      if (this.state.identity?.provenance !== "manual") {
        if (decision.subjectId) {
          nextIdentity = {
            entityId: decision.subjectId,
            proposal: null,
            label: decision.subject ?? decision.subjectId,
            provenance: "automatic",
          };
        } else if (decision.proposal) {
          nextIdentity = {
            entityId: null,
            proposal: decision.proposal,
            label: decision.subject ?? decision.proposal.name,
            provenance: "automatic",
          };
        } else {
          nextIdentity = null;
        }
      }

      this.set({ decision, suggestion, identity: nextIdentity });
      // A dismissed suggestion names no destination; an already-applied one
      // keeps the pickers it filled (autoApply is idempotent for it).
      await this.autoApply(
        suggestion && suggestion.key === this.state.settled ? null : suggestion,
        mine,
      );
    } catch (error) {
      finish(mine === this.generation ? "failed" : "superseded", { error });
      // A suggestion is optional; the draft and its pickers work without one.
      if (mine === this.generation)
        console.warn("Workstreams couldn't suggest a home:", error);
    } finally {
      if (mine === this.generation) {
        this.pending = false;
        this.set({ classifying: false });
      }
    }
  }
}

/**
 * BB binds its submit to the composer's last committed render, so a submit
 * right after `setSelection` lets the new picker values commit first.
 */
const afterHostCommit = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export const NewWorkContext = createContext<NewWork | null>(null);
