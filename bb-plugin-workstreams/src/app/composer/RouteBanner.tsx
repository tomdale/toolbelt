/**
 * The routing banner in BB's native new-thread composer (SPEC §6). While you
 * type, it proposes where the work goes and presets the project and
 * environment pickers; ⏎ (or Start) creates the thread and the server files it
 * where the banner said. A continue sends the draft to that thread instead.
 *
 * The composer remounts this banner whenever its scope changes (including
 * the project switch the banner itself makes), so routing state lives in a
 * module-level store rather than in the component. Inside New work,
 * `IntakeBanner` renders instead and keeps its state in the dialog's `Intake`.
 */
import { useContext, useEffect, useSyncExternalStore } from "react";
import { IntakeContext } from "./intake.ts";
import { IntakeBanner } from "./IntakeBanner.tsx";
import {
  useBbNavigate,
  useComposer,
  useComposerView,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { RouteDecision } from "../../server/router.ts";
import { InspectButton } from "../debug/InspectButton.tsx";
import { routeDelay, SHORT_DRAFT_CHARS } from "./timing.ts";

/**
 * Identifies this window's new-thread draft to the server, which keeps one
 * routing call per draft and aborts it when a newer one starts.
 */
const DRAFT_KEY = crypto.randomUUID();

type RouteState = {
  /** Draft text the current decision is for. */
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
  /** The decision whose selection was applied; each is applied once. */
  presetFor: string | null;
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
  presetFor: null,
};
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
/** The text of the routing call in flight, if any. */
let inflight: string | null = null;

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
  inflight = null;
  state = {
    text: "",
    decision: null,
    loading: false,
    error: null,
    preset: null,
    initialProject: null,
    busy: false,
    note: null,
    presetFor: null,
  };
}

type Rpc = ReturnType<typeof useRpc<RpcContract>>;

/**
 * Drops the routing call in flight, locally at once and on the server, which
 * aborts its model request. Its answer is for text the user has moved past.
 */
function cancelInflight(rpc: Rpc) {
  if (inflight === null) return;
  inflight = null;
  generation++;
  set({ loading: false });
  void rpc.call("routeCancel", { draftKey: DRAFT_KEY }).catch(() => {
    // A cancel that can't reach the server only costs one wasted call.
  });
}

function schedule(
  rpc: Rpc,
  text: string,
  projectId: string | null,
  workstreamId?: string,
  /** The user picked this project over the banner's preset. */
  userPick?: string,
  /** The unsure decision `workstreamId` was picked from; keeps its trace. */
  fromDecisionId?: string,
) {
  if (timer) clearTimeout(timer);
  timer = null;
  const trimmed = text.trim();
  const forced = Boolean(workstreamId || userPick);
  // Any change to the text makes the call in flight worthless.
  if (inflight !== null && (inflight !== trimmed || forced))
    cancelInflight(rpc);
  // An emptied draft starts over, so the next one reads the picker afresh.
  if (!trimmed) {
    if (state.text || state.decision || state.initialProject)
      resetRouteBanner();
    set({ initialProject: projectId });
    return;
  }
  if (state.initialProject === null) set({ initialProject: projectId });
  if (!forced && (inflight === trimmed || state.text === trimmed)) return;
  const picked =
    userPick ??
    (projectId &&
    projectId !== state.preset &&
    projectId !== state.initialProject
      ? projectId
      : null);
  const mine = ++generation;
  timer = setTimeout(
    () => {
      timer = null;
      inflight = trimmed;
      set({ loading: true, error: null });
      rpc
        .call("route", {
          prompt: trimmed,
          pickedProjectId: picked,
          draftKey: DRAFT_KEY,
          // RPC input must be JSON: omit rather than send undefined.
          ...(workstreamId ? { workstreamId } : {}),
          ...(fromDecisionId ? { fromDecisionId } : {}),
        })
        .then(
          (decision) => {
            if (mine !== generation) return;
            inflight = null;
            set({
              text: trimmed,
              decision: decision as RouteDecision,
              loading: false,
            });
          },
          (error: unknown) => {
            if (mine !== generation) return;
            inflight = null;
            set({
              text: trimmed,
              loading: false,
              decision: null,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        );
    },
    forced ? 0 : routeDelay(trimmed),
  );
}

export function RouteBanner() {
  const intake = useContext(IntakeContext);
  return intake ? <IntakeBanner intake={intake} /> : <NativeRouteBanner />;
}

function NativeRouteBanner() {
  const rpc = useRpc<RpcContract>();
  const view = useComposerView();
  const composer = useComposer();
  const navigate = useBbNavigate();
  const route = useSyncExternalStore(subscribe, () => state);
  const projectId =
    view.scope.kind === "new-thread" ? view.scope.projectId : null;
  const text = view.draft.text;

  useEffect(() => {
    // A project picked after the banner preset its own is the user's call:
    // route again with it as the hint instead of switching back.
    const overridden =
      state.presetFor !== null &&
      state.preset !== null &&
      projectId !== null &&
      projectId !== state.preset;
    if (overridden) set({ presetFor: null, preset: null });
    schedule(
      rpc,
      text,
      projectId,
      undefined,
      overridden && projectId ? projectId : undefined,
    );
  }, [rpc, text, projectId]);

  // Preset the pickers to the routed project and environment, once per
  // decision. The composer may keep its own project: a fork draft locks it,
  // and a pending attachment copy refuses the switch. Its choice is
  // authoritative (Start submits through it and the thread is filed into the
  // routed workstream either way), so adopt it silently.
  const decision = route.decision;
  useEffect(() => {
    if (
      !decision ||
      (decision.outcome !== "new-thread" &&
        decision.outcome !== "new-workstream") ||
      state.presetFor === decision.id
    )
      return;
    const { placement } = decision;
    if (!placement.projectId) return;
    set({ preset: placement.projectId, presetFor: decision.id });
    void composer
      .experimental_setSelection({
        projectId: placement.projectId,
        environment: placement.environment as never,
      })
      .then(
        (applied) =>
          // Record the kept project as the banner's preset, so it is not
          // later mistaken for the user's own pick.
          set({ preset: applied.projectId ?? placement.projectId, note: null }),
        (error: unknown) =>
          set({
            preset: null,
            note: `Pick the project yourself: ${error instanceof Error ? error.message : String(error)}`,
          }),
      );
  }, [decision, composer]);

  const trimmed = text.trim();
  if (!trimmed) return null;
  // A short draft is routed tentatively: only a decision is worth showing,
  // not progress or errors.
  const short = trimmed.length < SHORT_DRAFT_CHARS;
  if (short && !decision) return null;
  if (route.loading && !decision)
    return (
      <div className="ws-route" role="status" aria-live="polite">
        <span aria-hidden="true">✦</span> Finding where this goes…
      </div>
    );
  if (route.error && !short)
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
  const stale = route.text !== text.trim() || route.loading;

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
            New thread in <strong>{decision.workstream}</strong>
          </>
        ) : decision.outcome === "new-workstream" ? (
          <>
            New workstream <strong>{decision.name}</strong>
          </>
        ) : (
          <>Not sure where this goes:</>
        )}
        {route.note ? (
          <span className="ws-route-reason"> ({route.note})</span>
        ) : null}
      </span>
      {decision.traceId ? (
        <InspectButton
          target={{ traceIds: [decision.traceId] }}
          title="Why this destination"
          label="Inspect the routing call"
        />
      ) : null}
      <span className="ws-route-actions">
        {decision.outcome === "continue" ? (
          <button
            type="button"
            disabled={route.busy || stale}
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
                disabled={route.busy || stale}
                onClick={() => void sendTo(c.threadId)}
              >
                {c.title}
              </button>
            ) : (
              <button
                key={c.sectionId}
                type="button"
                disabled={route.busy || stale}
                onClick={() =>
                  schedule(
                    rpc,
                    text,
                    projectId,
                    c.sectionId,
                    undefined,
                    decision.id,
                  )
                }
              >
                {c.name}
              </button>
            ),
          )
        ) : (
          <button
            type="button"
            disabled={route.busy || stale}
            onClick={() => void start()}
          >
            Start ⏎
          </button>
        )}
      </span>
    </div>
  );
}
