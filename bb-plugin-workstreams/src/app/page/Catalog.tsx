import { useEffect, useId, useMemo, useState } from "react";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import type {
  PluginSidebarSection,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RpcContract } from "../../server/contract.ts";
import type {
  CanonicalAssignment,
  CatalogState,
  CorpusEntity,
} from "../../domain/corpus.ts";
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

export type CatalogProps = {
  rpc: Rpc;
  serverCatalog?: CatalogState;
  sections?: readonly PluginSidebarSection[];
  threads?: readonly PluginSidebarThread[];
  navigate?: { toThread: (threadId: string) => void };
};

export function Catalog({
  rpc,
  serverCatalog,
  sections = [],
  threads = [],
  navigate,
}: CatalogProps) {
  const [localCatalog, setLocalCatalog] = useState<CatalogState | null>(null);
  const [query, setQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeDialog, setActiveDialog] = useState<DialogState>(null);
  const [expandedTasks, setExpandedTasks] = useState<Record<string, boolean>>(
    {},
  );
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
          err instanceof Error ? err.message : "Could not load Catalog",
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
  const assignments = activeCatalog?.assignments ?? {};
  const groups = activeCatalog?.groups ?? {};

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
          rows.push({ entity, label: corpusLabel(entity.id, all), depth });
        }
        visit(entity.id, depth + 1);
      }
    };
    visit(null, 0);
    return rows;
  }, [entities, query]);

  // Map section IDs to Workstream names for context
  const workstreamNameBySectionId = useMemo(() => {
    const map = new Map<string, string>();
    for (const section of sections) {
      map.set(section.id, section.name);
    }
    return map;
  }, [sections]);

  // Group assignments by entityId with root and child counts separated
  const assignmentsByEntity = useMemo(() => {
    const map = new Map<
      string,
      { root: CanonicalAssignment[]; child: CanonicalAssignment[] }
    >();
    for (const assignment of Object.values(assignments)) {
      if (!assignment.entityId || assignment.status !== "assigned") continue;
      const bucket = map.get(assignment.entityId) ?? { root: [], child: [] };
      if (assignment.inheritedFrom) {
        bucket.child.push(assignment);
      } else {
        bucket.root.push(assignment);
      }
      map.set(assignment.entityId, bucket);
    }
    return map;
  }, [assignments]);

  const toggleTasks = (entityId: string) => {
    setExpandedTasks((prev) => ({ ...prev, [entityId]: !prev[entityId] }));
  };

  const handleActionSuccess = () => {
    setActiveDialog(null);
    load();
  };

  return (
    <section className="mt-6" aria-label="Catalog">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Catalog</h2>
            {activeCatalog?.revision ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                rev {activeCatalog.revision}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            All known products and features, including those without a current
            workstream. Retained inactive identities remain searchable.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => setActiveDialog({ kind: "create", parentId: null })}
          className="mt-2 h-7 text-xs sm:mt-0"
        >
          <Icon name="Plus" className="mr-1 size-3.5" aria-hidden="true" />
          New product or feature
        </Button>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Input
          id={searchInputId}
          className="h-8 flex-1 text-sm"
          aria-label="Search products and features"
          placeholder="Search products and features by name, full path, or alias…"
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
          Loading Catalog…
        </p>
      ) : !visible.length ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {entities.length
            ? "No matching products or features found"
            : "No products or features have been recorded yet"}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-md border border-border bg-card">
          {visible.map(({ entity, label, depth }) => {
            const taskCounts = assignmentsByEntity.get(entity.id) ?? {
              root: [],
              child: [],
            };
            const rootCount = taskCounts.root.length;
            const childCount = taskCounts.child.length;
            const totalTasks = rootCount + childCount;
            const areTasksExpanded = Boolean(expandedTasks[entity.id]);

            // Workstream context from group bindings
            const boundSectionId = Object.entries(groups).find(
              ([_, entId]) => entId === entity.id,
            )?.[0];
            const boundWorkstreamName = boundSectionId
              ? (workstreamNameBySectionId.get(boundSectionId) ??
                boundSectionId)
              : null;

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
                          ({label.replace(/: /g, " › ")})
                        </span>
                      ) : null}
                      {boundWorkstreamName ? (
                        <span className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                          <Icon
                            name="Folder"
                            className="size-2.5"
                            aria-hidden="true"
                          />
                          Home: {boundWorkstreamName} (derived)
                        </span>
                      ) : (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Retained (no active workstream)
                        </span>
                      )}
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

                    {/* Related tasks with root / child counts separated */}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-muted-foreground">Tasks:</span>
                      <span className="font-medium text-foreground">
                        {rootCount} root, {childCount} child
                      </span>

                      {totalTasks > 0 ? (
                        <button
                          type="button"
                          onClick={() => toggleTasks(entity.id)}
                          className="text-[11px] text-primary underline hover:text-primary/80"
                          aria-expanded={areTasksExpanded}
                        >
                          {areTasksExpanded
                            ? "Hide related tasks"
                            : "Show related tasks"}
                        </button>
                      ) : null}
                    </div>

                    {/* Expandable related tasks navigation list */}
                    {areTasksExpanded && totalTasks > 0 ? (
                      <ul
                        className="mt-2 space-y-1 rounded border border-border bg-background p-2 text-xs"
                        aria-label={`Tasks related to ${entity.name}`}
                      >
                        {[...taskCounts.root, ...taskCounts.child].map(
                          (assignment) => {
                            const thread = threads.find(
                              (t) => t.id === assignment.threadId,
                            );
                            const threadTitle =
                              thread?.displayTitle ??
                              thread?.title ??
                              assignment.threadId;
                            const isChild = Boolean(assignment.inheritedFrom);

                            return (
                              <li
                                key={assignment.threadId}
                                className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-muted"
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    navigate?.toThread(assignment.threadId)
                                  }
                                  className="flex-1 truncate text-left text-xs font-medium text-primary hover:underline"
                                  title={`Open thread: ${threadTitle}`}
                                >
                                  {threadTitle}
                                </button>
                                <span className="shrink-0 text-[10px] text-muted-foreground">
                                  {isChild ? "child (inherited)" : "root task"}
                                </span>
                              </li>
                            );
                          },
                        )}
                      </ul>
                    ) : null}
                  </div>

                  {/* Explicit Catalog Maintenance Actions */}
                  <div className="mt-2 flex flex-wrap items-center gap-1 sm:mt-0 sm:shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Add child feature under ${entity.name}`}
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
                      Add child
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
                      aria-label={`Reparent ${entity.name}`}
                      onClick={() =>
                        setActiveDialog({ kind: "reparent", entity })
                      }
                      className="h-7 px-2 text-xs"
                    >
                      Reparent
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Merge ${entity.name} into another entity`}
                      onClick={() => setActiveDialog({ kind: "merge", entity })}
                      className="h-7 px-2 text-xs"
                    >
                      Merge
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit metadata for ${entity.name}`}
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
