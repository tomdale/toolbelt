import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, experimental_FileLink as FileLink, Markdown, UrlLink, useComposer, useRealtime, useRealtimeConnectionState, useRpc, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { questionsSchema, QUESTIONS_RENDERER } from "./contracts";
import type { rpcContract } from "./server";

function Handoff() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<Awaited<ReturnType<typeof rpc.call<"current">>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestVersion = useRef(0);
  const connection = useRealtimeConnectionState();
  const refresh = useCallback(() => {
    if (!threadId) return;
    const version = ++requestVersion.current;
    void rpc.call("current", { threadId }).then((next) => {
      if (version === requestVersion.current) setState(next);
    }).catch(() => { if (version === requestVersion.current) setState(null); });
  }, [rpc, threadId]);
  useEffect(() => {
    setState(null); setError(null); refresh();
    return () => { requestVersion.current++; };
  }, [refresh, connection]);
  useRealtime("changed", (payload) => {
    if (payload && typeof payload === "object" && "threadId" in payload && payload.threadId === threadId) refresh();
  });
  if (!threadId || !state) return null;
  const card = state.card;
  if (!card) return state.capped ? <p role="status" className="p-3 text-sm text-muted-foreground">Bottom Line reached its correction limit ({state.intercepts}). You can resume this thread with a message.</p> : null;
  async function act(action: "archive" | "dismiss") {
    if (!threadId || !card) return;
    setBusy(true); setError(null);
    try { await rpc.call(action, { threadId, cardId: card.id }); refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section aria-label="Bottom Line" className="rounded-lg border border-border bg-card p-3 space-y-3">
    <p className="text-xs font-medium text-muted-foreground">{card.kind === "finished" ? "Task finished" : "Requested deliverables"}</p>
    <Markdown content={card.summary} />
    {card.deliverables.length ? <ul className="space-y-2">{card.deliverables.map((item, i) => <li key={i}>
      {item.location.startsWith("https://") ? <UrlLink href={item.location}>{item.title}</UrlLink> : state.environmentId ? <FileLink target={{ kind: "workspace", environmentId: state.environmentId, path: item.location }}>{item.title}</FileLink> : <span>{item.title}: {item.location}</span>}
      {item.description ? <p className="text-sm text-muted-foreground">{item.description}</p> : null}
    </li>)}</ul> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="flex gap-2">
      {card.kind === "finished" ? <Button size="sm" disabled={busy || composer.isRunning || composer.isSubmitting} onClick={() => void act("archive")}>Archive</Button> : null}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("dismiss")}>Dismiss</Button>
    </div>
  </section>;
}

function Questions({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = questionsSchema.safeParse(interaction.payload);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(run: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await run(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (parsed.success) void act(() => submit({ answers: parsed.data.questions.map((_, i) => answers[i]?.trim()) })); }}>
    {parsed.success ? parsed.data.questions.map((q, i) => <fieldset key={i} disabled={busy} className="space-y-2">
      <legend className="text-sm font-medium">{q.question}</legend>
      {q.options.map((option, j) => <label key={j} className="flex items-start gap-2 rounded-md border border-border p-2 text-sm">
        <input type="radio" name={`${interaction.id}-${i}`} checked={answers[i] === option.label} onChange={() => setAnswers((prev) => ({ ...prev, [i]: option.label }))} />
        <span>{option.label}<span className="block text-muted-foreground">{option.description}</span></span>
      </label>)}
      <textarea aria-label={`Your answer: ${q.question}`} className="w-full rounded-md border border-border bg-background p-2 text-sm" value={answers[i] ?? ""} onChange={(e) => setAnswers((prev) => ({ ...prev, [i]: e.target.value }))} placeholder="Type your answer" />
    </fieldset>) : <p role="alert">These questions could not be displayed.</p>}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="flex gap-2">
      <Button type="submit" disabled={busy || !parsed.success || parsed.data.questions.some((_, i) => !answers[i]?.trim())}>Send answers</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={() => void act(cancel)}>Dismiss</Button>
    </div>
  </form>;
}

export default definePluginApp((app) => {
  app.composer.customize({ id: "bottom-line", scopes: ["thread"], banners: [{ id: "handoff", chrome: "bare", component: Handoff }] });
  app.slots.pendingInteraction({ id: QUESTIONS_RENDERER, component: Questions });
});
