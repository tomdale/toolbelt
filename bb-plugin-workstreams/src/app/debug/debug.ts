/** Debug mode (SPEC §11.6): the setting and what an inspector can open. */
import { useSettings } from "@get-bb/plugin-sdk/app";
import type { TraceLink } from "../../domain/trace.ts";

/** Whether the `debug` setting is on; inspect buttons render only then. */
export function useDebugMode(): boolean {
  const { values } = useSettings();
  return (values as Record<string, unknown> | undefined)?.debug === true;
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
