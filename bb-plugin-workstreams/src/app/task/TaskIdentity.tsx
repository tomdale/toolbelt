import React, { useId, useMemo, useState } from "react";
import { Icon } from "@/components/ui/icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { useSharedServerState } from "../serverState.ts";
import type { CanonicalAssignment, CorpusEntity } from "../../domain/corpus.ts";
import { corpusLabel } from "../../domain/corpus-label.ts";
import { compareGroupNames } from "../../domain/group-name-order.ts";
import { TAG_ICON } from "../workstream-icon.ts";

/**
 * A thread's Topic setting. Automatic (the default) lets the classifier pick
 * the topic, and the picker shows its current result under that choice.
 * Picking a topic replaces Automatic and is never reclassified; choosing
 * Automatic again hands the thread back to the classifier. A fork shows its
 * parent thread's topic and can't be set on its own.
 */

const UNCLASSIFIED = "Unclassified";
const CLASSIFYING = "Classifying…";

const topicPath = (id: string, entities: readonly CorpusEntity[]) =>
  corpusLabel(id, entities).replace(/: /g, " › ");

/** Whether the classifier, not the user, owns this thread's topic. */
export const isAutomaticTopic = (assignment: CanonicalAssignment | null) =>
  assignment?.provenance !== "manual";

export type TopicButtonProps = {
  /** The effective topic path, or null when the thread has none. */
  label: string | null;
  isAutomatic: boolean;
  isFork?: boolean;
  isClassifying?: boolean;
  isCompact?: boolean;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
};

export function TopicButton({
  label,
  isAutomatic,
  isFork = false,
  isClassifying = false,
  isCompact = false,
  className = "",
  onClick,
  disabled = false,
}: TopicButtonProps) {
  const displayLabel = isClassifying ? CLASSIFYING : (label ?? UNCLASSIFIED);
  const source = isFork
    ? "same as parent thread"
    : isAutomatic
      ? "automatic"
      : "chosen by you";

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={`Topic: ${displayLabel} (${source})`}
      title={`Topic: ${displayLabel} (${source})`}
      className={`ws-task-identity ${
        label ? "" : "ws-task-identity-unresolved"
      } ${isCompact ? "ws-task-identity-compact" : ""} ${className}`}
    >
      <Icon
        name={isClassifying ? "Spinner" : TAG_ICON}
        className={`size-3.5 shrink-0 opacity-70 ${
          isClassifying ? "animate-spin" : ""
        }`}
        aria-hidden="true"
      />
      <span className="ws-task-identity-label">{displayLabel}</span>
    </button>
  );
}

export type TopicPickerProps = {
  assignment: CanonicalAssignment | null;
  entities: readonly CorpusEntity[];
  onSelectTopic: (entityId: string) => Promise<void> | void;
  onSelectAutomatic: () => Promise<void> | void;
  onClose?: () => void;
};

export function TopicPicker({
  assignment,
  entities,
  onSelectTopic,
  onSelectAutomatic,
  onClose,
}: TopicPickerProps) {
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const searchInputId = useId();

  const automatic = isAutomaticTopic(assignment);
  const currentEntity = assignment?.entityId
    ? (entities.find((e) => e.id === assignment.entityId) ?? null)
    : null;
  const classifierResult =
    pending === "automatic"
      ? CLASSIFYING
      : automatic && currentEntity
        ? topicPath(currentEntity.id, entities)
        : automatic
          ? UNCLASSIFIED
          : "Let Workstreams choose";

  const topics = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return entities
      .filter((entity) => {
        if (!needle) return true;
        return (
          corpusLabel(entity.id, entities).toLowerCase().includes(needle) ||
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

  const run = async (key: string, action: () => Promise<void> | void) => {
    setError(null);
    setPending(key);
    try {
      await action();
      onClose?.();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't change the topic.",
      );
    } finally {
      setPending(null);
    }
  };

  const busy = pending !== null;
  const rowClass =
    "flex w-full items-start justify-between gap-2 p-2 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none";

  return (
    <div className="flex w-80 flex-col gap-2 p-3 text-popover-foreground">
      <h4 className="text-xs font-semibold text-muted-foreground">Topic</h4>

      <button
        type="button"
        disabled={busy || automatic}
        onClick={() => run("automatic", onSelectAutomatic)}
        aria-pressed={automatic}
        className={`${rowClass} rounded-md ${automatic ? "bg-accent/60" : ""}`}
      >
        <div className="min-w-0 flex-1">
          <div className="font-medium">Automatic</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {classifierResult}
          </div>
        </div>
        {automatic ? (
          <Icon
            name="Check"
            className="ml-2 size-3.5 shrink-0 text-primary"
            aria-hidden="true"
          />
        ) : null}
      </button>

      {error ? (
        <div
          role="alert"
          className="rounded-md bg-destructive/10 p-2 text-xs text-destructive"
        >
          {error}
        </div>
      ) : null}

      <Input
        id={searchInputId}
        placeholder="Search topics…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="h-8 text-xs"
        aria-label="Search topics"
      />

      <div className="max-h-52 divide-y divide-border/60 overflow-y-auto rounded-md border border-border">
        {topics.length === 0 ? (
          <div className="p-3 text-center text-xs text-muted-foreground">
            No matching topics.
          </div>
        ) : (
          topics.map((entity) => {
            const isChosen = !automatic && entity.id === currentEntity?.id;
            return (
              <button
                key={entity.id}
                type="button"
                disabled={busy || isChosen}
                onClick={() => run(entity.id, () => onSelectTopic(entity.id))}
                aria-pressed={isChosen}
                className={`${rowClass} ${isChosen ? "bg-accent/60 font-medium" : ""}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {topicPath(entity.id, entities)}
                  </div>
                  {entity.aliases.length ? (
                    <div className="truncate text-[10px] text-muted-foreground">
                      Also known as {entity.aliases.join(", ")}
                    </div>
                  ) : null}
                </div>
                {pending === entity.id ? (
                  <Icon
                    name="Spinner"
                    className="ml-2 size-3.5 shrink-0 animate-spin"
                    aria-hidden="true"
                  />
                ) : isChosen ? (
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
    </div>
  );
}

export type TaskIdentityProps = {
  threadId: string;
  isCompactViewport?: boolean;
  className?: string;
  readOnly?: boolean;
  onAssigned?: (entityId: string) => void;
  onAutomatic?: () => void;
};

export function TaskIdentity({
  threadId,
  isCompactViewport = false,
  className = "",
  readOnly = false,
  onAssigned,
  onAutomatic,
}: TaskIdentityProps) {
  const { server, rpc, refresh } = useSharedServerState();
  const [open, setOpen] = useState(false);
  const [classifying, setClassifying] = useState(false);

  const entities = server.catalog?.entities ?? [];
  const assignment = server.catalog?.assignments[threadId] ?? null;
  const currentEntity = assignment?.entityId
    ? (entities.find((e) => e.id === assignment.entityId) ?? null)
    : null;
  const label = currentEntity ? topicPath(currentEntity.id, entities) : null;
  const isFork = Boolean(assignment?.inheritedFrom);
  const automatic = isAutomaticTopic(assignment);

  const selectTopic = async (entityId: string) => {
    await rpc.call("taskAssign", { threadId, entityId });
    await refresh();
    onAssigned?.(entityId);
  };

  // Automatic runs the classifier now and stores its result as automatic,
  // which also lifts a topic the user chose earlier.
  const selectAutomatic = async () => {
    setClassifying(true);
    try {
      await rpc.call("taskReclassify", { threadId });
      await refresh();
      onAutomatic?.();
    } finally {
      setClassifying(false);
    }
  };

  const button = (props: Partial<TopicButtonProps> = {}) => (
    <TopicButton
      label={label}
      isAutomatic={automatic}
      isFork={isFork}
      isClassifying={classifying}
      isCompact={isCompactViewport}
      className={className}
      {...props}
    />
  );

  if (readOnly || isFork) return button({ disabled: true });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div>{button()}</div>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="z-50 p-0 shadow-lg"
      >
        <TopicPicker
          assignment={assignment}
          entities={entities}
          onSelectTopic={selectTopic}
          onSelectAutomatic={selectAutomatic}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
