/**
 * The routing banner in BB's native new-thread composer (SPEC §6). While you
 * type, it proposes where the work goes and presets the project and
 * environment pickers; ⏎ (or Start) creates the thread and the server files it
 * where the banner said. A continue sends the draft to that thread instead.
 *
 * The composer remounts this banner whenever its scope changes (including
 * the project switch the banner itself makes), so routing state lives in a
 * module-level store rather than in the component.
 */
import { useEffect, useSyncExternalStore } from "react";
import {
  useBbNavigate,
  useComposer,
  useComposerView,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { RouteDecision } from "../../server/router.ts";

const MIN_CHARS = 20;
const DEBOUNCE_MS = 600;

type RouteState = {
  /** Draft text the current decision (or request) is for. */
  text: string;
  decision: RouteDecision | null;
  loading: boolean;
  error: string | null;
  /** The project this banner switched the picker to; not a user choice. */
  preset: string | null;
  /** The picker's project when routing started, to tell user picks apart. */
  initialProject: string | null;
  busy: boolean;
  /** Why the pickers couldn't be preset, when they couldn't. */
  note: string | null;
};

let state: RouteState = {
  text: "",
  decision: null,
  loading: false,
  error: null,
  preset: null,
  initialProject: null,
  busy: false,
  note: null,
};
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

function set(patch: Partial<RouteState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Resets the store; tests and a cleared draft start fresh. */
export function resetRouteBanner() {
  if (timer) clearTimeout(timer);
  timer = null;
  generation++;
  state = {
    text: "",
    decision: null,
    loading: false,
    error: null,
    preset: null,
    initialProject: null,
    busy: false,
    note: null,
  };
}

type Rpc = ReturnType<typeof useRpc<RpcContract>>;

function schedule(
  rpc: Rpc,
  text: string,
  projectId: string | null,
  workstreamId?: string,
) {
  if (timer) clearTimeout(timer);
  const trimmed = text.trim();
  if (trimmed.length < MIN_CHARS) {
    if (state.decision || state.text)
      set({ text: "", decision: null, error: null });
    return;
  }
  if (trimmed === state.text && !workstreamId) return;
  if (state.initialProject === null) set({ initialProject: projectId });
  const picked =
    projectId &&
    projectId !== state.preset &&
    projectId !== state.initialProject
      ? projectId
      : null;
  const mine = ++generation;
  timer = setTimeout(
    () => {
      set({ text: trimmed, loading: true, error: null });
      rpc
        .call("route", {
          prompt: trimmed,
          pickedProjectId: picked,
          // RPC input must be JSON: omit rather than send undefined.
          ...(workstreamId ? { workstreamId } : {}),
        })
        .then(
          (decision) => {
            if (mine === generation)
              set({ decision: decision as RouteDecision, loading: false });
          },
          (error: unknown) => {
            if (mine === generation)
              set({
                loading: false,
                decision: null,
                error: error instanceof Error ? error.message : String(error),
              });
          },
        );
    },
    workstreamId ? 0 : DEBOUNCE_MS,
  );
}

export function RouteBanner() {
  const rpc = useRpc<RpcContract>();
  const view = useComposerView();
  const composer = useComposer();
  const navigate = useBbNavigate();
  const route = useSyncExternalStore(subscribe, () => state);
  const projectId =
    view.scope.kind === "new-thread" ? view.scope.projectId : null;
  const text = view.draft.text;

  useEffect(() => {
    schedule(rpc, text, projectId);
  }, [rpc, text, projectId]);

  // Preset the pickers to the routed project and environment.
  const decision = route.decision;
  useEffect(() => {
    if (
      !decision ||
      (decision.outcome !== "new-thread" &&
        decision.outcome !== "new-workstream")
    )
      return;
    const { placement } = decision;
    if (!placement.projectId || placement.projectId === projectId) return;
    set({ preset: placement.projectId });
    void composer
      .experimental_setSelection({
        projectId: placement.projectId,
        environment: placement.environment as never,
      })
      .then(
        () => set({ note: null }),
        (error: unknown) =>
          set({
            preset: null,
            note: `Pick the project yourself: ${error instanceof Error ? error.message : String(error)}`,
          }),
      );
  }, [decision, projectId, composer]);

  if (text.trim().length < MIN_CHARS) return null;
  if (route.loading && !decision)
    return (
      <div className="ws-route" role="status" aria-live="polite">
        <span aria-hidden="true">✦</span> Finding where this goes…
      </div>
    );
  if (route.error)
    return (
      <div className="ws-route" role="status">
        <span aria-hidden="true">✦</span> {route.error}
      </div>
    );
  if (!decision) return null;

  const act = async (work: () => Promise<void>) => {
    set({ busy: true, error: null });
    try {
      await work();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ busy: false });
    }
  };
  const sendTo = (threadId?: string) =>
    act(async () => {
      const result = await rpc.call("routeExecute", {
        decisionId: decision.id,
        prompt: route.text,
        choice: threadId ? { threadId } : null,
      });
      composer.clear();
      resetRouteBanner();
      if (result.threadId) navigate.toThread(result.threadId);
    });
  const start = () =>
    act(async () => {
      await composer.experimental_submit({
        experimental_data: { routeId: decision.id },
      });
      resetRouteBanner();
    });
  const stale = route.text !== text.trim();

  return (
    <div
      className="ws-route"
      role="status"
      aria-live="polite"
      data-stale={stale || route.loading ? "" : undefined}
    >
      <span aria-hidden="true">✦</span>
      <span className="ws-route-text">
        {decision.outcome === "continue" ? (
          <>
            Continue <strong>{decision.threadTitle}</strong>
          </>
        ) : decision.outcome === "new-thread" ? (
          <>
            New thread in <strong>{decision.workstream}</strong> ·{" "}
            {decision.placement.label}
          </>
        ) : decision.outcome === "new-workstream" ? (
          <>
            New workstream <strong>{decision.name}</strong> ·{" "}
            {decision.placement.label}
          </>
        ) : (
          <>Not sure where this goes:</>
        )}
        {decision.reason && decision.outcome !== "unsure" ? (
          <span className="ws-route-reason"> — {decision.reason}</span>
        ) : null}
        {route.note ? (
          <span className="ws-route-reason"> ({route.note})</span>
        ) : null}
      </span>
      <span className="ws-route-actions">
        {decision.outcome === "continue" ? (
          <button
            type="button"
            disabled={route.busy}
            onClick={() => void sendTo()}
          >
            Send there
          </button>
        ) : decision.outcome === "unsure" ? (
          decision.candidates.map((c) =>
            c.kind === "thread" ? (
              <button
                key={c.threadId}
                type="button"
                disabled={route.busy}
                onClick={() => void sendTo(c.threadId)}
              >
                {c.title}
              </button>
            ) : (
              <button
                key={c.sectionId}
                type="button"
                disabled={route.busy}
                onClick={() => schedule(rpc, text, projectId, c.sectionId)}
              >
                {c.name}
              </button>
            ),
          )
        ) : (
          <button
            type="button"
            disabled={route.busy}
            onClick={() => void start()}
          >
            Start ⏎
          </button>
        )}
      </span>
    </div>
  );
}
