/**
 * The Map tab: the workstream editor (SPEC §7) and the one-time organizing
 * flow (§8): propose a map, review it, assign threads, preview, apply.
 */
import { useEffect, useState } from "react";
import { useRealtime, type useRpc } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { RpcContract } from "../../server/contract.ts";
import type { BootstrapState } from "../../server/bootstrap.ts";
import type { MapRecord } from "../../server/map.ts";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;

const button =
  "rounded-md border border-border px-2.5 py-1 text-xs hover:bg-state-hover disabled:opacity-50";
const primary =
  "rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50";

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
              className={primary}
              onClick={() => void save()}
            >
              Save
            </button>
            <button
              type="button"
              className={button}
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

type Change = BootstrapState["changes"][number] & {
  workstream?: string;
  into?: string;
  name?: string;
  description?: string;
  reason?: string;
};

function describeChange(change: Change): string {
  if (change.kind === "rename")
    return `Rename ${change.workstream} to ${change.name}`;
  if (change.kind === "merge")
    return `Merge ${change.workstream} into ${change.into}`;
  return `New workstream ${change.name}`;
}

/** The one-time organizing flow; also reachable later as "Reorganize…". */
function Organize({ rpc, bootstrapped }: { rpc: Rpc; bootstrapped: boolean }) {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());
  const call = async (
    input: Parameters<Rpc["call"]>[1] & { action: string },
  ) => {
    setError(null);
    try {
      const result = await rpc.call("bootstrap", input as never);
      setState(result.state as BootstrapState | null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => {
    void call({ action: "get" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useRealtime("changed", () => void call({ action: "get" }));
  // Model steps report progress through realtime "changed"; poll lightly too.
  const working =
    state?.status === "proposing" ||
    state?.status === "assigning" ||
    state?.status === "applying";
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void call({ action: "get" });
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working]);

  const elapsed = state ? Math.round((now - state.startedAt) / 1000) : 0;
  // Time the machine spent, not time spent waiting on review.
  const machine = state
    ? (
        state.seconds.intake +
        state.seconds.map +
        state.seconds.assign +
        state.seconds.apply
      ).toFixed(1)
    : "0";
  const shell = (children: React.ReactNode) => (
    <section
      aria-label="Organize"
      className="rounded-lg border border-border p-3 text-sm"
    >
      {children}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );

  if (!state || state.status === "applied")
    return shell(
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {bootstrapped
              ? "Reorganize workstreams"
              : "Organize your workstreams"}
          </p>
          <p className="text-xs text-muted-foreground">
            {state?.status === "applied"
              ? `Organized in ${Math.round((state.updatedAt - state.startedAt) / 1000)}s.${state.error ? ` ${state.error}` : ""} Undo it from Activity.`
              : bootstrapped
                ? "Propose a fresh map and re-file threads Workstreams filed. Threads you filed stay put."
                : "One pass: propose a map, review it, file threads, and preview before anything moves. Workstreams keeps things current after that."}
          </p>
        </div>
        <button
          type="button"
          className={primary}
          onClick={() => void call({ action: "start" })}
        >
          {bootstrapped ? "Reorganize…" : "Organize…"}
        </button>
        {!bootstrapped ? (
          <button
            type="button"
            className={button}
            onClick={() => void call({ action: "skip" })}
          >
            Skip
          </button>
        ) : null}
      </div>,
    );

  if (working)
    return shell(
      <p className="text-muted-foreground">
        {state.status === "proposing"
          ? "Proposing a workstream map…"
          : state.status === "assigning"
            ? "Filing threads…"
            : "Applying…"}{" "}
        <span className="tabular-nums">{elapsed}s</span>
      </p>,
    );

  if (state.status === "failed")
    return shell(
      <div className="flex items-center gap-3">
        <p className="flex-1 text-destructive">
          {state.error ?? "Organizing failed."}
        </p>
        <button
          type="button"
          className={button}
          onClick={() => void call({ action: "start" })}
        >
          Start over
        </button>
        <button
          type="button"
          className={button}
          onClick={() => void call({ action: "cancel" })}
        >
          Cancel
        </button>
      </div>,
    );

  if (state.status === "review") {
    const changes = state.changes as Change[];
    return shell(
      <>
        <p className="font-medium">Review the map</p>
        <p className="text-xs text-muted-foreground">
          {state.roots.length} threads ·{" "}
          {state.roots.filter((r) => r.provenance !== "user").length} to file
          (unfiled or filed automatically) · proposed in {machine}s
        </p>
        <ul className="mt-2 flex flex-col gap-1">
          {changes.length === 0 ? (
            <li className="text-xs text-muted-foreground">
              No map changes proposed.
            </li>
          ) : null}
          {changes.map((change) => (
            <li key={change.id}>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={decisions[change.id] ?? change.accepted}
                  onChange={(event) =>
                    setDecisions({
                      ...decisions,
                      [change.id]: event.target.checked,
                    })
                  }
                  className="mt-1"
                />
                <span>
                  {describeChange(change)}
                  {change.reason ? (
                    <span className="block text-xs text-muted-foreground">
                      {change.reason}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
        {Object.keys(state.descriptions).length ? (
          <details className="mt-2 text-xs text-muted-foreground">
            <summary>
              Descriptions ({Object.keys(state.descriptions).length})
            </summary>
            <ul className="mt-1">
              {Object.entries(state.descriptions).map(([name, text]) => (
                <li key={name}>
                  <span className="text-foreground">{name}</span>: {text}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            className={primary}
            onClick={() =>
              void call({
                action: "assign",
                decisions: changes.map((c) => ({
                  id: c.id,
                  accepted: decisions[c.id] ?? c.accepted,
                })),
              })
            }
          >
            File threads
          </button>
          <button
            type="button"
            className={button}
            onClick={() => void call({ action: "cancel" })}
          >
            Cancel
          </button>
        </div>
      </>,
    );
  }

  const preview = state.preview!;
  const accepted = (threadId: string, fallback: boolean) =>
    overrides[threadId] ?? fallback;
  const count = preview.moves.filter((m) =>
    accepted(m.threadId, m.accepted),
  ).length;
  const byTarget = new Map<string, typeof preview.moves>();
  for (const move of preview.moves)
    byTarget.set(move.toName, [...(byTarget.get(move.toName) ?? []), move]);
  return shell(
    <>
      <p className="font-medium">Preview</p>
      <p className="text-xs text-muted-foreground">
        {preview.creates.length
          ? `New: ${preview.creates.map((c) => c.name).join(", ")} · `
          : ""}
        {preview.renames.length
          ? `Renamed: ${preview.renames.map((r) => `${r.from} → ${r.to}`).join(", ")} · `
          : ""}
        prepared in {machine}s
      </p>
      {[...byTarget].map(([target, moves]) => (
        <div key={target} className="mt-2">
          <p className="text-xs font-semibold">{target}</p>
          <ul>
            {moves.map((move) => (
              <li key={move.threadId}>
                <label className="flex items-baseline gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={accepted(move.threadId, move.accepted)}
                    onChange={(event) =>
                      setOverrides({
                        ...overrides,
                        [move.threadId]: event.target.checked,
                      })
                    }
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      !accepted(move.threadId, move.accepted) &&
                        "text-muted-foreground",
                    )}
                  >
                    {move.title}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    from {move.fromName} · {move.reason}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {preview.unsure.length ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Left where they are (unsure):{" "}
          {preview.unsure.map((u) => u.title).join("; ")}
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className={primary}
          disabled={
            count === 0 &&
            preview.creates.length === 0 &&
            preview.renames.length === 0
          }
          onClick={() =>
            void call({
              action: "apply",
              overrides: Object.entries(overrides).map(([threadId, value]) => ({
                threadId,
                accepted: value,
              })),
            })
          }
        >
          Apply {count} move{count === 1 ? "" : "s"}
        </button>
        <button
          type="button"
          className={button}
          onClick={() => void call({ action: "cancel" })}
        >
          Cancel
        </button>
      </div>
    </>,
  );
}
