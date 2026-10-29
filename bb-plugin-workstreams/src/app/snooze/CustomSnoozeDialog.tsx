import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { wakeSentence } from "../../domain/snooze.ts";
import {
  SnoozeRuleFields,
  draftOf,
  resolveDraft,
  type SnoozeDraft,
  type SnoozeDraftKind,
} from "./RuleFields.tsx";

/** What Custom… offers: every preset kind, and a one-off date and time. */
export const CUSTOM_SNOOZE_KINDS: readonly SnoozeDraftKind[] = [
  "duration",
  "time",
  "date",
  "activity",
];

/**
 * A one-off snooze from a snooze menu's Custom… item, with the same
 * choices a preset has plus a date and time. Opens on a date, the one choice
 * no preset offers; `onSubmit` receives the wake time, judged when the user
 * submits.
 */
export function CustomSnoozeDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (until: number | null) => void;
}) {
  const [draft, setDraft] = useState<SnoozeDraft>(() =>
    draftOf(undefined, Date.now(), "date"),
  );
  useEffect(() => {
    if (open) setDraft(draftOf(undefined, Date.now(), "date"));
  }, [open]);
  const result = resolveDraft(draft, Date.now());

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const final = resolveDraft(draft, Date.now());
    if (!final.ok) return;
    onSubmit(final.until);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm">
        <form onSubmit={submit} className="space-y-3">
          <DialogHeader>
            <DialogTitle>Snooze</DialogTitle>
          </DialogHeader>
          <SnoozeRuleFields
            draft={draft}
            onChange={setDraft}
            kinds={CUSTOM_SNOOZE_KINDS}
            autoFocus
          />
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {result.ok
              ? wakeSentence(result.until, Date.now())
              : result.message}
          </p>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!result.ok}>
              Snooze
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
