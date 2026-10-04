/**
 * The Organize tab: live derived workstreams projection and organizing flow.
 * Workstreams are derived automatically from active task identities.
 */
import type { useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { MapRecord } from "../../server/map.ts";
import { Organize } from "./Organize.tsx";
import { TaskIdentity } from "../task/TaskIdentity.tsx";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;

export function MapTab({
  rpc,
  bootstrapped,
  onShowActivity,
}: {
  rpc: Rpc;
  records?: MapRecord[];
  bootstrapped: boolean;
  onShowActivity?: () => void;
}) {
  return (
    <div className="mt-6">
      <Organize
        rpc={rpc}
        bootstrapped={bootstrapped}
        onShowActivity={onShowActivity}
        renderTaskAction={(task) => <TaskIdentity threadId={task.id} />}
      />
    </div>
  );
}
