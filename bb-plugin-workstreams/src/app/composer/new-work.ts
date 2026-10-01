/**
 * New work's state outside React: the workstream the next thread is filed in,
 * the classification that runs while the user pauses typing, and accepting
 * its suggestion.
 *
 * BB's composer owns the draft, project, environment and execution settings,
 * exactly as in its own New thread view. Workstreams adds one field, the
 * workstream, and one optional shortcut: a suggested home the user can accept.
 * Ignoring the suggestion changes nothing, so Enter always starts the thread
 * the pickers show.
 */
import { createContext } from "react";
import type {
  ComposerSelection,
  NewThreadRequest,
  PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import type { Placement, RouteDecision } from "../../server/router.ts";
import { routeDelay } from "./timing.ts";

export type WorkstreamChoice = { id: string; name: string } | null;

type SuggestionBase = {
  /** Identifies one classification result, so accepting or dismissing it sticks. */
  key: string;
  reason: string;
  traceId: string | null;
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
  const base = {
    key: decision.id,
    reason: decision.reason,
    traceId: decision.traceId,
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
 * One thing the dialog did, for Debug mode: a classification of the draft,
 * accepting or dismissing a suggestion, picking or creating a workstream, or
 * a submit. Each records its inputs and its result or error.
 */
export type NewWorkEvent = {
  id: number;
  at: number;
  kind:
    | "classify"
    | "accept"
    | "dismiss"
    | "select-workstream"
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
  /** Why the last submit or acceptance failed. */
  error: string | null;
  /** Counts failures, so a repeated message is announced again. */
  errors: number;
  /** What the dialog did, oldest first, for Debug mode. */
  events: readonly NewWorkEvent[];
};

export type NewWorkDeps = {
  /** Classifies `prompt` for a suggestion. A newer call supersedes it. */
  route(prompt: string): Promise<RouteDecision>;
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
  ): Promise<{ threadId: string }>;
  sendToThread(
    threadId: string,
    input: NewThreadRequest["input"],
    traceId: string | null,
  ): Promise<void>;
};

export type SubmitResult =
  | { kind: "started"; threadId: string }
  | { kind: "sent"; threadId: string; title: string };

/**
 * Whether the pickers already say what a workstream suggestion would set.
 * The environment isn't compared: BB reports a resolved environment in its
 * own shape, and the workstream and project are what the suggestion is about.
 */
function alreadyApplied(suggestion: Suggestion, state: NewWorkState): boolean {
  if (suggestion.kind !== "workstream") return false;
  if (state.workstream?.id !== suggestion.sectionId) return false;
  return (
    !suggestion.placement ||
    state.selection?.projectId === suggestion.placement.projectId
  );
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

  constructor(
    private deps: NewWorkDeps,
    workstream: WorkstreamChoice = null,
  ) {
    this.state = {
      text: "",
      workstream,
      selection: null,
      suggestion: null,
      decision: null,
      classifying: false,
      settled: null,
      accepting: false,
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
      error: null,
      ...(trimmed ? {} : { suggestion: null, decision: null }),
    });
    this.schedule();
  }

  observeSelection(selection: ComposerSelection | null) {
    if (selection !== this.state.selection) this.set({ selection });
  }

  selectWorkstream(choice: WorkstreamChoice) {
    this.begin("select-workstream", {
      from: this.state.workstream,
      to: choice,
    })("ok");
    this.set({ workstream: choice, error: null });
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
        this.sendTarget = suggestion;
        await composer.submit({ experimental_data: null });
        finish("ok", { output: "Submitted the draft to the thread." });
        return;
      }
      const workstream =
        suggestion.kind === "workstream"
          ? { id: suggestion.sectionId, name: suggestion.name }
          : await this.deps
              .createWorkstream(suggestion.name, suggestion.description)
              .then(({ sectionId, name }) => ({ id: sectionId, name }));
      this.set({ workstream, settled: suggestion.key });
      let requested: ComposerSelection | null = null;
      let applied: ComposerSelection | null = null;
      if (suggestion.placement) {
        const { projectId, environment } = suggestion.placement;
        requested = {
          projectId,
          ...(environment.type === "project-default" ? {} : { environment }),
        };
        applied = await composer.setSelection(requested);
        this.observeSelection(applied);
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
        await composer.submit({ experimental_data: null });
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
    const sectionId = this.state.workstream?.id ?? null;
    const finish = this.begin(
      "submit",
      target
        ? { sendTo: target.threadId, request }
        : { startIn: sectionId, request },
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
      const { threadId } = await this.deps.startThread(sectionId, request);
      finish("ok", { output: { started: threadId, sectionId } });
      return { kind: "started", threadId };
    } catch (error) {
      finish("failed", { error });
      throw error;
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
    const finish = this.begin("classify", { prompt });
    try {
      const decision = await this.deps.route(prompt);
      if (mine !== this.generation) {
        finish("superseded", { output: decision });
        return;
      }
      const suggestion = suggestionFrom(decision);
      finish("ok", { output: { decision, suggestion } });
      this.set({ decision, suggestion });
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
