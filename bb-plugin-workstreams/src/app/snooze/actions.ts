import { toast } from "sonner";
import { describeWake, type ThreadSnooze } from "../../domain/snooze.ts";

type SnoozeTarget = { id: string; latestAttentionAt?: number };

/**
 * `useServerState().setSnoozes`: snooze threads together until a time or
 * each one's next activity, or wake them.
 */
export type SetSnoozes = (
  threads: readonly SnoozeTarget[],
  until: number | null | "wake",
) => Promise<void>;

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Snoozes threads and confirms it in a toast with Undo, because their rows
 * leave view at once. Undo gives each thread back the snooze `previous`
 * reported for it before this one, or wakes it; `previous` is read before
 * the snooze is applied. `subject` names what was snoozed in the toast
 * ("4 threads in Alpha"); without it the toast reads "Snoozed until …".
 */
export function snoozeThreads<T extends SnoozeTarget>(
  setSnoozes: SetSnoozes,
  threads: readonly T[],
  until: number | null,
  {
    previous,
    subject,
  }: {
    previous?: (thread: T) => ThreadSnooze | undefined;
    subject?: string;
  } = {},
): void {
  const earlier = new Map<number | null | "wake", SnoozeTarget[]>();
  for (const thread of threads) {
    const snooze = previous?.(thread);
    const key = snooze ? snooze.until : "wake";
    earlier.set(key, [...(earlier.get(key) ?? []), thread]);
  }
  const undo = () => {
    for (const [restore, group] of earlier)
      setSnoozes(group, restore).catch((cause: unknown) =>
        toast.error(message(cause)),
      );
  };
  setSnoozes(threads, until).then(
    () =>
      toast(
        `Snoozed ${subject ? `${subject} ` : ""}${describeWake(until, Date.now())}`,
        { action: { label: "Undo", onClick: undo } },
      ),
    (cause: unknown) => toast.error(message(cause)),
  );
}

export function wakeThreads(
  setSnoozes: SetSnoozes,
  threads: readonly SnoozeTarget[],
): void {
  setSnoozes(threads, "wake").catch((cause: unknown) =>
    toast.error(message(cause)),
  );
}
