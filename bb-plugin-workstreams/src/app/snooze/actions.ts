import { toast } from "sonner";
import { describeWake, type ThreadSnooze } from "../../domain/snooze.ts";

type SnoozeTarget = { id: string; latestAttentionAt?: number };

/** `useServerState().setSnooze`: snooze until a time or activity, or wake. */
export type SetSnooze = (
  thread: SnoozeTarget,
  until: number | null | "wake",
) => Promise<void>;

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Snoozes a thread and confirms it in a toast with Undo, because the row
 * leaves view at once. Undo restores the earlier snooze, or wakes it.
 */
export function snoozeThread(
  setSnooze: SetSnooze,
  thread: SnoozeTarget,
  until: number | null,
  previous?: ThreadSnooze,
): void {
  setSnooze(thread, until).then(
    () =>
      toast(`Snoozed ${describeWake(until, Date.now())}`, {
        action: {
          label: "Undo",
          onClick: () => {
            setSnooze(thread, previous ? previous.until : "wake").catch(
              (cause: unknown) => toast.error(message(cause)),
            );
          },
        },
      }),
    (cause: unknown) => toast.error(message(cause)),
  );
}

export function wakeThread(setSnooze: SetSnooze, thread: SnoozeTarget): void {
  setSnooze(thread, "wake").catch((cause: unknown) =>
    toast.error(message(cause)),
  );
}
