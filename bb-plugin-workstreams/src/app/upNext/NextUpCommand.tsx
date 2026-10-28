import { useEffect, useMemo } from "react";
import {
  experimental_useSidebarThreadActions,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { nextUpNextThread } from "../../domain/archiveNavigation.ts";
import type { Projection } from "../../domain/project.ts";
import type { UpNextKind } from "../../domain/status.ts";
import { useWorkstreams } from "../useWorkstreams.ts";

let current: {
  projection: Projection<PluginSidebarThread>;
  kindOf: (thread: PluginSidebarThread) => UpNextKind;
  prioritized: readonly string[];
  open: (threadId: string) => void;
} | null = null;

/** The app-wide command reads the live projection and uses BB's sidebar flow. */
export function NextUpCommandBridge(): null {
  const { projection, upNextKind, server } = useWorkstreams();
  const actions = experimental_useSidebarThreadActions();
  const prioritized = server.order.prioritized;
  const bridge = useMemo(
    () => ({
      projection,
      kindOf: upNextKind,
      prioritized,
      open: (threadId: string) => actions.open(threadId),
    }),
    [projection, upNextKind, prioritized, actions],
  );
  current = bridge;
  useEffect(() => {
    return () => {
      if (current === bridge) current = null;
    };
  }, [bridge]);
  return null;
}

export function openNextUpThread(threadId: string | null): void {
  const next = current
    ? nextUpNextThread(
        current.projection,
        threadId,
        current.kindOf,
        current.prioritized,
      )?.thread.id
    : null;
  if (next) current?.open(next);
}
