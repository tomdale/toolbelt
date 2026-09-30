import { createContext } from "react";
import type {
  ComposerSelection,
  NewThreadRequest,
  PluginBrowserBbSdk,
} from "@get-bb/plugin-sdk/app";
import type { RouteDecision, RouteIntent } from "../../server/router.ts";
import { routeDelay } from "./timing.ts";
export type Environment = NonNullable<NewThreadRequest["environment"]>;
export type IntakeAction =
  "automatic" | "new-thread" | "send-message" | "new-workstream";
export type IntakeDestination =
  | { kind: "automatic" }
  | { kind: "workstream"; id: string; name: string }
  | { kind: "thread"; id: string; title: string }
  | { kind: "unassigned" };
type Field<T> = { value: T; source: "automatic" | "manual" };
const auto = <T>(value: T): Field<T> => ({ value, source: "automatic" });
const manual = <T>(value: T): Field<T> => ({ value, source: "manual" });
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]),
    )
  );
}
function environmentAcknowledged(
  requested: Environment | undefined,
  applied: Environment | undefined,
): boolean {
  if (sameJson(requested, applied)) return true;
  if (requested?.type !== "host" || !applied) return false;
  const workspace = requested.workspace;
  let equivalent: Environment = requested;
  if (applied.type === "provider") {
    if (!requested.hostId) return false;
    equivalent = {
      type: "provider",
      environmentProviderId:
        workspace.type === "managed-worktree"
          ? "git-worktree"
          : workspace.type === "unmanaged"
            ? "project-checkout"
            : "personal-workspace",
      machine: { type: "existing", hostId: requested.hostId },
      inputs:
        workspace.type === "managed-worktree"
          ? { branch: workspace.baseBranch }
          : workspace.type === "unmanaged"
            ? {
                ...(workspace.path === null ? {} : { path: workspace.path }),
                ...(workspace.branch ? { branch: workspace.branch } : {}),
              }
            : null,
    };
  }
  // The host represents workspace sugar as a provider and may resolve a
  // configured default worktree base to its name. Keep the requested args
  // unchanged so the preview intent and execution payload still agree.
  if (
    workspace.type === "managed-worktree" &&
    workspace.baseBranch.kind === "default"
  ) {
    if (
      applied.type === "host" &&
      applied.workspace.type === "managed-worktree" &&
      applied.workspace.baseBranch.kind === "named" &&
      applied.workspace.baseBranch.name
    )
      return sameJson(requested, {
        ...applied,
        workspace: { ...applied.workspace, baseBranch: { kind: "default" } },
      });
    if (applied.type === "provider" && equivalent.type === "provider") {
      const inputs = applied.inputs;
      const branch =
        inputs && typeof inputs === "object" && !Array.isArray(inputs)
          ? inputs.branch
          : null;
      if (
        branch &&
        typeof branch === "object" &&
        !Array.isArray(branch) &&
        branch.kind === "named" &&
        typeof branch.name === "string" &&
        branch.name &&
        Object.keys(branch).length === 2
      )
        equivalent = { ...equivalent, inputs: { branch } };
    }
  }
  return sameJson(equivalent, applied);
}
export type CatalogThread = {
  id: string;
  title: string;
  sectionId: string | null;
  projectId: string;
  environmentId: string | null;
  environmentName: string | null;
};
export type CatalogEnvironment = { id: string; name: string | null };
export type IntakeState = {
  text: string;
  action: Field<IntakeAction>;
  destination: Field<IntakeDestination>;
  project: Field<string | null>;
  environment: Field<Environment | null>;
  name: Field<string>;
  decision: RouteDecision | null;
  loading: boolean;
  error: string | null;
  selectionError: string | null;
  announcement: string;
  projects: readonly {
    id: string;
    name: string;
    hostId: string | null;
    hostIds: string[];
  }[];
  environments: readonly CatalogEnvironment[];
  threads: readonly CatalogThread[];
  catalogError: string | null;
  hostId: string | null;
  threadExecution: Record<string, ComposerSelection>;
  synchronizedThread: string | null;
  synchronizedPlacement: string | null;
  selectionRevision: number;
  redirectPending: boolean;
};
let sessions = 0;
/** The dialog owns selections and catalogs because the host remounts banners on project changes. */
export class Intake {
  readonly statusId = `ws-intake-status-${++sessions}`;
  focused: string | null = null;
  private state: IntakeState;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private pending: Promise<RouteDecision | null> | null = null;
  private catalogGeneration = 0;
  private environmentGeneration = 0;
  private catalogs: Promise<void> | null = null;
  private threadRequests = new Map<string, Promise<void>>();
  private autoProject: string | null = null;
  private autoEnvironment: Environment | null = null;
  private autoEnvironmentLabel = "";
  private autoDestination: IntakeDestination = { kind: "automatic" };
  private autoAction: IntakeAction = "automatic";
  private autoName = "";
  private submitting = false;
  private selectionKey = "";
  private selectionThread: string | null = null;
  private selectionGeneration = 0;
  private selectionRequests = new WeakMap<ComposerSelection, number>();
  private routingRevision = 0;
  private redirectRevision: number | null = null;
  private decisionIntent: RouteIntent = {};
  constructor(
    private route: (options: {
      prompt: string;
      intent: RouteIntent;
    }) => Promise<RouteDecision>,
    workstreamId: string | null,
    workstreamName: string | null,
    private cancel: () => void = () => {},
  ) {
    this.state = {
      text: "",
      action: auto("automatic"),
      destination: workstreamId
        ? manual({
            kind: "workstream",
            id: workstreamId,
            name: workstreamName ?? workstreamId,
          })
        : auto({ kind: "automatic" }),
      project: auto(null),
      environment: auto(null),
      name: auto(""),
      decision: null,
      loading: false,
      error: null,
      selectionError: null,
      announcement: "",
      projects: [],
      environments: [],
      threads: [],
      catalogError: null,
      hostId: null,
      threadExecution: {},
      synchronizedThread: null,
      synchronizedPlacement: null,
      selectionRevision: 0,
      redirectPending: false,
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
  private invalidate() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.generation++;
    if (this.pending) this.cancel();
    this.pending = null;
  }
  dispose() {
    this.invalidate();
    this.catalogGeneration++;
    this.environmentGeneration++;
  }
  async loadCatalogs(sdk: PluginBrowserBbSdk) {
    if (this.catalogs) return this.catalogs;
    const mine = ++this.catalogGeneration;
    this.catalogs = Promise.all([
      sdk.projects.list({ includePersonal: true }),
      sdk.threads.list({ limit: 500 }),
      sdk.system.config(),
    ])
      .then(([projects, result, config]) => {
        if (mine !== this.catalogGeneration) return;
        this.set({
          projects: projects.map(({ id, name, sources }) => ({
            id,
            name,
            hostIds: sources?.map((s) => s.hostId) ?? [],
            hostId:
              sources?.find((s) => s.isDefault)?.hostId ??
              sources?.[0]?.hostId ??
              config.primaryHostId,
          })),
          threads: [
            ...result.map((t) => ({
              id: t.id,
              title: t.title ?? t.titleFallback ?? t.id,
              sectionId: t.sectionId,
              projectId: t.projectId,
              environmentId: t.environmentId,
              environmentName: t.environmentName,
            })),
            ...this.state.threads.filter(
              (t) => !result.some((r) => r.id === t.id),
            ),
          ],
          catalogError: null,
          hostId: config.primaryHostId,
        });
      })
      .catch((error) => {
        if (mine === this.catalogGeneration) {
          this.catalogs = null;
          this.set({ catalogError: String(error) });
        }
      });
    return this.catalogs;
  }
  async loadEnvironments(sdk: PluginBrowserBbSdk, projectId: string | null) {
    const mine = ++this.environmentGeneration;
    this.set({ environments: [] });
    if (!projectId) return;
    try {
      const environments = await sdk.environments.list({
        projectId,
        status: "ready",
      });
      if (
        mine !== this.environmentGeneration ||
        projectId !== this.state.project.value
      )
        return;
      this.set({ environments });
      const env = this.state.environment.value;
      const sourceHosts =
        this.state.projects.find((p) => p.id === projectId)?.hostIds ?? [];
      const invalidReuse =
        env?.type === "reuse" &&
        !environments.some((e) => e.id === env.environmentId);
      const invalidHost =
        env?.type === "host" &&
        env.hostId &&
        sourceHosts.length > 0 &&
        !sourceHosts.includes(env.hostId);
      if (
        this.state.environment.source === "manual" &&
        (invalidReuse || invalidHost)
      ) {
        this.set({ environment: auto({ type: "project-default" }) });
        this.schedule();
        this.set({
          announcement: "Environment reset to the project's default.",
        });
      }
    } catch (error) {
      if (mine === this.environmentGeneration)
        this.set({ catalogError: String(error) });
    }
  }
  async loadThread(sdk: PluginBrowserBbSdk, threadId: string) {
    if (this.state.threadExecution[threadId]) return;
    if (this.threadRequests.has(threadId))
      return this.threadRequests.get(threadId);
    const mine = this.catalogGeneration;
    const request = Promise.all([
      sdk.threads.get({ threadId, include: "environment" }),
      sdk.threads.defaultExecutionOptions({ threadId }),
    ])
      .then(async ([record, execution]) => {
        const environment =
          "environment" in record
            ? record.environment
            : record.environmentId
              ? await sdk.environments.get({
                  environmentId: record.environmentId,
                })
              : null;
        if (mine !== this.catalogGeneration) return;
        if (!execution)
          throw new Error("Thread settings are unavailable. Retry choices.");
        this.set({
          threadExecution: {
            ...this.state.threadExecution,
            [threadId]: execution,
          },
          threads: [
            ...this.state.threads.filter((t) => t.id !== threadId),
            {
              id: record.id,
              title: record.title ?? record.id,
              sectionId: record.sectionId,
              projectId: record.projectId,
              environmentId: record.environmentId,
              environmentName: environment?.name ?? environment?.path ?? null,
            },
          ],
        });
      })
      .catch((error) => {
        if (mine === this.catalogGeneration)
          this.set({ catalogError: String(error) });
      })
      .finally(() => this.threadRequests.delete(threadId));
    this.threadRequests.set(threadId, request);
    return request;
  }
  effectiveAction(): IntakeAction {
    if (this.state.redirectPending) return "automatic";
    if (this.state.action.source === "manual") return this.state.action.value;
    if (this.state.destination.source === "manual")
      return this.state.destination.value.kind === "thread"
        ? "send-message"
        : "new-thread";
    // A classifier suggestion is only a proposal. It becomes a continuation
    // after the user explicitly accepts it; dismissing it keeps the composer
    // on the create-thread path.
    return this.state.action.value;
  }
  acceptRedirect() {
    const decision = this.state.decision;
    if (
      !this.state.redirectPending ||
      this.redirectRevision !== this.routingRevision ||
      decision?.outcome !== "continue"
    )
      return;
    this.redirectRevision = null;
    const destination: IntakeDestination = {
      kind: "thread",
      id: decision.threadId,
      title: decision.threadTitle,
    };
    this.selectionKey = "";
    this.selectionThread = null;
    this.set({
      redirectPending: false,
      action: manual("send-message"),
      destination: manual(destination),
      synchronizedThread: null,
      synchronizedPlacement: null,
      selectionRevision: this.state.selectionRevision + 1,
    });
  }
  dismissRedirect() {
    if (
      !this.state.redirectPending ||
      this.redirectRevision !== this.routingRevision ||
      this.state.decision?.outcome !== "continue"
    )
      return;
    this.redirectRevision = null;
    const destination = this.state.destination.value;
    const thread = destination.kind === "thread" ? destination : null;
    const decision = this.state.decision;
    const workstream =
      decision?.outcome === "continue" && decision.sectionId
        ? {
            kind: "workstream" as const,
            id: decision.sectionId,
            name: decision.workstream ?? decision.sectionId,
          }
        : { kind: "automatic" as const };
    const fallbackDestination: IntakeDestination =
      workstream.kind === "workstream"
        ? {
            kind: "workstream",
            id: workstream.id,
            name: workstream.name,
          }
        : { kind: "unassigned" };
    this.set({
      redirectPending: false,
      action: manual("new-thread"),
      destination: manual(fallbackDestination),
      decision: null,
      // The project and environment fields were never changed by a proposed
      // redirect, so leaving them untouched restores the create intent.
      announcement: thread ? "New thread" : "",
    });
    this.schedule();
  }
  lockedThread() {
    const destination = this.state.destination.value;
    return this.effectiveAction() === "send-message" &&
      destination.kind === "thread"
      ? this.state.threads.find((t) => t.id === destination.id)
      : undefined;
  }
  intent(): RouteIntent {
    const { action, destination, project, environment, name } = this.state;
    const intent: RouteIntent = {};
    if (action.source === "manual" && action.value !== "automatic")
      intent.action = action.value;
    if (
      destination.source === "manual" &&
      this.effectiveAction() !== "new-workstream"
    ) {
      if (
        destination.value.kind === "workstream" ||
        destination.value.kind === "thread"
      )
        intent.destination = {
          kind: destination.value.kind,
          id: destination.value.id,
        };
      if (destination.value.kind === "unassigned")
        intent.destination = { kind: "none" };
    }
    const fixedContinuation =
      this.effectiveAction() === "send-message" &&
      (action.source === "manual" || destination.source === "manual");
    if (!fixedContinuation) {
      const placement: NonNullable<RouteIntent["placement"]> = {};
      if (project.source === "manual" && project.value)
        placement.projectId = project.value;
      if (environment.source === "manual" && environment.value)
        placement.environment = environment.value;
      if (Object.keys(placement).length) intent.placement = placement;
    }
    if (name.source === "manual" && this.effectiveAction() === "new-workstream")
      intent.workstreamName = name.value;
    return intent;
  }
  observe(text: string, _hostProject?: string | null) {
    if (this.submitting && !text.trim()) return;
    if (
      text.trim() === this.state.text &&
      (!this.state.loading || this.pending || this.timer)
    )
      return;
    this.set({ text: text.trim() });
    this.schedule();
  }
  selectAction(value: Exclude<IntakeAction, "automatic">) {
    const destination = this.state.destination.value;
    let next = this.state.destination;
    if (value === "new-thread" && destination.kind === "thread") {
      const thread = this.state.threads.find((t) => t.id === destination.id);
      const d = this.state.decision;
      const sectionId =
        thread?.sectionId ?? (d?.outcome === "continue" ? d.sectionId : null);
      const name = d?.outcome === "continue" ? d.workstream : null;
      next = auto(
        sectionId
          ? { kind: "workstream", id: sectionId, name: name ?? sectionId }
          : { kind: "automatic" },
      );
    } else if (
      (value === "send-message" && destination.kind !== "thread") ||
      value === "new-workstream"
    )
      next = auto({ kind: "automatic" });
    this.set({ action: manual(value), destination: next });
    this.schedule();
  }
  selectDestination(value: IntakeDestination) {
    this.set({
      destination: manual(value),
      error: null,
      redirectPending: false,
    });
    this.schedule();
  }
  selectWorkstream(id: string | null, name: string | null) {
    id
      ? this.selectDestination({ kind: "workstream", id, name: name ?? id })
      : this.revertField("destination");
  }
  selectUnassigned() {
    this.selectDestination({ kind: "unassigned" });
  }
  selectProject(value: string) {
    const old = this.state.project.value;
    const environment = this.state.environment.value;
    const sourceHosts =
      this.state.projects.find((project) => project.id === value)?.hostIds ?? [];
    const incompatible =
      old !== value &&
      this.state.environment.source === "manual" &&
      (environment?.type === "reuse" ||
        (environment?.type === "host" &&
          !!environment.hostId &&
          sourceHosts.length > 0 &&
          !sourceHosts.includes(environment.hostId)));
    this.set({
      project: manual(value),
      ...(old !== value && (this.state.environment.source === "automatic" || incompatible)
        ? { environment: auto({ type: "project-default" }) }
        : {}),
    });
    this.schedule();
    if (incompatible)
      this.set({ announcement: "Environment reset for the selected project." });
  }
  selectEnvironment(value: Environment) {
    this.set({ environment: manual(value) });
    this.schedule();
  }
  selectName(value: string) {
    this.set({ name: manual(value) });
    this.schedule();
  }
  revertField(
    field: "action" | "destination" | "project" | "environment" | "name",
  ) {
    if (field === "action") this.set({ action: auto(this.autoAction) });
    if (field === "destination")
      this.set({ destination: auto(this.autoDestination) });
    if (field === "project") this.set({ project: auto(this.autoProject) });
    if (field === "environment")
      this.set({ environment: auto(this.autoEnvironment) });
    if (field === "name") this.set({ name: auto(this.autoName) });
    this.schedule();
  }
  automaticPreview(field: string): string {
    if (field === "action")
      return this.autoAction === "automatic"
        ? ""
        : this.autoAction.replaceAll("-", " ");
    if (field === "destination")
      return this.autoDestination.kind === "workstream"
        ? this.autoDestination.name
        : this.autoDestination.kind === "thread"
          ? this.autoDestination.title
          : "";
    if (field === "project")
      return (
        this.state.projects.find((p) => p.id === this.autoProject)?.name ?? ""
      );
    if (field === "environment") return this.autoEnvironmentLabel;
    return this.autoName;
  }
  selection(): ComposerSelection | null {
    const thread = this.lockedThread();
    if (
      this.effectiveAction() === "send-message" &&
      (!thread ||
        !thread.environmentId ||
        !this.state.threadExecution[thread.id])
    )
      return null;
    if (
      this.effectiveAction() !== "send-message" &&
      (!this.state.project.value || !this.state.environment.value)
    )
      return null;
    const selection = thread
      ? {
          ...this.state.threadExecution[thread.id],
          projectId: thread.projectId,
          environment: {
            type: "reuse" as const,
            environmentId: thread.environmentId!,
          },
        }
      : {
          projectId: this.state.project.value!,
          environment: this.state.environment.value!,
        };
    const key = JSON.stringify(selection);
    if (
      key === this.selectionKey &&
      this.selectionThread === (thread?.id ?? null)
    )
      return null;
    this.selectionKey = key;
    this.selectionThread = thread?.id ?? null;
    this.selectionRequests.set(selection, ++this.selectionGeneration);
    this.set({ synchronizedThread: null, synchronizedPlacement: null });
    return selection;
  }
  reconcileSelection(requested: ComposerSelection, applied: ComposerSelection) {
    if (
      JSON.stringify(requested) !== this.selectionKey ||
      this.selectionRequests.get(requested) !== this.selectionGeneration
    )
      return;
    if (this.effectiveAction() === "send-message") {
      const thread = this.lockedThread();
      if (
        thread &&
        applied.projectId === requested.projectId &&
        JSON.stringify(applied.environment) ===
          JSON.stringify(requested.environment) &&
        applied.providerId === requested.providerId &&
        applied.model === requested.model
      )
        this.set({ synchronizedThread: thread.id, selectionError: null });
      else
        this.selectionFailed(
          "The composer couldn't use the thread's settings. Retry choices.",
        );
      return;
    }
    if (applied.projectId && applied.projectId !== requested.projectId) {
      this.selectionFailed("Choose a project the composer can use.");
      return;
    }
    if (
      requested.environment?.type !== "project-default" &&
      !environmentAcknowledged(requested.environment, applied.environment)
    ) {
      this.selectionFailed("Choose an environment the composer can use.");
      return;
    }
    if (
      requested.environment?.type === "project-default" &&
      applied.environment &&
      this.state.environment.source === "automatic"
    ) {
      this.set({ environment: auto(applied.environment) });
      this.selectionKey = JSON.stringify({
        projectId: requested.projectId,
        environment: applied.environment,
      });
    }
    this.set({
      selectionError: null,
      synchronizedPlacement: JSON.stringify([
        this.state.project.value,
        this.state.environment.value,
      ]),
    });
  }
  selectionFailed(error: unknown, requested?: ComposerSelection) {
    if (
      requested &&
      (JSON.stringify(requested) !== this.selectionKey ||
        this.selectionRequests.get(requested) !== this.selectionGeneration)
    )
      return;
    this.selectionKey = "";
    this.set({ selectionError: String(error) });
  }
  retry() {
    this.set({
      selectionRevision: this.state.selectionRevision + 1,
      selectionError: null,
    });
    this.schedule();
  }
  private schedule() {
    this.invalidate();
    this.routingRevision++;
    this.redirectRevision = null;
    this.set({
      decision: null,
      redirectPending: false,
      error: null,
      announcement: "",
      loading: !!this.state.text,
    });
    if (!this.state.text) return;
    this.timer = setTimeout(
      () => {
        void this.resolve();
      },
      this.state.destination.source === "manual"
        ? 0
        : routeDelay(this.state.text),
    );
  }
  async resolve(): Promise<RouteDecision | null> {
    if (this.pending) return this.pending;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const mine = ++this.generation;
    const { text } = this.state;
    if (!text) return null;
    this.set({ loading: true, error: null });
    const intent = this.intent();
    this.pending = this.route({ prompt: text, intent }).then(
      (decision) => {
        if (mine !== this.generation) return null;
        this.pending = null;
        this.decisionIntent = intent;
        const resolvedAction =
          decision.outcome === "continue"
            ? "send-message"
            : decision.outcome === "new-thread"
              ? "new-thread"
              : decision.outcome === "new-workstream"
                ? "new-workstream"
                : "automatic";
        const resolvedDestination: IntakeDestination =
          decision.outcome === "continue"
            ? {
                kind: "thread",
                id: decision.threadId,
                title: decision.threadTitle,
              }
            : decision.outcome === "new-thread" && decision.sectionId
              ? {
                  kind: "workstream",
                  id: decision.sectionId,
                  name: decision.workstream ?? decision.sectionId,
                }
              : { kind: "automatic" };
        const placement = "placement" in decision ? decision.placement : null;
        if (
          this.state.action.source === "automatic" &&
          this.state.destination.source === "automatic"
        )
          this.autoAction = resolvedAction;
        if (this.state.destination.source === "automatic")
          this.autoDestination = resolvedDestination;
        if (this.state.name.source === "automatic")
          this.autoName =
            decision.outcome === "new-workstream" ? decision.name : "";
        if ("placement" in decision) {
          if (this.state.project.source === "automatic")
            this.autoProject = placement?.projectId ?? null;
          if (this.state.environment.source === "automatic") {
            this.autoEnvironment =
              placement?.environment ??
              (this.state.project.value ? { type: "project-default" } : null);
            this.autoEnvironmentLabel = placement?.label ?? "";
          }
        }
        const redirectPending =
          decision.outcome === "continue" &&
          this.state.action.source === "automatic" &&
          this.state.destination.source === "automatic";
        if (redirectPending) this.redirectRevision = this.routingRevision;
        this.set({
          decision,
          loading: false,
          redirectPending,
          ...(this.state.action.source === "automatic" && !redirectPending
            ? { action: auto(resolvedAction) }
            : {}),
          ...(this.state.destination.source === "automatic" && !redirectPending
            ? { destination: auto(this.autoDestination) }
            : {}),
          ...(this.state.project.source === "automatic"
            ? { project: auto(this.autoProject) }
            : {}),
          ...(this.state.environment.source === "automatic"
            ? {
                environment: auto(this.autoEnvironment),
              }
            : {}),
          ...(this.state.name.source === "automatic"
            ? { name: auto(this.autoName) }
            : {}),
        });
        return decision;
      },
      (error) => {
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
  canSubmit() {
    const s = this.state;
    return (
      !!s.text &&
      !s.loading &&
      !s.error &&
      !s.selectionError &&
      !!s.decision &&
      s.decision.outcome !== "unsure" &&
      !s.redirectPending &&
      (s.decision.outcome === "continue"
        ? s.synchronizedThread === s.decision.threadId
        : !!s.project.value &&
          !!s.environment.value &&
          s.synchronizedPlacement ===
            JSON.stringify([s.project.value, s.environment.value]) &&
          (s.decision.outcome !== "new-workstream" || !!s.name.value.trim()))
    );
  }
  async forSubmit(text: string) {
    if (text.trim() !== this.state.text) this.observe(text);
    if (!this.canSubmit())
      throw new Error(
        this.state.error || this.state.selectionError
          ? "Retry or choose where this goes."
          : this.state.loading
            ? "Wait for the destination to be ready."
            : "Choose a destination and project before sending.",
      );
    this.submitting = true;
    return {
      decision: this.state.decision!,
      choice: null,
      intent: this.decisionIntent,
    };
  }
  completeSubmit() {
    this.submitting = false;
  }
}
export const IntakeContext = createContext<Intake | null>(null);
