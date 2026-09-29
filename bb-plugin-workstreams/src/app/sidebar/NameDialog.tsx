import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type NameRequest = {
  title: string;
  initial: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
};

/** A small name prompt for renaming threads and creating or renaming workstreams. */
export function NameDialog({
  request,
  onClose,
}: {
  request: NameRequest | null;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setValue(request?.initial ?? "");
    setError(null);
    setBusy(false);
  }, [request]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request || !value.trim() || busy) return;
    setBusy(true);
    try {
      await request.onSubmit(value.trim());
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <form onSubmit={submit} className="space-y-3">
          <DialogHeader>
            <DialogTitle>{request?.title}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label={request?.title}
          />
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || !value.trim()}>
              {request?.submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
