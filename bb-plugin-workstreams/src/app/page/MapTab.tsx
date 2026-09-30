/**
 * The Map tab: the workstream editor (SPEC §7) and the one-time organizing
 * flow (§8).
 */
import { useEffect, useState } from "react";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { MapRecord } from "../../server/map.ts";
import { InspectButton } from "../debug/InspectButton.tsx";
import { primaryButton, secondaryButton } from "./controls.ts";
import { Organize } from "./Organize.tsx";

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
    <div className="mt-5 flex flex-col gap-6">
      <Organize rpc={rpc} bootstrapped={bootstrapped} />
      <section aria-label="Workstream map">
        <h2 className="border-b border-border pb-1 text-sm font-semibold">
          Workstreams
        </h2>
        <ul className="divide-y divide-border">
          {records.map((record) => (
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
    <li className="py-2 text-sm">
      <div className="flex items-baseline gap-2">
        <span className="font-medium">{record.name}</span>
        <span className="text-xs text-muted-foreground">
          {record.evidence.threadCount} thread
          {record.evidence.threadCount === 1 ? "" : "s"}
          {record.projects.length
            ? ` · ${record.projects.length} project${record.projects.length === 1 ? "" : "s"}`
            : ""}
          {record.createdBy === "workstreams"
            ? " · created by Workstreams"
            : ""}
        </span>
        <span className="flex-1" />
        {!editing ? (
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        ) : null}
      </div>
      {editing ? (
        <div className="mt-1.5 flex flex-col gap-1.5">
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
          <div className="flex gap-2">
            <button
              type="button"
              className={primaryButton}
              onClick={() => void save()}
            >
              Save
            </button>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {record.description ?? "No description yet."}
            {record.descriptionSource === "user" ? " (yours)" : ""}
            {record.description && record.descriptionSource === "generated" ? (
              <InspectButton
                target={{ link: { kind: "section", ref: record.sectionId } }}
                title={`Model calls for ${record.name}`}
                label="Inspect the model calls that described this workstream"
                className="ml-1 align-middle"
              />
            ) : null}
          </p>
          {record.subjects.length || record.aliases.length ? (
            <p className="mt-0.5 text-xs text-muted-foreground/80">
              {record.subjects.length
                ? `Subjects: ${record.subjects.join(", ")}`
                : ""}
              {record.subjects.length && record.aliases.length ? " · " : ""}
              {record.aliases.length
                ? `Also called: ${record.aliases.join(", ")}`
                : ""}
            </p>
          ) : null}
        </>
      )}
    </li>
  );
}
