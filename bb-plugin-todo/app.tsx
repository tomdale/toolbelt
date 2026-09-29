import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { definePluginApp, experimental_Icon as Icon, useComposerView, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import type { Task } from "./model.js";
import { autoExpanded, buildCardView, currentLabel, type CardRow } from "./card.js";
import "./app.css";

// `animate-shine`/`animate-shine-icon` are BB's own working-sweep classes, the
// same ones its native todo card uses. The host drops the mask under
// aria-hidden and prefers-reduced-motion, so the collapsed body costs nothing.
const shine = (on: boolean, icon = false) => on ? (icon ? " animate-shine-icon" : " animate-shine") : "";
const STATUS_TEXT: Record<Task["status"], string> = { in_progress: "In progress", pending: "Pending", completed: "Completed", deleted: "Deleted" };

function TodoRow({ row, showIds, working }: { row: CardRow; showIds: boolean; working: boolean }) {
  const { task, depth, blockers } = row;
  const state = task.status === "in_progress" ? "active" : task.status === "completed" ? "completed" : blockers.length ? "blocked" : "pending";
  const icon = state === "completed" ? "Check" : state === "blocked" ? "Lock" : "Square";
  const active = state === "active";
  return <li className={`todo-row todo-row-${state}`} data-depth={depth || undefined} style={depth ? { "--todo-depth": depth } as CSSProperties : undefined}>
    <Icon name={icon} className={`todo-row-icon${shine(active && working, true)}`} aria-hidden="true" />
    <span className={`todo-row-text${shine(active && working)}`} title={task.subject}>
      <span className="todo-sr">{STATUS_TEXT[task.status]}{blockers.length ? ", blocked" : ""}: </span>
      {showIds && <span className="todo-row-id">#{task.id}</span>}
      {task.subject}
    </span>
    {blockers.length > 0 && <span className="todo-row-meta">after {blockers.map(id => `#${id}`).join(", ")}</span>}
  </li>;
}

function TodoCard() {
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" || view.scope.kind === "queued-message" ? view.scope.threadId
    : view.scope.kind === "side-chat" ? view.scope.childThreadId : null;
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pendingClear, setPendingClear] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const clearInFlight = useRef(false);
  const activeThread = useRef(threadId);
  activeThread.current = threadId;
  // A manual toggle holds only until the automatic state it overrode changes,
  // so the next run (or its completion) takes over again.
  const [override, setOverride] = useState<{ auto: boolean; open: boolean } | null>(null);
  const generation = useRef(0);
  // Thread and queued-message composers can mount this card at the same time.
  const baseId = useId();
  const bodyId = `${baseId}-body`, toggleId = `${baseId}-toggle`;
  const refresh = useCallback(() => {
    const request = ++generation.current;
    if (!threadId) { setTasks([]); setPendingClear(null); setError(null); return; }
    rpc.call("snapshot", { threadId }).then(result => {
      if (generation.current === request) {
        setTasks(result.tasks);
        if (result.pendingClear) requestId.current = result.pendingClear;
        else if (result.completedClear === requestId.current) requestId.current = null;
        // An older snapshot must not unmask tasks while a clear is in flight.
        setPendingClear(result.pendingClear ?? requestId.current);
        setError(null);
      }
    }, cause => {
      if (generation.current === request) setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc, threadId]);
  useEffect(() => { setTasks([]); setPendingClear(null); requestId.current = null; setOverride(null); setConfirming(false); setClearing(false); setClearError(null); refresh(); return () => { generation.current++; }; }, [threadId, refresh]);
  useEffect(() => { refresh(); }, [connection, refresh]);
  useRealtime("todo-timeline-changed", payload => {
    if (payload && typeof payload === "object" && "threadId" in payload && payload.threadId === threadId) refresh();
  });
  // Lifecycle events can arrive before the final tool completion is persisted.
  // Reconcile while running, and once more on the run-to-idle transition.
  useEffect(() => {
    if (!view.run.isRunning || !threadId) { refresh(); return; }
    const timer = window.setInterval(refresh, 1500);
    return () => window.clearInterval(timer);
  }, [view.run.isRunning, threadId, refresh]);
  const clear = async () => {
    if (!threadId || clearInFlight.current) return;
    clearInFlight.current = true;
    const currentThread = threadId;
    const id = pendingClear ?? requestId.current ?? crypto.randomUUID();
    requestId.current = id;
    setPendingClear(id);
    setClearing(true);
    setClearError(null);
    try {
      await rpc.call("clear", { threadId: currentThread, requestId: id });
      if (activeThread.current === currentThread) { setConfirming(false); refresh(); }
    } catch (cause) {
      if (activeThread.current === currentThread) {
        setClearError(cause instanceof Error ? cause.message : String(cause));
        refresh();
      }
    } finally {
      clearInFlight.current = false;
      if (activeThread.current === currentThread) setClearing(false);
    }
  };
  const card = useMemo(() => buildCardView(pendingClear || clearing ? [] : tasks), [tasks, pendingClear, clearing]);
  if (!threadId) return null;
  if (!card.total && !pendingClear && !clearing) {
    if (!error) return null;
    return <div className="todo-card">
      <div className="todo-header todo-header-error" role="alert" title={error}>
        <Icon name="ListTodo" className="todo-header-icon" aria-hidden="true" />
        <span className="todo-summary">Todo timeline unavailable</span>
      </div>
    </div>;
  }
  const auto = pendingClear !== null || clearing || autoExpanded(card, view.run.isRunning);
  const expanded = pendingClear !== null || clearing || (override && override.auto === auto ? override.open : auto);
  const working = view.run.isRunning && !card.allComplete;
  const current = currentLabel(card);
  const summary = pendingClear ? "Pi Todo clear pending" : clearing ? "Clearing Pi Todo…" : `${card.completed}/${card.total} complete`;
  return <div className={`todo-card${card.allComplete ? " todo-card-done" : ""}`}>
    <button type="button" id={toggleId} className="todo-header" aria-expanded={expanded} aria-controls={bodyId}
      aria-label={`To-do list: ${card.completed} of ${card.total} ${card.total === 1 ? "item" : "items"} complete${current ? `; ${current}` : ""}`}
      onClick={() => setOverride({ auto, open: !expanded })}>
      <Icon name={card.allComplete ? "CircleCheck" : "ListTodo"} className={`todo-header-icon${shine(working, true)}`} aria-hidden="true" />
      <span className={`todo-summary${shine(working)}`}>{summary}</span>
      <span className="todo-current" title={current ?? undefined}>{current}</span>
      <Icon name="ChevronDown" className="todo-chevron" aria-hidden="true" />
    </button>
    <section id={bodyId} role="region" aria-labelledby={toggleId} aria-hidden={!expanded} inert={!expanded}
      className="todo-body" data-expanded={expanded || undefined}>
      <div className="todo-body-inner">
        {error && <p role="alert" className="todo-error">Todo timeline unavailable: {error}</p>}
        {pendingClear || clearing ? <p className="todo-pending">Pi Todo clear has not been confirmed. Earlier tasks are hidden until this request is resolved.</p>
          : <ul className="todo-list">{card.rows.map(row => <TodoRow key={row.task.id} row={row} showIds={card.showIds} working={working} />)}</ul>}
        <div className="todo-actions">
          {pendingClear ? <>
            <p>Resume the current Pi Todo clear request? Live tasks may already be cleared. Chat and transcript history will remain.</p>
            {clearError && <p role="alert" className="todo-clear-error">Could not confirm Pi Todo clear: {clearError}</p>}
            <button type="button" onClick={() => void clear()} disabled={clearing || view.run.isRunning}>
              {clearing ? "Checking Pi Todo clear…" : "Resume / retry clear"}
            </button>
          </> : confirming ? <>
            <p>Clear the current Pi Todo list? Live tasks will be removed, but chat and transcript history will remain.</p>
            {clearError && <p role="alert" className="todo-clear-error">Could not clear Pi Todo: {clearError}</p>}
            <div className="todo-action-buttons">
              <button type="button" onClick={() => { setConfirming(false); setClearError(null); }} disabled={clearing}>Cancel</button>
              <button type="button" className="todo-clear-confirm" onClick={() => void clear()} disabled={clearing || view.run.isRunning}>
                {clearing ? "Clearing Pi Todo…" : "Confirm clear"}
              </button>
            </div>
          </> : <button type="button" onClick={() => { setConfirming(true); setClearError(null); }} disabled={view.run.isRunning}>Clear current Pi Todo list</button>}
        </div>
      </div>
    </section>
  </div>;
}
export default definePluginApp(app => {
  app.composer.customize({ id: "pi-todo-renderer", scopes: ["thread", "queued-message", "side-chat"], banners: [{ id: "todos", chrome: "card", component: TodoCard }] });
});
