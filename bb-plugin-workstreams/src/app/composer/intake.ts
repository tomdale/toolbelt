import { createContext } from "react";
import type {
  ComposerSelection,
  NewThreadRequest,
  PluginBrowserBbSdk,
} from "@get-bb/plugin-sdk/app";
import type {
  NewThreadDecision,
  RouteDecision,
  RouteIntent,
} from "../../server/router.ts";
import { routeDelay } from "./timing.ts";
import {
  hostWorkspaceProviderId,
  isPersonalEnvironment,
  isProviderAvailable,
  type CatalogEnvironment,
  type CatalogProvider,
  type CatalogThread,
} from "./environment-labels.ts";
export type Environment = NonNullable<NewThreadRequest["environment"]>;
export type CatalogStatus = "idle" | "loading" | "ready" | "error";
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
export type {
  CatalogEnvironment,
  CatalogProvider,
  CatalogThread,
} from "./environment-labels.ts";
type ContinueDecision = Extract<RouteDecision, { outcome: "continue" }>;
/**
 * A continuation the router inferred for an automatic draft. The draft still
 * starts a new thread; accepting the suggestion sends it to the thread
 * instead, and declining returns to the new thread.
 */
export type Suggestion = {
  continuation: ContinueDecision;
  /**
   * The new-thread default previewed with the continuation. Null after the
   * draft was rerouted while the suggestion was accepted, so declining then
   * routes again.
   */
  newThread: NewThreadDecision | null;
};
type ExecutionSettings = Pick<
  ComposerSelection,
  "providerId" | "model" | "reasoningLevel" | "serviceTier" | "permissionMode"
>;
function executionOf(selection: ComposerSelection): ExecutionSettings {
  const settings: ExecutionSettings = {};
  if (selection.providerId) settings.providerId = selection.providerId;
  if (selection.model) settings.model = selection.model;
  if (selection.reasoningLevel)
    settings.reasoningLevel = selection.reasoningLevel;
  if (selection.serviceTier) settings.serviceTier = selection.serviceTier;
  if (selection.permissionMode)
    settings.permissionMode = selection.permissionMode;
  return settings;
}
/** Whether the draft goes to the suggested thread rather than a new one. */
export function suggestionAccepted(state: IntakeState): boolean {
  const destination = state.destination.value;
  return (
    !!state.suggestion &&
    state.action.source === "manual" &&
    state.action.value === "send-message" &&
    destination.kind === "thread" &&
    destination.id === state.suggestion.continuation.threadId
  );
}
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
    kind?: "personal" | "standard";
    hostId: string | null;
    hostIds: string[];
  }[];
  environments: readonly CatalogEnvironment[];
  environmentProviders: readonly CatalogProvider[];
  environmentsStatus: CatalogStatus;
  threads: readonly CatalogThread[];
  catalogError: string | null;
  hostId: string | null;
  threadExecution: Record<string, ComposerSelection>;
  synchronizedThread: string | null;
  synchronizedPlacement: string | null;
  selectionRevision: number;
  suggestion: Suggestion | null;
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
  /** The suggestion's decisions belong to the current draft and intent. */
  private suggestionFresh = false;
  /**
   * The execution settings the composer had before an accepted suggestion
   * applied the thread's own; declining puts them back once.
   */
  private restoreExecution: ExecutionSettings | null = null;
  private decisionIntent: RouteIntent = {};
  /**
   * `route` previews the draft. It should ask the router to `offerNewThread`,
   * so an inferred continuation arrives with the new thread New work defaults
   * to.
   */
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
      environmentProviders: [],
      environmentsStatus: "idle",
      threads: [],
      catalogError: null,
      hostId: null,
      threadExecution: {},
      synchronizedThread: null,
      synchronizedPlacement: null,
      selectionRevision: 0,
      suggestion: null,
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
          projects: projects.map(({ id, name, kind, sources }) => ({
            id,
            name,
            kind,
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
              providerId: t.providerId,
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
    this.set({
      environments: [],
      environmentProviders: [],
      environmentsStatus: projectId ? "loading" : "idle",
    });
    if (!projectId) return;
    const project = this.state.projects.find((p) => p.id === projectId);
    const hostId = project?.hostId ?? this.state.hostId;
    try {
      const listPromise = sdk.environments.list({
        projectId,
        status: "ready",
      });
      const providersPromise = sdk.environments.listProviders({
        projectId,
        ...(hostId ? { hostId } : {}),
      });
      const [environments, providers] = await Promise.all([
        listPromise,
        providersPromise,
      ]);
      if (
        mine !== this.environmentGeneration ||
        projectId !== this.state.project.value
      )
        return;
      const catalogEnvs: CatalogEnvironment[] = environments.map((e) => ({
        id: e.id,
        name: e.name ?? null,
        ...(e.path !== undefined ? { path: e.path } : {}),
        ...(e.branchName !== undefined ? { branchName: e.branchName } : {}),
        ...(e.environmentProviderId !== undefined
          ? { environmentProviderId: e.environmentProviderId }
          : {}),
        ...(e.isWorktree !== undefined ? { isWorktree: e.isWorktree } : {}),
        ...(e.isGitRepo !== undefined ? { isGitRepo: e.isGitRepo } : {}),
      }));
      const catalogProviders: CatalogProvider[] = providers.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        description: p.description,
        availability: p.availability,
        machineAvailability: p.machineAvailability,
        requires: p.requires,
        acceptsEmptyInputs: p.acceptsEmptyInputs,
      }));
      this.set({
        environments: catalogEnvs,
        environmentProviders: catalogProviders,
        environmentsStatus: "ready",
      });
      const env = this.state.environment.value;
      const sourceHosts = project?.hostIds ?? [];
      const isPersonal =
        project?.kind === "personal" ||
        projectId === "personal" ||
        projectId === "proj_personal";
      if (this.state.environment.source === "manual" && env) {
        let invalid = false;
        if (env.type === "reuse") {
          invalid = !catalogEnvs.some((e) => e.id === env.environmentId);
        } else if (env.type === "host") {
          const invalidHost =
            !!env.hostId &&
            sourceHosts.length > 0 &&
            !sourceHosts.includes(env.hostId);
          const mappedProviderId = hostWorkspaceProviderId(env.workspace.type);
          const mappedProvider = catalogProviders.find(
            (p) => p.id === mappedProviderId,
          );
          const ineligibleProvider =
            !mappedProvider || !isProviderAvailable(mappedProvider, hostId);
          const invalidPersonal =
            isPersonal && env.workspace.type !== "personal";
          const invalidProjectWorkspace =
            !isPersonal && env.workspace.type === "personal";
          invalid =
            invalidHost ||
            ineligibleProvider ||
            invalidPersonal ||
            invalidProjectWorkspace;
        } else if (env.type === "provider") {
          const matched = catalogProviders.find(
            (p) => p.id === env.environmentProviderId,
          );
          invalid = !matched || !isProviderAvailable(matched, hostId);
        }
        if (invalid) {
          this.schedule();
          this.set({
            environment: auto({ type: "project-default" }),
            selectionError: null,
            announcement: "Environment reset to the project's default.",
          });
        }
      }
    } catch (error) {
      if (mine === this.environmentGeneration) {
        this.set({
          catalogError: String(error),
          environmentsStatus: "error",
        });
      }
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
              providerId: record.providerId,
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
    if (this.state.action.source === "manual") return this.state.action.value;
    if (this.state.destination.source === "manual")
      return this.state.destination.value.kind === "thread"
        ? "send-message"
        : "new-thread";
    return this.state.action.value;
  }
  /**
   * Sends the draft to the suggested thread. `current` is the composer's
   * selection, whose execution settings declining restores.
   */
  acceptSuggestion(current: ComposerSelection | null = null) {
    const suggestion = this.state.suggestion;
    if (!suggestion || suggestionAccepted(this.state)) return;
    const { continuation } = suggestion;
    this.restoreExecution = current ? executionOf(current) : null;
    this.selectionKey = "";
    this.selectionThread = null;
    this.set({
      action: manual("send-message"),
      destination: manual({
        kind: "thread",
        id: continuation.threadId,
        title: continuation.threadTitle,
      }),
      synchronizedThread: null,
      synchronizedPlacement: null,
      selectionRevision: this.state.selectionRevision + 1,
      ...(this.suggestionFresh ? { decision: continuation, error: null } : {}),
    });
    // A suggestion shown while the draft reroutes is for older text.
    if (!this.suggestionFresh) this.schedule();
    this.set({ announcement: `Sending to ${continuation.threadTitle}` });
  }
  /** Returns an accepted suggestion's draft to the new-thread default. */
  declineSuggestion() {
    const suggestion = this.state.suggestion;
    if (!suggestion || !suggestionAccepted(this.state)) return;
    const newThread = this.suggestionFresh ? suggestion.newThread : null;
    this.selectionKey = "";
    this.selectionThread = null;
    this.set({
      action: auto(this.autoAction),
      destination: auto(this.autoDestination),
      synchronizedThread: null,
      synchronizedPlacement: null,
      selectionRevision: this.state.selectionRevision + 1,
      ...(newThread ? { decision: newThread, error: null } : {}),
    });
    if (!newThread) this.schedule();
    this.set({ announcement: "New thread" });
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
    if (value === "new-thread" && suggestionAccepted(this.state))
      return this.declineSuggestion();
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
    this.set({ destination: manual(value), error: null });
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
    const oldProject = this.state.projects.find(
      (project) => project.id === old,
    );
    const newProject = this.state.projects.find(
      (project) => project.id === value,
    );
    const sourceHosts = newProject?.hostIds ?? [];
    const oldIsPersonal =
      oldProject?.kind === "personal" ||
      old === "personal" ||
      old === "proj_personal";
    const newIsPersonal =
      newProject?.kind === "personal" ||
      value === "personal" ||
      value === "proj_personal";

    let incompatible = false;
    if (
      old !== value &&
      this.state.environment.source === "manual" &&
      environment
    ) {
      if (oldIsPersonal !== newIsPersonal) {
        incompatible = true;
      } else if (environment.type === "reuse") {
        incompatible = true;
      } else if (
        environment.type === "host" &&
        environment.hostId &&
        sourceHosts.length > 0 &&
        !sourceHosts.includes(environment.hostId)
      ) {
        incompatible = true;
      } else if (newIsPersonal && !isPersonalEnvironment(environment)) {
        incompatible = true;
      } else if (!newIsPersonal && isPersonalEnvironment(environment)) {
        incompatible = true;
      }
    }

    this.set({
      project: manual(value),
      ...(old !== value &&
      (this.state.environment.source === "automatic" || incompatible)
        ? {
            environment: auto({ type: "project-default" }),
            selectionError: null,
          }
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
    // Automatic action and destination are the new-thread default.
    if (
      (field === "action" || field === "destination") &&
      suggestionAccepted(this.state)
    )
      return this.declineSuggestion();
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
          ...(this.state.threadExecution[thread.id]!.providerId ||
          !thread.providerId
            ? {}
            : { providerId: thread.providerId }),
          projectId: thread.projectId,
          environment: {
            type: "reuse" as const,
            environmentId: thread.environmentId!,
          },
        }
      : {
          ...this.restoreExecution,
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
      else {
        this.selectionFailed(
          "The composer couldn't use the thread's settings. Retry choices.",
        );
      }
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
    if (this.restoreExecution) {
      // Restored once; later placement changes leave the user's pickers alone.
      this.restoreExecution = null;
      this.selectionKey = JSON.stringify({
        projectId: this.state.project.value,
        environment: this.state.environment.value,
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
  recoverSelection() {
    const isProjectError =
      this.state.selectionError?.includes("Choose a project");
    this.schedule();
    this.set({
      selectionError: null,
      error: null,
      selectionRevision: this.state.selectionRevision + 1,
      ...(isProjectError && this.state.project.source === "manual"
        ? { project: auto(this.autoProject) }
        : {}),
      ...(this.state.environment.source === "manual" || isProjectError
        ? { environment: auto({ type: "project-default" }) }
        : {}),
      announcement: isProjectError
        ? "Project and environment reset to automatic."
        : "Environment reset to automatic.",
    });
  }
  retry() {
    const isInvalidSelection =
      this.state.selectionError?.includes("Choose an environment") ||
      this.state.selectionError?.includes("Choose a project");
    if (isInvalidSelection) {
      this.recoverSelection();
      return;
    }
    this.set({
      selectionRevision: this.state.selectionRevision + 1,
      selectionError: null,
      error: null,
    });
    this.schedule();
  }
  private schedule() {
    this.invalidate();
    this.suggestionFresh = false;
    this.set({
      decision: null,
      // A suggestion stays up while the draft reroutes, so it doesn't flicker
      // with each typing pause. The next result replaces or removes it.
      ...(this.state.text ? {} : { suggestion: null }),
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
      (routed) => {
        if (mine !== this.generation) return null;
        this.pending = null;
        this.decisionIntent = intent;
        // An inferred continuation is only offered: until the user accepts
        // it, the draft starts the new thread previewed alongside it.
        const offered =
          routed.outcome === "continue" &&
          this.state.action.source === "automatic" &&
          this.state.destination.source === "automatic";
        const suggestion: Suggestion | null =
          routed.outcome !== "continue"
            ? null
            : offered
              ? { continuation: routed, newThread: routed.alternative ?? null }
              : suggestionAccepted(this.state) &&
                  this.state.suggestion?.continuation.threadId ===
                    routed.threadId
                ? { continuation: routed, newThread: null }
                : null;
        this.suggestionFresh = !!suggestion;
        const decision = offered ? (suggestion?.newThread ?? null) : routed;
        const resolvedAction: IntakeAction = offered
          ? "new-thread"
          : routed.outcome === "continue"
            ? "send-message"
            : routed.outcome === "new-thread"
              ? "new-thread"
              : routed.outcome === "new-workstream"
                ? "new-workstream"
                : "automatic";
        const resolvedDestination: IntakeDestination =
          decision?.outcome === "continue"
            ? {
                kind: "thread",
                id: decision.threadId,
                title: decision.threadTitle,
              }
            : decision?.outcome === "new-thread"
              ? decision.sectionId
                ? {
                    kind: "workstream",
                    id: decision.sectionId,
                    name: decision.workstream ?? decision.sectionId,
                  }
                : { kind: "unassigned" }
              : { kind: "automatic" };
        const placement =
          decision && "placement" in decision ? decision.placement : null;
        if (
          this.state.action.source === "automatic" &&
          this.state.destination.source === "automatic"
        )
          this.autoAction = resolvedAction;
        if (this.state.destination.source === "automatic")
          this.autoDestination = resolvedDestination;
        if (this.state.name.source === "automatic")
          this.autoName =
            decision?.outcome === "new-workstream" ? decision.name : "";
        if (decision && "placement" in decision) {
          if (this.state.project.source === "automatic")
            this.autoProject = placement?.projectId ?? null;
          if (this.state.environment.source === "automatic") {
            this.autoEnvironment =
              placement?.environment ??
              (this.state.project.value ? { type: "project-default" } : null);
            this.autoEnvironmentLabel = placement?.label ?? "";
          }
        }
        this.set({
          decision,
          suggestion,
          loading: false,
          ...(this.state.action.source === "automatic"
            ? { action: auto(resolvedAction) }
            : {}),
          ...(this.state.destination.source === "automatic"
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
