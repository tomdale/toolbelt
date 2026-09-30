import { createContext } from "react";
import type { Placement, RouteDecision } from "../../server/router.ts";
import { routeDelay } from "./timing.ts";

type RouteOptions = {
  prompt: string;
  workstreamId: string | null;
  pickedProjectId: string | null;
  /** The unsure decision the workstream was picked from (its trace carries over). */
  fromDecisionId?: string;
};
export type IntakeState = {
  text: string;
  decision: RouteDecision | null;
  loading: boolean;
  error: string | null;
  workstreamId: string | null;
  workstreamName: string | null;
  pickedProjectId: string | null;
  choice: { threadId: string } | null;
  /** Whether the host's project, environment, and permission row is shown. */
  settings: boolean;
};

let sessions = 0;

/** One composer owns one session; project changes may remount its banner. */
export class Intake {
  /** Lets the banner's select reference the dialog's stable live region. */
  readonly statusId = `ws-intake-status-${++sessions}`;
  /** The banner control to refocus after the host remounts the banner. */
  focused: "workstream" | "settings" | null = null;
  private state: IntakeState;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private pending: Promise<RouteDecision | null> | null = null;
  private lastProject: string | null | undefined;
  private selectionKey: string | null = null;
  customizePlacement = false;
  private preset: string | null = null;
  private submitting = false;
  private fromDecisionId: string | null = null;

  constructor(
    private route: (options: RouteOptions) => Promise<RouteDecision>,
    workstreamId: string | null,
    workstreamName: string | null,
    /** Aborts the routing call in flight on the server; its answer is stale. */
    private cancel: () => void = () => {},
  ) {
    this.state = {
      text: "",
      decision: null,
      loading: false,
      error: null,
      workstreamId,
      workstreamName,
      pickedProjectId: null,
      choice: null,
      settings: false,
    };
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<IntakeState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.generation++;
    if (this.pending) this.cancel();
    this.pending = null;
  }
  presetProject(projectId: string) {
    this.preset = projectId;
  }
  shouldPreset(decisionId: string, placement: Placement) {
    const key = JSON.stringify([placement.projectId, placement.environment]);
    if (this.state.decision?.id !== decisionId || this.selectionKey === key)
      return false;
    this.selectionKey = key;
    this.presetProject(placement.projectId);
    return true;
  }
  retry() {
    this.schedule(this.state.text);
  }
  /** Once the user has seen the placement row, their project picks count. */
  toggleSettings() {
    this.customizePlacement = true;
    this.set({ settings: !this.state.settings });
  }

  observe(text: string, projectId: string | null) {
    // BB clears the editor before awaiting onSubmit and restores it on
    // rejection. That temporary empty draft must not cancel its route.
    if (this.submitting && !text.trim()) return;
    const picked =
      this.customizePlacement &&
      this.lastProject !== undefined &&
      projectId !== this.lastProject &&
      projectId !== this.preset
        ? projectId
        : this.state.pickedProjectId;
    this.lastProject = projectId;
    if (
      text.trim() === this.state.text &&
      picked === this.state.pickedProjectId &&
      (!this.state.loading || this.pending !== null || this.timer !== null)
    )
      return;
    this.set({ pickedProjectId: picked });
    this.schedule(text);
  }
  /** `fromDecisionId`: the unsure decision whose candidate this is. */
  selectWorkstream(
    id: string | null,
    name: string | null,
    fromDecisionId: string | null = null,
  ) {
    this.fromDecisionId = fromDecisionId;
    this.set({ workstreamId: id, workstreamName: name, choice: null });
    this.schedule(this.state.text);
  }
  selectThread(threadId: string) {
    this.set({ choice: { threadId }, error: null });
  }
  private fail(message: string): never {
    this.set({ error: message });
    throw new Error(message);
  }

  private schedule(text: string) {
    this.dispose();
    this.set({
      text: text.trim(),
      decision: null,
      choice: null,
      error: null,
      loading: !!text.trim(),
    });
    if (!text.trim()) return;
    this.timer = setTimeout(
      () => {
        void this.resolve();
      },
      this.state.workstreamId ? 0 : routeDelay(text),
    );
  }

  async resolve(): Promise<RouteDecision | null> {
    if (this.pending) return this.pending;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const mine = ++this.generation;
    const { text, workstreamId, pickedProjectId } = this.state;
    if (!text) this.fail("Describe the work first.");
    this.set({ loading: true, error: null });
    this.pending = this.route({
      prompt: text,
      workstreamId,
      pickedProjectId,
      // RPC input must be JSON: omit rather than send undefined.
      ...(this.fromDecisionId ? { fromDecisionId: this.fromDecisionId } : {}),
    }).then(
      (decision) => {
        if (mine !== this.generation) return null;
        this.pending = null;
        this.set({ decision, loading: false });
        return decision;
      },
      (error: unknown) => {
        if (mine !== this.generation) return null;
        this.pending = null;
        this.set({
          decision: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      },
    );
    return this.pending;
  }

  async forSubmit(text: string) {
    this.submitting = true;
    try {
      return await this.prepareSubmit(text);
    } finally {
      this.submitting = false;
    }
  }

  private async prepareSubmit(text: string) {
    if (text.trim() !== this.state.text) this.schedule(text);
    let decision = this.state.decision;
    if (!decision) {
      decision = await this.resolve();
      if (!decision)
        this.fail(
          this.state.error ??
            "The draft changed. Review the destination before sending.",
        );
      // An explicit workstream is already previewed before the user types.
      if (!this.state.workstreamId)
        this.fail("Review the destination, then send.");
    }
    if (decision.outcome === "unsure" && !this.state.choice)
      this.fail("Choose where this work goes.");
    return { decision, choice: this.state.choice };
  }
}

export const IntakeContext = createContext<Intake | null>(null);
