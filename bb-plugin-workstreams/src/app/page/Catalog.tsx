import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { CorpusEntity } from "../../domain/corpus.ts";
import { corpusLabel } from "../../domain/corpus-label.ts";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;

export function Catalog({ rpc }: { rpc: Rpc }) {
  const [entries, setEntries] = useState<CorpusEntity[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    rpc
      .call("corpus", null)
      .then((result) => {
        if (live) setEntries(result.entities);
      })
      .catch((error) => {
        if (live)
          setError(
            error instanceof Error ? error.message : "Could not load Catalog",
          );
      });
    return () => {
      live = false;
    };
  }, [rpc, attempt]);
  const visible = useMemo(() => {
    const all = entries ?? [];
    const needle = query.trim().toLowerCase();
    return all
      .map((entity) => ({ entity, label: corpusLabel(entity.id, all) }))
      .filter(
        ({ entity, label }) =>
          !needle ||
          [label, entity.description, ...entity.aliases].some((text) =>
            text.toLowerCase().includes(needle),
          ),
      )
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [entries, query]);
  return (
    <section className="mt-6" aria-label="Catalog">
      <h2 className="text-sm font-medium">Catalog</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        All known products and features, including those without a current
        workstream. Browsing does not activate or move work.
      </p>
      <input
        className="mt-4 h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm"
        aria-label="Search products and features"
        placeholder="Search products and features…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error ? (
        <div role="alert" className="mt-4 text-sm">
          <p>{error}</p>
          <button
            type="button"
            className="mt-2 underline"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      ) : entries === null ? (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          Loading Catalog…
        </p>
      ) : !visible.length ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {entries.length
            ? "No matching products or features"
            : "No products or features have been recorded yet"}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {visible.map(({ entity, label }) => (
            <li key={entity.id} className="py-3">
              <h3 className="text-sm font-medium">{label}</h3>
              {entity.description ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {entity.description}
                </p>
              ) : null}
              {entity.aliases.length ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Also known as: {entity.aliases.join(", ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
