import { useState, type FormEvent } from "react";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { RpcContract } from "../../server/contract.ts";
import type { CorpusEntity } from "../../domain/corpus.ts";
import { entityAncestors } from "../../domain/corpus.ts";
import { corpusLabel } from "../../domain/corpus-label.ts";

type Rpc = ReturnType<typeof useRpc<RpcContract>>;

export type DialogState =
  | { kind: "create"; parentId: string | null }
  | { kind: "rename"; entity: CorpusEntity }
  | { kind: "reparent"; entity: CorpusEntity }
  | { kind: "merge"; entity: CorpusEntity }
  | { kind: "metadata"; entity: CorpusEntity }
  | null;

export function CreateEntityDialog({
  parentId: initialParentId,
  entities,
  rpc,
  onSuccess,
  onClose,
}: {
  parentId: string | null;
  entities: readonly CorpusEntity[];
  rpc: Rpc;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState<string | null>(initialParentId);
  const [aliasesText, setAliasesText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const aliases = aliasesText
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      await rpc.call("catalogCreate", {
        name: name.trim(),
        description: description.trim(),
        parentId,
        aliases,
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create entity");
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit} className="space-y-3">
          <DialogHeader>
            <DialogTitle>New Product or Feature</DialogTitle>
            <DialogDescription>
              Create a new entity in the Catalog. Retained identities remain
              valid regardless of immediate activity.
            </DialogDescription>
          </DialogHeader>

          {error ? (
            <div
              role="alert"
              className="rounded bg-destructive/10 p-2 text-xs text-destructive"
            >
              {error}
            </div>
          ) : null}

          <div>
            <label className="text-xs font-medium text-foreground">
              Name *
            </label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Workstreams, Catalog, Billing"
              className="mt-1 h-8 text-xs"
              aria-label="Name *"
              required
            />
          </div>

          <div>
            <label className="text-xs font-medium text-foreground">
              Parent in hierarchy
            </label>
            <select
              value={parentId ?? ""}
              onChange={(e) =>
                setParentId(e.target.value ? e.target.value : null)
              }
              className="mt-1 flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
              aria-label="Parent in hierarchy"
            >
              <option value="">None (top-level product)</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {corpusLabel(e.id, entities).replace(/: /g, " › ")}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-foreground">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this product or feature concern?"
              rows={2}
              aria-label="Description"
              className="mt-1 w-full rounded-md border border-input bg-transparent p-2 text-xs"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-foreground">
              Aliases
            </label>
            <Input
              value={aliasesText}
              onChange={(e) => setAliasesText(e.target.value)}
              placeholder="Alternative names, separated by commas"
              className="mt-1 h-8 text-xs"
              aria-label="Aliases"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!name.trim() || busy}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RenameEntityDialog({
  entity,
  rpc,
  onSuccess,
  onClose,
}: {
  entity: CorpusEntity;
  rpc: Rpc;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(entity.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("catalogRename", {
        entityId: entity.id,
        name: name.trim(),
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename entity");
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <form onSubmit={handleSubmit} className="space-y-3">
          <DialogHeader>
            <DialogTitle>Rename Entity</DialogTitle>
            <DialogDescription>
              Updates the derived product/feature label across existing tasks
              without moving native workstreams.
            </DialogDescription>
          </DialogHeader>

          {error ? (
            <div
              role="alert"
              className="rounded bg-destructive/10 p-2 text-xs text-destructive"
            >
              {error}
            </div>
          ) : null}

          <div>
            <label className="text-xs font-medium text-foreground">
              Name *
            </label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 h-8 text-xs"
              aria-label="Name *"
              required
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!name.trim() || busy}>
              {busy ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ReparentEntityDialog({
  entity,
  entities,
  rpc,
  onSuccess,
  onClose,
}: {
  entity: CorpusEntity;
  entities: readonly CorpusEntity[];
  rpc: Rpc;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [parentId, setParentId] = useState<string | null>(entity.parentId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Exclude self and any descendants to avoid cycles in the picker
  const invalidParentIds = new Set<string>([entity.id]);
  for (const other of entities) {
    try {
      const ancestors = entityAncestors(other.id, entities);
      if (ancestors.includes(entity.id)) {
        invalidParentIds.add(other.id);
      }
    } catch {
      // Ignore cycle errors in traversal
    }
  }

  const validParents = entities.filter((e) => !invalidParentIds.has(e.id));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("catalogReparent", {
        entityId: entity.id,
        parentId,
      });
      onSuccess();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to reparent entity",
      );
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit} className="space-y-3">
          <DialogHeader>
            <DialogTitle>Reparent Entity</DialogTitle>
            <DialogDescription>
              Move &ldquo;{entity.name}&rdquo; under a different parent. Updates
              derived labels without altering native thread placement.
            </DialogDescription>
          </DialogHeader>

          {error ? (
            <div
              role="alert"
              className="rounded bg-destructive/10 p-2 text-xs text-destructive"
            >
              {error}
            </div>
          ) : null}

          <div>
            <label className="text-xs font-medium text-foreground">
              New parent in hierarchy
            </label>
            <select
              value={parentId ?? ""}
              onChange={(e) =>
                setParentId(e.target.value ? e.target.value : null)
              }
              className="mt-1 flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
              aria-label="New parent in hierarchy"
            >
              <option value="">None (top-level product)</option>
              {validParents.map((e) => (
                <option key={e.id} value={e.id}>
                  {corpusLabel(e.id, entities).replace(/: /g, " › ")}
                </option>
              ))}
            </select>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Reparenting…" : "Reparent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MergeEntityDialog({
  entity,
  entities,
  rpc,
  onSuccess,
  onClose,
}: {
  entity: CorpusEntity;
  entities: readonly CorpusEntity[];
  rpc: Rpc;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [targetId, setTargetId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Exclude self and any descendants
  const invalid = new Set<string>([entity.id]);
  for (const other of entities) {
    try {
      const ancestors = entityAncestors(other.id, entities);
      if (ancestors.includes(entity.id)) {
        invalid.add(other.id);
      }
    } catch {
      // Ignore cycle errors
    }
  }
  const validTargets = entities.filter((e) => !invalid.has(e.id));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!targetId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("catalogMerge", {
        sourceEntityId: entity.id,
        targetEntityId: targetId,
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to merge entities");
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit} className="space-y-3">
          <DialogHeader>
            <DialogTitle>Merge Entity</DialogTitle>
            <DialogDescription>
              Merge &ldquo;{entity.name}&rdquo; into another entity. All
              associated tasks will be reassigned to the target, child entities
              will be reparented, and &ldquo;{entity.name}&rdquo; will be
              deleted.
            </DialogDescription>
          </DialogHeader>

          {error ? (
            <div
              role="alert"
              className="rounded bg-destructive/10 p-2 text-xs text-destructive"
            >
              {error}
            </div>
          ) : null}

          <div>
            <label className="text-xs font-medium text-foreground">
              Target entity *
            </label>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="mt-1 flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
              aria-label="Target entity *"
              required
            >
              <option value="" disabled>
                Select target product or feature…
              </option>
              {validTargets.map((e) => (
                <option key={e.id} value={e.id}>
                  {corpusLabel(e.id, entities).replace(/: /g, " › ")}
                </option>
              ))}
            </select>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!targetId || busy}>
              {busy ? "Merging…" : "Merge"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EditMetadataDialog({
  entity,
  rpc,
  onSuccess,
  onClose,
}: {
  entity: CorpusEntity;
  rpc: Rpc;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [description, setDescription] = useState(entity.description);
  const [aliasesText, setAliasesText] = useState(entity.aliases.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const aliases = aliasesText
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      await rpc.call("catalogUpdateMetadata", {
        entityId: entity.id,
        description: description.trim(),
        aliases,
      });
      onSuccess();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update metadata",
      );
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit} className="space-y-3">
          <DialogHeader>
            <DialogTitle>Edit Details: {entity.name}</DialogTitle>
            <DialogDescription>
              Update the description and alternative aliases for this identity.
            </DialogDescription>
          </DialogHeader>

          {error ? (
            <div
              role="alert"
              className="rounded bg-destructive/10 p-2 text-xs text-destructive"
            >
              {error}
            </div>
          ) : null}

          <div>
            <label className="text-xs font-medium text-foreground">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              aria-label="Description"
              className="mt-1 w-full rounded-md border border-input bg-transparent p-2 text-xs"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-foreground">
              Aliases
            </label>
            <Input
              value={aliasesText}
              onChange={(e) => setAliasesText(e.target.value)}
              placeholder="Alternative names, separated by commas"
              className="mt-1 h-8 text-xs"
              aria-label="Aliases"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Saving…" : "Save details"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
