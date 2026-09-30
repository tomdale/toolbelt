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
import { describeWake, wakeTime } from "../../domain/snooze.ts";

/** A `datetime-local` value (local time, minutes precision). */
function toLocalInput(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Snooze until a date and time the user picks. Opens on tomorrow morning;
 * `onSubmit` receives the wake time.
 */
export function CustomSnoozeDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (until: number) => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => {
    if (open) setValue(toLocalInput(wakeTime("tomorrow", Date.now())!));
  }, [open]);
  const until = value ? new Date(value).getTime() : NaN;
  const valid = Number.isFinite(until) && until > Date.now();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onSubmit(until);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm">
        <form onSubmit={submit} className="space-y-3">
          <DialogHeader>
            <DialogTitle>Snooze until…</DialogTitle>
          </DialogHeader>
          <Input
            type="datetime-local"
            autoFocus
            value={value}
            min={toLocalInput(Date.now())}
            onChange={(event) => setValue(event.target.value)}
            aria-label="Wake time"
          />
          <p className="text-xs text-muted-foreground">
            {valid
              ? `Returns to the sidebar ${describeWake(until, Date.now())}.`
              : "Pick a time in the future."}
          </p>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!valid}>
              Snooze
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
