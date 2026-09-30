import { useEffect, useState } from "react";

/** Quiet time before a cleared composer counts as idle again. */
export const RETURN_DELAY_MS = 300;
/** How long a submitted message may take to start its run. */
export const RUN_START_GRACE_MS = 5_000;

/**
 * Whether the user is continuing the thread: drafting, submitting, or
 * waiting on a run. It turns on at once and off only after a quiet beat,
 * because BB's composer reports brief idle gaps while a message is sent. The
 * draft clears a tick before the send is pending, and the send settles
 * before the thread reports its run. After a submit, it stays on until the
 * run starts (or RUN_START_GRACE_MS passes without one), so a card hidden
 * for the message doesn't flash back in between.
 */
export function useContinuing({
  drafting,
  isSubmitting,
  isRunning,
}: {
  drafting: boolean;
  isSubmitting: boolean;
  isRunning: boolean;
}): boolean {
  const active = drafting || isSubmitting || isRunning;
  const [continuing, setContinuing] = useState(active);
  const [awaitingRun, setAwaitingRun] = useState(false);
  // Adjusted during render, so no commit ever shows the raw idle gap. The
  // host can report submitting and running at once (a send into a thread
  // that is starting its run), so the two conditions must be exclusive or
  // these updates would undo each other on every render.
  const waiting = isSubmitting && !isRunning;
  if (active && !continuing) setContinuing(true);
  if (waiting && !awaitingRun) setAwaitingRun(true);
  if (isRunning && awaitingRun) setAwaitingRun(false);

  useEffect(() => {
    if (active || !continuing) return;
    const timer = setTimeout(
      () => {
        setContinuing(false);
        setAwaitingRun(false);
      },
      awaitingRun ? RUN_START_GRACE_MS : RETURN_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [active, awaitingRun, continuing]);

  return active || continuing;
}
