/**
 * New work's state: Product/Feature identity and automatic suggestions.
 * Workstreams are always derived automatically from active task identities;
 * New work never solicits or sets a destination workstream.
 */
import { createContext } from "react";
import type {
  ComposerSelection,
  NewThreadRequest,
  PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import type { RouteDecision } from "../../server/router.ts";
import type { DraftSubjectProposal } from "../../domain/corpus.ts";
import { routeDelay } from "./timing.ts";

export type IdentityChoice = {
  entityId: string | null;
  proposal: DraftSubjectProposal | null;
  label: string;
  provenance: "manual" | "automatic";
} | null;

type SuggestionBase = {
  key: string;
  reason: string;
  traceId: string | null;
  identity?: {
    entityId?: string | null;
    proposal?: DraftSubjectProposal | null;
    label: string;
  } | null;
};

/** Suggestions for explicit thread continuation. */
export type Suggestion = SuggestionBase & {
  kind: "thread";
  threadId: string;
  title: string;
  workstream: string | null;
};

/** Suggestion from a route decision (thread continuation only). */
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
  if (decision.outcome === "continue") {
    return {
      ...base,
      kind: "thread",
      threadId: decision.threadId,
      title: decision.threadTitle,
      workstream: decision.workstream,
    };
  }
  return null;
}

export type NewWorkEvent = {
  id: number;
  at: number;
  kind:
    | "classify"
    | "accept"
    | "dismiss"
    | "select-identity"
    | "submit";
  status: "pending" | "ok" | "failed" | "superseded";
  durationMs: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
};

const EVENT_LIMIT = 100;

export type NewWorkState = {
  text: string;
  identity: IdentityChoice;
  selection: ComposerSelection | null;
  suggestion: Suggestion | null;
  decision: RouteDecision | null;
  classifying: boolean;
  settled: string | null;
  accepting: boolean;
  error: string | null;
  errors: number;
  events: readonly NewWorkEvent[];
};

export type NewWorkDeps = {
  route(
    prompt: string,
    workstreamId: string | null,
    pickedProjectId?: string | null,
  ): Promise<RouteDecision>;
  cancelRoute(): void;
  startThread(
    request: NewThreadRequest,
    options?: {
      identity?: {
        entityId?: string | null;
        proposal?: DraftSubjectProposal | null;
        provenance?: "manual" | "automatic";
      } | null;
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
  text: string;
} {
  const ident = state.identity ? state.identity.label : "Unresolved";
  return {
    identityLabel: ident,
    text: `Concerning ${ident}`,
  };
}

/** Legacy stub: destination selection is removed. */
export function hasDestination(_state: NewWorkState): boolean {
  return false;
}

export function suggestionVisibility(state: NewWorkState): string {
  const { suggestion } = state;
  if (!state.text) return "Hidden: the draft is empty.";
  if (!suggestion)
    return state.classifying
      ? "Waiting for the first classification."
      : state.decision
        ? "None: the router named no continuation thread."
        : "None yet: classification runs once typing pauses.";
  if (suggestion.key === state.settled)
    return "Hidden: you accepted or dismissed it.";
  return state.classifying
    ? "Shown, while newer text is being classified."
    : "Shown.";
}

export function shownSuggestion(state: NewWorkState): Suggestion | null {
  const { suggestion } = state;
  if (!state.text || !suggestion || suggestion.key === state.settled)
    return null;
  return suggestion;
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
  private sendTarget: Suggestion | null = null;
  private eventIds = 0;

  constructor(
    private deps: NewWorkDeps,
    initialIdentity: IdentityChoice = null,
    private nativeFlow = false,
  ) {
    this.state = {
      text: "",
      identity: initialIdentity,
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

  attach(composer: PluginComposerApi) {
    this.composer = composer;
  }

  observe(text: string) {
    const trimmed = text.trim();
    if (trimmed === this.state.text) return;
    this.set({
      text: trimmed,
      error: null,
      ...(trimmed
        ? {}
        : {
            suggestion: null,
            decision: null,
            identity:
              this.state.identity?.provenance === "manual"
                ? this.state.identity
                : null,
          }),
    });
    this.schedule();
  }

  observeSelection(selection: ComposerSelection | null) {
    if (selection === this.state.selection) return;
    this.set({ selection });
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

  reportError(error: unknown) {
    this.set({ error: messageOf(error), errors: this.state.errors + 1 });
  }

  dismiss() {
    const suggestion = shownSuggestion(this.state);
    if (!suggestion) return;
    this.begin("dismiss", { suggestion })("ok");
    this.set({ settled: suggestion.key, error: null });
  }

  async accept({ submit }: { submit: boolean }): Promise<void> {
    const suggestion = shownSuggestion(this.state);
    const composer = this.composer;
    if (!suggestion || !composer || this.state.accepting) return;
    this.set({ accepting: true, error: null });
    const finish = this.begin("accept", { suggestion, submit });
    try {
      if (this.deps.sendDraftToThread) {
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
    } catch (error) {
      finish("failed", { error });
      if (this.state.error === null) this.reportError(error);
    } finally {
      this.sendTarget = null;
      this.set({ accepting: false });
    }
  }

  async submit(request: NewThreadRequest): Promise<SubmitResult> {
    if (this.state.error) this.set({ error: null });
    const target = this.sendTarget;
    this.sendTarget = null;
    this.invalidate();

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
      const options = identityPayload ? { identity: identityPayload } : {};
      const { threadId } = await this.deps.startThread(request, options);

      finish("ok", { output: { started: threadId } });
      return { kind: "started", threadId };
    } catch (error) {
      finish("failed", { error });
      throw error;
    }
  }

  async submitComposer(): Promise<void> {
    await this.composer?.submit({ experimental_data: null });
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
    const pickedProjectId = this.state.selection?.projectId ?? null;
    const finish = this.begin(
      "classify",
      this.nativeFlow
        ? { prompt, pickedProjectId }
        : { prompt },
    );
    try {
      const decision = this.nativeFlow
        ? await this.deps.route(prompt, null, pickedProjectId)
        : await this.deps.route(prompt, null);
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
    } catch (error) {
      finish(mine === this.generation ? "failed" : "superseded", { error });
      if (mine === this.generation)
        console.warn("Workstreams couldn't classify draft:", error);
    } finally {
      if (mine === this.generation) {
        this.pending = false;
        this.set({ classifying: false });
      }
    }
  }
}

export const NewWorkContext = createContext<NewWork | null>(null);
