import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../../server/contract.ts";
import type { CorpusEntity } from "../../domain/corpus.ts";
import { corpusLabel } from "../../domain/corpus-label.ts";
import { compareGroupNames } from "../../domain/group-name-order.ts";

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
    const matches = new Set(
      all
        .filter(
          (entity) =>
            !needle ||
            [
              corpusLabel(entity.id, all),
              entity.description,
              ...entity.aliases,
            ].some((text) => text.toLowerCase().includes(needle)),
        )
        .map((entity) => entity.id),
    );
    for (const id of [...matches]) {
      let parent = all.find((entity) => entity.id === id)?.parentId;
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        matches.add(parent);
        parent = all.find((entity) => entity.id === parent)?.parentId;
      }
    }
    const rows: { entity: CorpusEntity; label: string; depth: number }[] = [];
    const visit = (parentId: string | null, depth: number) => {
      for (const entity of all
        .filter((e) => e.parentId === parentId)
        .sort((a, b) => compareGroupNames(a.name, b.name))) {
        if (matches.has(entity.id))
          rows.push({ entity, label: corpusLabel(entity.id, all), depth });
        visit(entity.id, depth + 1);
      }
    };
    visit(null, 0);
    return rows;
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
          {visible.map(({ entity, label, depth }) => (
            <li
              key={entity.id}
              className="py-2"
              style={{ paddingLeft: depth * 20 }}
            >
              <h3 className="text-sm font-medium" title={label}>
                {entity.name}
              </h3>
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
