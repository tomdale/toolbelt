/** Debug mode (SPEC §11.6): the preference and what an inspector can open. */
import type { TraceLink } from "../../domain/trace.ts";
import { usePrefs } from "../prefs.ts";

/** Whether debug is on; inspect buttons render only then. */
export function useDebugMode(): boolean {
  const { prefs } = usePrefs();
  return prefs?.advanced.debug ?? false;
}

/**
 * What an inspector shows: specific traces (a decision's own call), or every
 * call linked to a thread, journal entry, proposal, workstream, or run.
 */
export type InspectTarget =
  { traceIds: readonly (string | null | undefined)[] } | { link: TraceLink };

export const traceIdsOf = (target: InspectTarget): string[] | null =>
  "traceIds" in target
    ? target.traceIds.filter((id): id is string => Boolean(id))
    : null;
