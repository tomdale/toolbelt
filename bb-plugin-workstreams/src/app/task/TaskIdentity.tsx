import React, { useId, useMemo, useState } from "react";
import { Icon } from "@/components/ui/icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSharedServerState } from "../serverState.ts";
import type { CanonicalAssignment, CorpusEntity } from "../../domain/corpus.ts";
import { corpusLabel } from "../../domain/corpus-label.ts";
import { compareGroupNames } from "../../domain/group-name-order.ts";
import { TAG_ICON } from "../workstream-icon.ts";

export type TaskIdentityBadgeProps = {
  label: string | null;
  status: "assigned" | "unresolved";
  isInherited?: boolean;
  provenance?: "manual" | "automatic" | null;
  isCompact?: boolean;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
};

export function TaskIdentityBadge({
  label,
  status,
  isInherited = false,
  isCompact = false,
  className = "",
  onClick,
  disabled = false,
}: TaskIdentityBadgeProps) {
  const isUnresolved = status === "unresolved" || !label;
  const displayLabel = isUnresolved ? "Unresolved" : label;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={`Product or feature: ${displayLabel}`}
      title={
        isUnresolved
          ? "No product or feature identified. Click to assign."
          : `Product or feature: ${displayLabel}${
              isInherited ? " (inherited from root task)" : ""
            }`
      }
      className={`ws-task-identity ${
        isUnresolved ? "ws-task-identity-unresolved" : ""
      } ${isCompact ? "ws-task-identity-compact" : ""} ${className}`}
    >
      <Icon
        name={isUnresolved ? "HelpCircle" : TAG_ICON}
        className="size-3.5 shrink-0 opacity-70"
        aria-hidden="true"
      />
      <span className="ws-task-identity-label">{displayLabel}</span>
      {isInherited && !isCompact ? (
        <span
          className="ws-task-identity-inherited"
          aria-label="Inherited from root task"
        >
          (inherited)
        </span>
      ) : null}
    </button>
  );
}

export type TaskIdentityPickerProps = {
  threadId?: string;
  assignment?: CanonicalAssignment | null;
  entities: readonly CorpusEntity[];
  onSelectEntity: (entityId: string) => Promise<void> | void;
  onClear?: () => Promise<void> | void;
  onReclassify?: () => Promise<void> | void;
  isMutating?: boolean;
  error?: string | null;
  onClose?: () => void;
};

export function TaskIdentityPicker({
  assignment,
  entities,
  onSelectEntity,
  onClear,
  onReclassify,
  isMutating = false,
  error: externalError,
  onClose,
}: TaskIdentityPickerProps) {
  const [search, setSearch] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const searchInputId = useId();

  const currentEntity = assignment?.entityId
    ? (entities.find((e) => e.id === assignment.entityId) ?? null)
    : null;

  const currentLabel = currentEntity
    ? corpusLabel(currentEntity.id, entities).replace(/: /g, " › ")
    : null;

  const isInherited = Boolean(assignment?.inheritedFrom);

  const error = externalError ?? localError;

  const filteredEntities = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) {
      return [...entities].sort((a, b) =>
        compareGroupNames(
          corpusLabel(a.id, entities),
          corpusLabel(b.id, entities),
        ),
      );
    }
    return entities
      .filter((entity) => {
        const fullLabel = corpusLabel(entity.id, entities);
        return (
          fullLabel.toLowerCase().includes(needle) ||
          entity.description.toLowerCase().includes(needle) ||
          entity.aliases.some((a) => a.toLowerCase().includes(needle))
        );
      })
      .sort((a, b) =>
        compareGroupNames(
          corpusLabel(a.id, entities),
          corpusLabel(b.id, entities),
        ),
      );
  }, [entities, search]);

  const handleSelect = async (entityId: string) => {
    setLocalError(null);
    setLoadingAction(entityId);
    try {
      await onSelectEntity(entityId);
      onClose?.();
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : "Failed to assign entity",
      );
    } finally {
      setLoadingAction(null);
    }
  };

  const handleClear = async () => {
    if (!onClear) return;
    setLocalError(null);
    setLoadingAction("clear");
    try {
      await onClear();
      onClose?.();
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : "Failed to clear assignment",
      );
    } finally {
      setLoadingAction(null);
    }
  };

  const handleReclassify = async () => {
    if (!onReclassify) return;
    setLocalError(null);
    setLoadingAction("reclassify");
    try {
      await onReclassify();
      onClose?.();
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : "Failed to reclassify task",
      );
    } finally {
      setLoadingAction(null);
    }
  };

  return (
    <div className="flex w-80 flex-col gap-3 p-3 text-popover-foreground">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Product / Feature Identity
        </h4>
        {isInherited ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            Inherited from root
          </span>
        ) : null}
      </div>

      <div className="rounded-md border border-border bg-muted/40 p-2 text-xs">
        <div className="flex items-center justify-between font-medium">
          <span className="text-muted-foreground">Current:</span>
          <span
            className={
              currentLabel
                ? "font-semibold text-foreground"
                : "italic text-muted-foreground"
            }
          >
            {currentLabel ?? "Unresolved"}
          </span>
        </div>
        {currentEntity?.description ? (
          <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
            {currentEntity.description}
          </p>
        ) : null}
        {assignment?.provenance ? (
          <div className="mt-1 text-[10px] text-muted-foreground">
            Provenance:{" "}
            {assignment.provenance === "manual"
              ? "Manually assigned"
              : "Automatically classified"}
          </div>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md bg-destructive/10 p-2 text-xs text-destructive"
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center gap-1.5">
        <Input
          id={searchInputId}
          placeholder="Search catalog…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 text-xs"
          aria-label="Search products and features"
        />
      </div>

      <div className="max-h-52 overflow-y-auto rounded-md border border-border divide-y divide-border/60">
        {filteredEntities.length === 0 ? (
          <div className="p-3 text-center text-xs text-muted-foreground">
            No matching products or features found.
          </div>
        ) : (
          filteredEntities.map((entity) => {
            const label = corpusLabel(entity.id, entities).replace(
              /: /g,
              " › ",
            );
            const isSelected = entity.id === currentEntity?.id;
            const isLoading = loadingAction === entity.id || isMutating;

            return (
              <button
                key={entity.id}
                type="button"
                disabled={isLoading || isSelected}
                onClick={() => handleSelect(entity.id)}
                className={`flex w-full items-start justify-between p-2 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 ${
                  isSelected ? "bg-accent/60 font-medium" : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{label}</div>
                  {entity.aliases.length ? (
                    <div className="truncate text-[10px] text-muted-foreground">
                      Aliases: {entity.aliases.join(", ")}
                    </div>
                  ) : null}
                </div>
                {isSelected ? (
                  <Icon
                    name="Check"
                    className="ml-2 size-3.5 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-2">
        {onReclassify ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isMutating || loadingAction !== null}
            onClick={handleReclassify}
            className="h-7 text-xs"
          >
            {loadingAction === "reclassify" ? (
              <Icon name="Spinner" className="mr-1 size-3 animate-spin" />
            ) : null}
            Reclassify
          </Button>
        ) : (
          <div />
        )}

        {onClear && currentEntity ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isMutating || loadingAction !== null}
            onClick={handleClear}
            className="h-7 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            {loadingAction === "clear" ? (
              <Icon name="Spinner" className="mr-1 size-3 animate-spin" />
            ) : null}
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export type TaskIdentityProps = {
  threadId: string;
  isCompactViewport?: boolean;
  className?: string;
  readOnly?: boolean;
  onAssigned?: (entityId: string) => void;
  onCleared?: () => void;
  onReclassified?: () => void;
};

export function TaskIdentity({
  threadId,
  isCompactViewport = false,
  className = "",
  readOnly = false,
  onAssigned,
  onCleared,
  onReclassified,
}: TaskIdentityProps) {
  const { server, rpc, refresh } = useSharedServerState();
  const [open, setOpen] = useState(false);

  const catalog = server.catalog;
  const entities = catalog?.entities ?? [];
  const assignment = catalog?.assignments[threadId] ?? null;

  const currentEntity = assignment?.entityId
    ? (entities.find((e) => e.id === assignment.entityId) ?? null)
    : null;

  const currentLabel = currentEntity
    ? corpusLabel(currentEntity.id, entities).replace(/: /g, " › ")
    : null;

  const isInherited = Boolean(assignment?.inheritedFrom);
  const status =
    assignment?.status ?? (currentEntity ? "assigned" : "unresolved");

  const handleSelectEntity = async (entityId: string) => {
    await rpc.call("taskAssign", { threadId, entityId });
    await refresh();
    onAssigned?.(entityId);
  };

  const handleClear = async () => {
    await rpc.call("taskClear", { threadId });
    await refresh();
    onCleared?.();
  };

  const handleReclassify = async () => {
    await rpc.call("taskReclassify", { threadId });
    await refresh();
    onReclassified?.();
  };

  if (readOnly) {
    return (
      <TaskIdentityBadge
        label={currentLabel}
        status={status}
        isInherited={isInherited}
        isCompact={isCompactViewport}
        className={className}
        disabled
      />
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div>
          <TaskIdentityBadge
            label={currentLabel}
            status={status}
            isInherited={isInherited}
            isCompact={isCompactViewport}
            className={className}
          />
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="z-50 p-0 shadow-lg"
      >
        <TaskIdentityPicker
          threadId={threadId}
          assignment={assignment}
          entities={entities}
          onSelectEntity={handleSelectEntity}
          onClear={handleClear}
          onReclassify={handleReclassify}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
