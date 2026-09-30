import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { InspectButton } from "./InspectButton.tsx";

/** Thread header button (Debug mode): every model call about this thread. */
export function ThreadDebugButton({ threadId }: PluginThreadHeaderActionProps) {
  return (
    <InspectButton
      target={{ link: { kind: "thread", ref: threadId } }}
      title="Model calls for this thread"
      label="Inspect Workstreams model calls for this thread"
      className="size-7 rounded-md text-muted-foreground"
    />
  );
}
