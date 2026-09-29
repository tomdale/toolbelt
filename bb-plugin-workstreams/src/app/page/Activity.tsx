import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { RpcContract } from "../../server/contract.ts";
import type { JournalEntry } from "../../server/journal.ts";

const ACTION_LABEL: Record<JournalEntry["action"], string> = {
  move: "Move",
  "create-workstream": "New workstream",
  "rename-workstream": "Rename",
  "delete-workstream": "Delete",
  undo: "Undo",
};

const SOURCE_LABEL: Record<JournalEntry["source"], string> = {
  user: "you",
  external: "outside Workstreams",
  router: "router",
  handoff: "handoff",
  auto: "automatic",
  proposal: "proposal",
  bootstrap: "bootstrap",
};

function day(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** The Activity log: every change Workstreams made or observed (SPEC §11.5). */
export function Activity({
  rpc,
}: {
  rpc: ReturnType<typeof useRpc<RpcContract>>;
}) {
  const navigate = useBbNavigate();
  const [external, setExternal] = useState(false);
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const result = await rpc.call("journal", { limit: 300, external });
      setEntries(result.entries);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc, external]);
  useRealtime("changed", load);
  useEffect(() => {
    void load();
  }, [load]);

  const undo = async (entry: JournalEntry) => {
    setError(null);
    try {
      await rpc.call("undo", { entryId: entry.id });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const days: { label: string; entries: JournalEntry[] }[] = [];
  for (const entry of entries ?? []) {
    const label = day(entry.at);
    const last = days[days.length - 1];
    if (last?.label === label) last.entries.push(entry);
    else days.push({ label, entries: [entry] });
  }

  return (
    <div className="mt-5">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={external}
          onChange={(event) => setExternal(event.target.checked)}
        />
        Include changes made outside Workstreams
      </label>
      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {entries && entries.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No activity yet.</p>
      ) : null}
      {days.map(({ label, entries: list }) => (
        <section key={label} className="mt-4">
          <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
            {label}
          </h3>
          <ul className="divide-y divide-border">
            {list.map((entry) => (
              <li
                key={entry.id}
                className={cn(
                  "flex items-baseline gap-3 py-1.5 text-sm",
                  entry.status === "undone" && "opacity-60",
                )}
              >
                <time
                  className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground"
                  dateTime={new Date(entry.at).toISOString()}
                  title={new Date(entry.at).toLocaleString()}
                >
                  {new Date(entry.at).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                <span className="w-28 shrink-0 text-xs text-muted-foreground">
                  {ACTION_LABEL[entry.action]}
                </span>
                <span className="min-w-0 flex-1">
                  <span>{entry.rationale}</span>
                  {entry.threads.map((thread) => (
                    <button
                      key={thread.id}
                      type="button"
                      onClick={() => navigate.toThread(thread.id)}
                      className="ml-2 max-w-64 truncate align-bottom text-xs text-primary hover:underline"
                    >
                      {thread.name}
                    </button>
                  ))}
                  {entry.detail ? (
                    <span className="block text-xs text-muted-foreground">
                      {entry.detail}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {SOURCE_LABEL[entry.source]}
                </span>
                <span className="w-14 shrink-0 text-right text-xs">
                  {entry.status === "undone" ? (
                    <span className="text-muted-foreground">undone</span>
                  ) : entry.undo ? (
                    <button
                      type="button"
                      onClick={() => void undo(entry)}
                      className="text-primary hover:underline"
                    >
                      Undo
                    </button>
                  ) : entry.status === "partial" ? (
                    <span className="text-muted-foreground">partial</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
