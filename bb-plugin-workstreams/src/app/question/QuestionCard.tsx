/**
 * The AskUserQuestion card, drawn above the composer where the recap card
 * goes, in the recap card's style.
 *
 * BB mounts a plugin's form only inside its pending-interaction shell, and
 * only that mount receives `submit`, `cancel`, and the host's answer
 * shortcuts. So the form stays mounted there and renders through a portal
 * into an anchor the `QuestionAnchor` composer banner provides; while it
 * does, styles.css hides the shell (it holds only the `ws-question-portaled`
 * marker). Without an anchor, as in a composer that shows no banners, the
 * form renders inside the shell as usual.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  useComposer,
  useRpc,
  experimental_useSidebarThreads,
  type PluginPendingInteractionProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { interactionPayloadSchema } from "../../server/questions/contracts.ts";
import { QuestionForm } from "./question-form.tsx";
import { usePendingQuestion } from "./pending.ts";
import type { RpcContract } from "../../server/contract.ts";
import type { JsonValue } from "@get-bb/plugin-sdk";

/** The recap card's frame (see RecapCard.tsx) in the attention accent. */
const CARD_CLASS =
  "@container/question relative mx-auto mb-3 w-full min-w-0 max-w-4xl rounded-lg border border-amber-400 bg-amber-50/40 px-4 py-3 text-foreground dark:border-amber-500/70 dark:bg-[color-mix(in_oklab,var(--background)_85%,oklch(27.9%_0.077_45.635))]";

/** Banner anchors by thread; one composer per thread shows banners. */
const anchors = new Map<string, HTMLElement>();
const listeners = new Set<() => void>();
function setAnchor(threadId: string, node: HTMLElement | null) {
  if (node) anchors.set(threadId, node);
  else if (anchors.has(threadId)) anchors.delete(threadId);
  else return;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function useAnchor(threadId: string): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => anchors.get(threadId) ?? null,
    () => null,
  );
}

/**
 * The composer banner that holds the card. It goes first in the stack, in
 * the recap card's place; the recap hides while a question is pending.
 */
export function QuestionAnchor() {
  const { scope } = useComposer();
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const pending = usePendingQuestion(threadId);
  const { threads } = experimental_useSidebarThreads();
  const native = threads.some(
    (t) => t.id === threadId && t.hasPendingInteraction,
  );
  const rpc = useRpc<RpcContract>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recover = async (
    value: Parameters<typeof rpc.call<"question_recover">>[1]["value"],
    dismiss: boolean,
  ) => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("question_recover", {
        threadId: pending.threadId,
        id: pending.id,
        value,
        dismiss,
      });
    } catch {
      setError("Could not send your answer. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      ref={(node) => {
        if (!threadId) return;
        setAnchor(threadId, node);
        return () => setAnchor(threadId, null);
      }}
      className="contents"
    >
      {pending?.recoverable && !native ? (
        <div
          className={CARD_CLASS}
          role="region"
          aria-label="Question"
          data-ws-question-card=""
        >
          <StateLine>Needs your answer · Restored after interruption</StateLine>
          <QuestionForm
            key={pending.id}
            persistenceKey={pending.id}
            composerKey={pending.id}
            questions={pending.payload.questions}
            disabled={busy}
            cancelDisabled={busy}
            onSubmit={(answers) => void recover({ answers }, false)}
            onCancel={() => void recover(null, true)}
          />
          {error ? <p role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function StateLine({ children }: { children: string }) {
  return (
    <p
      role="status"
      className="mb-0.5 text-[11px] font-medium leading-[1.6] text-amber-700 dark:text-amber-300"
    >
      {children}
    </p>
  );
}

export function QuestionInteraction({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const parsed = useMemo(
    () => interactionPayloadSchema.safeParse(interaction.payload),
    [interaction.payload],
  );
  const anchor = useAnchor(interaction.threadId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleCancel = () => {
    setBusy(true);
    setError(null);
    void cancel()
      .catch(() =>
        setError("Could not dismiss the question. Please try again."),
      )
      .finally(() => setBusy(false));
  };
  const alert = error ? (
    <p role="alert" className="mt-2 text-[11px] text-red-700 dark:text-red-300">
      {error}
    </p>
  ) : null;
  const body = parsed.success ? (
    <>
      <StateLine>Needs your answer</StateLine>
      <QuestionForm
        key={interaction.id}
        persistenceKey={
          typeof (interaction.payload as { durableId?: unknown }).durableId ===
          "string"
            ? (interaction.payload as { durableId: string }).durableId
            : undefined
        }
        composerKey={
          typeof (interaction.payload as { durableId?: unknown }).durableId ===
          "string"
            ? (interaction.payload as { durableId: string }).durableId
            : interaction.id
        }
        questions={parsed.data.questions}
        disabled={busy}
        cancelDisabled={busy}
        onSubmit={(answers) => {
          setBusy(true);
          setError(null);
          void submit(JSON.parse(JSON.stringify({ answers })) as JsonValue)
            .catch(() =>
              setError("Could not send your answer. Please try again."),
            )
            .finally(() => setBusy(false));
        }}
        onCancel={handleCancel}
      />
      {alert}
    </>
  ) : (
    <>
      <StateLine>Needs your answer</StateLine>
      <p className="text-[12.5px] text-muted-foreground">
        This question could not be displayed.
      </p>
      {alert}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        disabled={busy}
        onClick={handleCancel}
      >
        Cancel
      </Button>
    </>
  );
  if (!anchor) return <div className="text-foreground">{body}</div>;
  return (
    <>
      <span className="ws-question-portaled" hidden />
      {createPortal(
        <div
          className={CARD_CLASS}
          role="region"
          aria-label="Question"
          data-ws-question-card=""
          // First in the composer stack, like the recap card it replaces.
          style={{ order: -1 }}
        >
          {body}
        </div>,
        anchor,
      )}
    </>
  );
}
