/**
 * The Snooze settings section: the presets every snooze menu lists, in
 * order, and which one a click on a snooze button uses. Presets are added,
 * edited, made the default, deleted, and dragged into order here; there are
 * between one and `MAX_SNOOZE_PRESETS` of them.
 */
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  MAX_SNOOZE_PRESETS,
  newPresetId,
  presetLabel,
  ruleLabel,
  type SnoozePreset,
  type SnoozePrefsPatch,
  type SnoozeRule,
} from "../../domain/snooze.ts";
import { Hint } from "../Hint.tsx";
import { SectionRows, SettingRow } from "../settings/ui.tsx";
import { useServerState } from "../useWorkstreams.ts";
import { GripIcon, TrashIcon } from "./icons.tsx";
import { PresetDialog } from "./PresetDialog.tsx";

/** A control to focus once the list redraws: a row's handle or Delete. */
type Refocus = { readonly id: string; readonly control: "handle" | "delete" };

export function SnoozeSettings() {
  const { server, saveSnoozePrefs, refresh } = useServerState();
  const [error, setError] = useState<string | null>(null);
  // `preset` outlives `open`, so a closing edit dialog keeps its title.
  const [dialog, setDialog] = useState<{
    open: boolean;
    preset?: SnoozePreset;
  }>({ open: false });
  const [announcement, setAnnouncement] = useState("");
  const [refocus, setRefocus] = useState<Refocus | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const instructionsId = useId();
  const defaultName = useId();
  const { presets, default: defaultId } = server.snoozePrefs;
  const full = presets.length >= MAX_SNOOZE_PRESETS;

  const change = (patch: SnoozePrefsPatch) => {
    setError(null);
    saveSnoozePrefs(patch).catch((cause: unknown) =>
      setError(
        cause instanceof Error ? cause.message : "Couldn't save the change.",
      ),
    );
  };
  const move = (from: number, to: number) => {
    if (from < 0 || to < 0 || to >= presets.length || from === to) return;
    change({ presets: arrayMove([...presets], from, to) });
    setAnnouncement(
      `${presetLabel(presets[from]!)} moved to position ${to + 1} of ${presets.length}.`,
    );
  };
  const remove = (preset: SnoozePreset) => {
    if (presets.length <= 1) return;
    const index = presets.findIndex((p) => p.id === preset.id);
    const rest = presets.filter((p) => p.id !== preset.id);
    change(
      preset.id === defaultId
        ? { presets: rest, default: rest[0]!.id }
        : { presets: rest },
    );
    // The focused Delete leaves with its row; the next row's takes focus.
    const next = rest[Math.min(index, rest.length - 1)]!;
    setRefocus({ id: next.id, control: "delete" });
    setAnnouncement(`Deleted ${presetLabel(preset)}.`);
  };
  const save = (
    preset: SnoozePreset | undefined,
    edit: { label: string; rule: SnoozeRule },
  ) =>
    change({
      presets: preset
        ? presets.map((p) => (p.id === preset.id ? { ...p, ...edit } : p))
        : [...presets, { id: newPresetId(presets), ...edit }],
    });

  // Moving a row can drop the focus on its handle, and deleting one takes
  // its focused Delete away; put focus back once the list has redrawn.
  useEffect(() => {
    if (!refocus) return;
    const controls = list.current?.querySelectorAll<HTMLElement>(
      `[data-preset-${refocus.control}]`,
    );
    [...(controls ?? [])]
      .find((control) => control.dataset.presetId === refocus.id)
      ?.focus();
    setRefocus(null);
  }, [refocus, presets]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 6 },
    }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    move(
      presets.findIndex((p) => p.id === active.id),
      presets.findIndex((p) => p.id === over.id),
    );
  };
  const nameOf = (id: string | number) => {
    const preset = presets.find((p) => p.id === id);
    return preset ? presetLabel(preset) : "Preset";
  };
  const placeOf = (id: string | number) =>
    `position ${presets.findIndex((p) => p.id === id) + 1} of ${presets.length}`;
  // Drags announce presets by name; dnd-kit's own messages read their ids.
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${nameOf(active.id)} is over ${placeOf(over.id)}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? `${nameOf(active.id)} dropped at ${placeOf(over.id)}.`
        : `${nameOf(active.id)} dropped.`,
    onDragCancel: ({ active }) => `Moving ${nameOf(active.id)} was cancelled.`,
  };

  // Every change saves the whole list, so editing waits for the real one;
  // the defaults shown before it loads would replace the user's presets.
  if (!server.loaded)
    return (
      <SectionRows>
        <SettingRow
          label="Presets"
          description={server.ready ? "Couldn't load presets." : "Loading…"}
          control={
            server.ready ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refresh()}
              >
                Try again
              </Button>
            ) : undefined
          }
        />
      </SectionRows>
    );

  return (
    <SectionRows>
      <div>
        <SettingRow
          label="Presets"
          description="Shown in snooze menus, in this order."
        />
        <p id={instructionsId} className="sr-only">
          Drag to reorder, or press the up and down arrow keys.
        </p>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          accessibility={{ announcements }}
        >
          <SortableContext
            items={presets.map((p) => p.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul
              ref={list}
              aria-label="Snooze presets"
              className="mt-2 space-y-0.5"
            >
              {presets.map((preset, index) => (
                <PresetRow
                  key={preset.id}
                  preset={preset}
                  isDefault={preset.id === defaultId}
                  defaultName={defaultName}
                  instructionsId={instructionsId}
                  canDelete={presets.length > 1}
                  onMove={(step) => {
                    setRefocus({ id: preset.id, control: "handle" });
                    move(index, index + step);
                  }}
                  onMakeDefault={() => change({ default: preset.id })}
                  onEdit={() => setDialog({ open: true, preset })}
                  onDelete={() => remove(preset)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
        <div className="mt-2 flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={full}
            onClick={() => setDialog({ open: true })}
          >
            <Icon name="Plus" />
            Add preset
          </Button>
          {full ? (
            <span className="text-xs text-muted-foreground">
              Up to {MAX_SNOOZE_PRESETS} presets
            </span>
          ) : null}
        </div>
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </div>
      {error ? (
        <p role="alert" className="py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <PresetDialog
        open={dialog.open}
        preset={dialog.preset}
        onClose={() => setDialog((current) => ({ ...current, open: false }))}
        onSave={(edit) => save(dialog.preset, edit)}
      />
    </SectionRows>
  );
}

const iconButtonClass =
  "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground";

/**
 * One preset: a drag handle, its label (and, when the label is the user's
 * own, what it does), when it would wake now, the default choice, and Edit
 * and Delete. The last preset can't be deleted.
 */
function PresetRow({
  preset,
  isDefault,
  defaultName,
  instructionsId,
  canDelete,
  onMove,
  onMakeDefault,
  onEdit,
  onDelete,
}: {
  preset: SnoozePreset;
  isDefault: boolean;
  /** The `name` shared by every row's default radio. */
  defaultName: string;
  instructionsId: string;
  canDelete: boolean;
  /** Moves the row one place up (-1) or down (1). */
  onMove: (step: -1 | 1) => void;
  onMakeDefault: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: preset.id });
  const label = presetLabel(preset);
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform && { ...transform, x: 0 }),
    transition,
    ...(isDragging && {
      position: "relative",
      zIndex: 10,
      boxShadow: "0 4px 12px rgb(0 0 0 / 0.2)",
    }),
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`snooze-preset-${preset.id}`}
      className={cn(
        "flex items-center gap-2 rounded-md bg-card py-1 pr-1",
        isDragging && "bg-accent",
      )}
    >
      <button
        ref={setActivatorNodeRef}
        {...listeners}
        type="button"
        aria-label={`Move ${label}`}
        aria-describedby={instructionsId}
        data-preset-handle=""
        data-preset-id={preset.id}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          onMove(event.key === "ArrowUp" ? -1 : 1);
        }}
        className="flex h-7 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing"
      >
        <GripIcon className="size-4" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{label}</p>
        {preset.label ? (
          <p className="truncate text-xs text-muted-foreground">
            {ruleLabel(preset.rule)}
          </p>
        ) : null}
      </div>
      <label className="ml-2 flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="radio"
          name={defaultName}
          checked={isDefault}
          onChange={onMakeDefault}
          aria-label={`Default: ${label}`}
          className="cursor-pointer accent-foreground"
        />
        {isDefault ? <span aria-hidden="true">Default</span> : null}
      </label>
      <Hint label={`Edit ${label}`}>
        <button
          type="button"
          aria-label={`Edit ${label}`}
          onClick={onEdit}
          className={iconButtonClass}
        >
          <Icon name="Edit" className="size-3.5" />
        </button>
      </Hint>
      <Hint
        label={canDelete ? `Delete ${label}` : "Can't delete the last preset"}
      >
        <button
          type="button"
          aria-label={`Delete ${label}`}
          aria-disabled={!canDelete}
          data-preset-delete=""
          data-preset-id={preset.id}
          onClick={() => {
            if (canDelete) onDelete();
          }}
          className={iconButtonClass}
        >
          <TrashIcon className="size-3.5" />
        </button>
      </Hint>
    </li>
  );
}
