import { useCallback, useEffect, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginSidebarSection,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { RpcContract } from "../../server/contract.ts";
import type { ProposalView } from "../../server/evolution.ts";
import type { JournalEntry } from "../../server/journal.ts";

const ACTION_LABEL: Record<JournalEntry["action"], string> = {
  move: "Move",
  "create-workstream": "New workstream",
  "rename-workstream": "Rename",
  "delete-workstream": "Delete",
  undo: "Undo",
  batch: "Reorganize",
  proposal: "Proposal",
  "edit-workstream": "Edit",
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

/**
 * The Activity log: every change Workstreams made or observed, and every
 * proposal (SPEC §11.5), with filters by workstream, action, and needs-review.
 */
export function Activity({
  rpc,
  proposals = [],
  focus = null,
  sections = [],
}: {
  rpc: ReturnType<typeof useRpc<RpcContract>>;
  proposals?: readonly ProposalView[];
  /** A proposal id to review first (deep link from a banner). */
  focus?: string | null;
  sections?: readonly PluginSidebarSection[];
}) {
  const navigate = useBbNavigate();
  const [external, setExternal] = useState(false);
  const [workstream, setWorkstream] = useState("");
  const [action, setAction] = useState("");
  const [needsReview, setNeedsReview] = useState(focus !== null);
  const proposalOf = new Map(
    proposals.filter((p) => p.entryId).map((p) => [p.entryId!, p]),
  );
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

  const decide = async (id: string, verdict: "accept" | "dismiss") => {
    setError(null);
    try {
      await rpc.call("proposal", { id, action: verdict });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const shown = (entries ?? []).filter(
    (entry) =>
      (!workstream || entry.workstreams.some((w) => w.id === workstream)) &&
      (!action || entry.action === action) &&
      (!needsReview || entry.status === "pending"),
  );
  const days: { label: string; entries: JournalEntry[] }[] = [];
  for (const entry of shown) {
    const label = day(entry.at);
    const last = days[days.length - 1];
    if (last?.label === label) last.entries.push(entry);
    else days.push({ label, entries: [entry] });
  }

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <select
          aria-label="Filter by workstream"
          value={workstream}
          onChange={(event) => setWorkstream(event.target.value)}
          className="h-7 rounded-md border border-input bg-transparent px-1"
        >
          <option value="">All workstreams</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by action"
          value={action}
          onChange={(event) => setAction(event.target.value)}
          className="h-7 rounded-md border border-input bg-transparent px-1"
        >
          <option value="">All actions</option>
          {Object.entries(ACTION_LABEL).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={needsReview}
            onChange={(event) => setNeedsReview(event.target.checked)}
          />
          Needs review
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={external}
            onChange={(event) => setExternal(event.target.checked)}
          />
          Include changes made outside Workstreams
        </label>
      </div>
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
                  (entry.status === "undone" || entry.status === "dismissed") &&
                    "opacity-60",
                  focus !== null &&
                    proposalOf.get(entry.id)?.id === focus &&
                    "rounded-md bg-state-hover",
                )}
              >
                <time
                  className="w-16 shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
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
                <span className="w-24 shrink-0 text-right text-xs">
                  {entry.status === "pending" && proposalOf.get(entry.id) ? (
                    <span className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          void decide(proposalOf.get(entry.id)!.id, "accept")
                        }
                        className="text-primary hover:underline"
                      >
                        {proposalOf.get(entry.id)!.accept}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void decide(proposalOf.get(entry.id)!.id, "dismiss")
                        }
                        className="text-muted-foreground hover:underline"
                      >
                        Not now
                      </button>
                    </span>
                  ) : entry.status === "pending" ? (
                    <span className="text-muted-foreground">pending</span>
                  ) : entry.status === "dismissed" ? (
                    <span className="text-muted-foreground">dismissed</span>
                  ) : entry.status === "undone" ? (
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
