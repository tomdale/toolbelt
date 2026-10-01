/** Metadata that keeps hidden inference workers out of interactive agent behavior. */
export const WORKER_THREAD_MARKER = {
  key: "workstreamsWorker",
  value: true,
} as const;

export function isWorkstreamsWorker(
  metadata: Readonly<Record<string, unknown>>,
): boolean {
  return metadata[WORKER_THREAD_MARKER.key] === WORKER_THREAD_MARKER.value;
}
