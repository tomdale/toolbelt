import type { ReactNode } from "react";

/** Header wrapper: workstreams are derived automatically, manual group actions are removed. */
export function GroupMenu({
  children,
}: {
  onRename?: () => void;
  onNewThread?: () => void;
  priority?: { prioritized: boolean; toggle: () => void };
  children: ReactNode;
}) {
  return <>{children}</>;
}
