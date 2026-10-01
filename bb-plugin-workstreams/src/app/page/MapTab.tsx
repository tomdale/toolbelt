/**
 * The Map tab: the workstream editor (SPEC §7) and the one-time organizing
 * flow (§8).
 */
import { useEffect, useState } from "react";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { MapRecord } from "../../server/map.ts";
import { InspectButton } from "../debug/InspectButton.tsx";
import { ghostButton, primaryButton } from "./controls.ts";
import { Organize } from "./Organize.tsx";
import { WorkstreamName } from "../WorkstreamName.tsx";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;

export function MapTab({
  rpc,
  records,
  bootstrapped,
}: {
  rpc: Rpc;
  records: MapRecord[];
  bootstrapped: boolean;
}) {
  return (
    <div className="mt-6 flex flex-col gap-8">
      <Organize rpc={rpc} bootstrapped={bootstrapped} />
      <section aria-label="Workstream map">
        <h2 className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">
          Current workstreams
        </h2>
        <ul>
          {[...records]
            .sort(
              (a, b) =>
                b.evidence.threadCount - a.evidence.threadCount ||
                a.name.localeCompare(b.name),
            )
            .map((record) => (
              <MapRow key={record.sectionId} rpc={rpc} record={record} />
            ))}
        </ul>
      </section>
    </div>
  );
}

function MapRow({ rpc, record }: { rpc: Rpc; record: MapRecord }) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(record.description ?? "");
  const [aliases, setAliases] = useState(record.aliases.join(", "));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (editing) return;
    setDescription(record.description ?? "");
    setAliases(record.aliases.join(", "));
  }, [record, editing]);
  const save = async () => {
    setError(null);
    try {
      await rpc.call("editWorkstream", {
        sectionId: record.sectionId,
        description: description.trim() || null,
        aliases: aliases
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
      });
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <li className="group/map rounded-md px-2 py-1.5 text-[13px] hover:bg-state-hover/50">
      <div className="flex items-baseline gap-2">
        <WorkstreamName
          name={record.name}
          muted={record.evidence.threadCount === 0}
          className="font-medium"
        />
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {record.evidence.threadCount || "Empty"}
        </span>
        <span className="flex-1" />
        {record.description && record.descriptionSource === "generated" ? (
          <InspectButton
            target={{ link: { kind: "section", ref: record.sectionId } }}
            title={`Model calls for ${record.name}`}
            label="Inspect the model calls that described this workstream"
            className="opacity-0 group-hover/map:opacity-60"
          />
        ) : null}
        {!editing ? (
          <button
            type="button"
            className="text-xs text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/map:opacity-100"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        ) : null}
      </div>
      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <label className="text-xs text-muted-foreground">
            Description
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={300}
              className="mt-0.5 block h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Aliases (comma-separated)
            <input
              value={aliases}
              onChange={(event) => setAliases(event.target.value)}
              className="mt-0.5 block h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
            />
          </label>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className={ghostButton}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={primaryButton}
              onClick={() => void save()}
            >
              Save
            </button>
          </div>
        </div>
      ) : record.description ? (
        <p className="truncate text-xs text-muted-foreground">
          {record.description}
        </p>
      ) : null}
    </li>
  );
}
