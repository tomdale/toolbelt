/**
 * The New thread composer's state: the new thread's topic, and Quick
 * analysis's preview of it while you type. The topic decides the workstream,
 * so the composer never asks for one.
 */
import { createContext } from "react";
import type { ComposerSelection } from "@get-bb/plugin-sdk/app";
import type { Preview } from "../../server/preview.ts";
import type { DraftSubjectProposal } from "../../domain/topics.ts";
import { routeDelay } from "./timing.ts";

/**
 * The topic the field shows: one you picked, Quick analysis's preview
 * (`automatic`), or the topic of the workstream whose ＋ opened the composer
 * (`inherited`, by `sectionId`). Previews never replace a picked or
 * inherited topic.
 */
export type IdentityChoice = {
  entityId: string | null;
  proposal: DraftSubjectProposal | null;
  label: string;
  provenance: "manual" | "automatic" | "inherited";
  sectionId?: string | null;
} | null;

export type NewWorkEvent = {
  id: number;
  at: number;
  kind: "classify" | "select-identity";
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
  /** Quick analysis's latest preview of the draft. */
  decision: Preview | null;
  classifying: boolean;
  error: string | null;
  errors: number;
  events: readonly NewWorkEvent[];
};

export type NewWorkDeps = {
  route(prompt: string, pickedProjectId: string | null): Promise<Preview>;
  cancelRoute(): void;
};

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
  topicLabel: string;
  text: string;
} {
  const ident = state.identity ? state.identity.label : "No topic";
  return {
    topicLabel: ident,
    text: `Concerning ${ident}`,
  };
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class NewWork {
  private state: NewWorkState;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private pending = false;
  private eventIds = 0;

  constructor(private deps: NewWorkDeps) {
    this.state = {
      text: "",
      identity: null,
      selection: null,
      decision: null,
      classifying: false,
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

  observe(text: string) {
    const trimmed = text.trim();
    if (trimmed === this.state.text) return;
    this.set({
      text: trimmed,
      error: null,
      ...(trimmed
        ? {}
        : {
            decision: null,
            identity:
              this.state.identity?.provenance === "automatic"
                ? null
                : this.state.identity,
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
            choice.label ?? (choice.entityId ? choice.entityId : "No topic"),
          provenance,
        }
      : {
          entityId: null,
          proposal: null,
          label: "No topic",
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

  /** Starts the thread with the topic of the workstream whose ＋ opened it. */
  selectWorkstream(sectionId: string, label: string) {
    this.begin("select-identity", {
      from: this.state.identity,
      to: { sectionId, label },
      provenance: "inherited",
    })("ok");
    this.set({
      identity: {
        entityId: null,
        proposal: null,
        label,
        provenance: "inherited",
        sectionId,
      },
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
    const finish = this.begin("classify", { prompt, pickedProjectId });
    try {
      const decision = await this.deps.route(prompt, pickedProjectId);
      if (mine !== this.generation) {
        finish("superseded", { output: decision });
        return;
      }
      finish("ok", { output: { decision } });

      // A picked or inherited topic stays when a preview arrives.
      let nextIdentity = this.state.identity;
      if (
        !this.state.identity ||
        this.state.identity.provenance === "automatic"
      ) {
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

      this.set({ decision, identity: nextIdentity });
    } catch (error) {
      finish(mine === this.generation ? "failed" : "superseded", { error });
      if (mine === this.generation)
        console.warn("Workstreams couldn't preview the draft:", error);
    } finally {
      if (mine === this.generation) {
        this.pending = false;
        this.set({ classifying: false });
      }
    }
  }
}

export const NewWorkContext = createContext<NewWork | null>(null);
