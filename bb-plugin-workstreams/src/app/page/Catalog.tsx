import { useEffect, useId, useMemo, useState } from "react";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RpcContract } from "../../server/contract.ts";
import type { CatalogState, CorpusEntity } from "../../domain/corpus.ts";
import { corpusLabel } from "../../domain/corpus-label.ts";
import { compareGroupNames } from "../../domain/group-name-order.ts";
import {
  CreateEntityDialog,
  EditMetadataDialog,
  MergeEntityDialog,
  RenameEntityDialog,
  ReparentEntityDialog,
  type DialogState,
} from "./CatalogDialogs.tsx";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;

/**
 * The Topics tab: every topic Workstreams knows about, as a tree. It describes
 * topics only. Thread counts, workstreams, and classification state belong to
 * the sidebar and the thread's Topic control, never here.
 */
export type CatalogProps = {
  rpc: Rpc;
  serverCatalog?: CatalogState;
};

const topicPath = (id: string, entities: readonly CorpusEntity[]) =>
  corpusLabel(id, entities).replace(/: /g, " › ");

export function Catalog({ rpc, serverCatalog }: CatalogProps) {
  const [localCatalog, setLocalCatalog] = useState<CatalogState | null>(null);
  const [query, setQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeDialog, setActiveDialog] = useState<DialogState>(null);
  const [attempt, setAttempt] = useState(0);

  const searchInputId = useId();

  // Load catalog from server via RPC if not provided or to refresh
  const load = () => {
    setLoadError(null);
    rpc
      .call("catalog", null)
      .then((result) => {
        setLocalCatalog(result);
      })
      .catch((err) => {
        setLoadError(
          err instanceof Error ? err.message : "Couldn't load topics.",
        );
      });
  };

  useEffect(() => {
    if (!serverCatalog || !serverCatalog.entities.length) {
      load();
    }
  }, [rpc, attempt, serverCatalog]);

  const activeCatalog =
    serverCatalog && serverCatalog.entities.length
      ? serverCatalog
      : localCatalog;

  const entities = activeCatalog?.entities ?? [];

  const visible = useMemo(() => {
    const all = entities;
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

    // Keep ancestor path visible when children match search query
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
        if (matches.has(entity.id)) {
          rows.push({ entity, label: topicPath(entity.id, all), depth });
        }
        visit(entity.id, depth + 1);
      }
    };
    visit(null, 0);
    return rows;
  }, [entities, query]);

  const handleActionSuccess = () => {
    setActiveDialog(null);
    load();
  };

  return (
    <section className="mt-6" aria-label="Topics">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold">Topics</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Every topic Workstreams knows about. Each thread gets the most
            specific topic that fits it.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => setActiveDialog({ kind: "create", parentId: null })}
          className="mt-2 h-7 text-xs sm:mt-0"
        >
          <Icon name="Plus" className="mr-1 size-3.5" aria-hidden="true" />
          New topic
        </Button>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Input
          id={searchInputId}
          className="h-8 flex-1 text-sm"
          aria-label="Search topics"
          placeholder="Search topics by name, path, or alias…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setQuery("")}
            className="h-8 px-2 text-xs"
          >
            Clear
          </Button>
        ) : null}
      </div>

      {loadError ? (
        <div
          role="alert"
          className="mt-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
        >
          <p>{loadError}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 text-xs"
            onClick={() => setAttempt((v) => v + 1)}
          >
            Retry
          </Button>
        </div>
      ) : activeCatalog === null ? (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          Loading topics…
        </p>
      ) : !visible.length ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {entities.length ? "No matching topics" : "No topics yet"}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-md border border-border bg-card">
          {visible.map(({ entity, label, depth }) => {
            return (
              <li
                key={entity.id}
                className="p-3 transition-colors hover:bg-muted/30"
                style={{ paddingLeft: Math.max(12, depth * 20 + 12) }}
              >
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3
                        className="text-sm font-semibold text-foreground"
                        title={label}
                      >
                        {entity.name}
                      </h3>
                      {depth > 0 ? (
                        <span className="text-[11px] text-muted-foreground">
                          {label}
                        </span>
                      ) : null}
                    </div>

                    {entity.description ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {entity.description}
                      </p>
                    ) : null}

                    {entity.aliases.length ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        <span className="font-medium">Also known as:</span>{" "}
                        {entity.aliases.join(", ")}
                      </p>
                    ) : null}
                  </div>

                  {/* Topic actions */}
                  <div className="mt-2 flex flex-wrap items-center gap-1 sm:mt-0 sm:shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Add subtopic under ${entity.name}`}
                      onClick={() =>
                        setActiveDialog({ kind: "create", parentId: entity.id })
                      }
                      className="h-7 px-2 text-xs"
                    >
                      <Icon
                        name="Plus"
                        className="size-3 mr-1"
                        aria-hidden="true"
                      />
                      Add subtopic
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Rename ${entity.name}`}
                      onClick={() =>
                        setActiveDialog({ kind: "rename", entity })
                      }
                      className="h-7 px-2 text-xs"
                    >
                      Rename
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Move ${entity.name}`}
                      onClick={() =>
                        setActiveDialog({ kind: "reparent", entity })
                      }
                      className="h-7 px-2 text-xs"
                    >
                      Move
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Merge ${entity.name} into another topic`}
                      onClick={() => setActiveDialog({ kind: "merge", entity })}
                      className="h-7 px-2 text-xs"
                    >
                      Merge
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit details for ${entity.name}`}
                      onClick={() =>
                        setActiveDialog({ kind: "metadata", entity })
                      }
                      className="h-7 px-2 text-xs"
                    >
                      Edit details
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Dialog Modals */}
      {activeDialog?.kind === "create" ? (
        <CreateEntityDialog
          parentId={activeDialog.parentId}
          entities={entities}
          rpc={rpc}
          onSuccess={handleActionSuccess}
          onClose={() => setActiveDialog(null)}
        />
      ) : null}

      {activeDialog?.kind === "rename" ? (
        <RenameEntityDialog
          entity={activeDialog.entity}
          rpc={rpc}
          onSuccess={handleActionSuccess}
          onClose={() => setActiveDialog(null)}
        />
      ) : null}

      {activeDialog?.kind === "reparent" ? (
        <ReparentEntityDialog
          entity={activeDialog.entity}
          entities={entities}
          rpc={rpc}
          onSuccess={handleActionSuccess}
          onClose={() => setActiveDialog(null)}
        />
      ) : null}

      {activeDialog?.kind === "merge" ? (
        <MergeEntityDialog
          entity={activeDialog.entity}
          entities={entities}
          rpc={rpc}
          onSuccess={handleActionSuccess}
          onClose={() => setActiveDialog(null)}
        />
      ) : null}

      {activeDialog?.kind === "metadata" ? (
        <EditMetadataDialog
          entity={activeDialog.entity}
          rpc={rpc}
          onSuccess={handleActionSuccess}
          onClose={() => setActiveDialog(null)}
        />
      ) : null}
    </section>
  );
}
