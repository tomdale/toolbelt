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

const MAX_SNOOZE_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * Snooze until a date and time the user picks. Opens on tomorrow morning;
 * `onSubmit` receives the wake time.
 */
export function CustomSnoozeDialog({
  open,
  onClose,
  onSubmit,
  morningHour,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (until: number) => void;
  morningHour: number;
}) {
  const [value, setValue] = useState("");
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  useEffect(() => {
    if (open) {
      const now = Date.now();
      setOpenedAt(now);
      setValue(toLocalInput(wakeTime("tomorrow", now, morningHour)!));
    }
  }, [open, morningHour]);
  const maxUntil = openedAt + MAX_SNOOZE_MS;
  const until = value ? new Date(value).getTime() : NaN;
  const valid =
    Number.isFinite(until) && until > Date.now() && until <= maxUntil;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onSubmit(until);
    onClose();
  };

  const message =
    !Number.isFinite(until) || until <= Date.now()
      ? "Pick a time in the future."
      : until > maxUntil
        ? "Pick a time in the next year."
        : `Returns to the sidebar ${describeWake(until, Date.now())}.`;

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
            max={toLocalInput(maxUntil)}
            onChange={(event) => setValue(event.target.value)}
            aria-label="Wake time"
          />
          <p className="text-xs text-muted-foreground">{message}</p>
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
