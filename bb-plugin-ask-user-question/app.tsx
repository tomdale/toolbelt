import { useMemo, useState } from "react";
import {
  definePluginApp,
  type PluginPendingInteractionProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { QuestionForm } from "@/components/ui/question-form";
import {
  ASK_USER_QUESTION_RENDERER_ID,
  interactionPayloadSchema,
} from "./src/contracts.js";

function AskUserQuestionInteraction({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const parsed = useMemo(
    () => interactionPayloadSchema.safeParse(interaction.payload),
    [interaction.payload],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleCancel = () => {
    setBusy(true);
    setError(null);
    void cancel()
      .catch(() => setError("Could not dismiss the question. Please try again."))
      .finally(() => setBusy(false));
  };
  if (!parsed.success) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          This question could not be displayed.
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <Button type="button" variant="outline" disabled={busy} onClick={handleCancel}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <div className="@container/question text-foreground">
      {/* Matches the Workstreams recap card's state line, in the amber
          accent BB uses for attention. */}
      <p
        role="status"
        className="text-[11px] font-medium leading-[1.6] text-amber-700 dark:text-amber-300"
      >
        Awaiting your answer
      </p>
      <QuestionForm
        key={interaction.id}
        questions={parsed.data.questions}
        disabled={busy}
        cancelDisabled={busy}
        onSubmit={(answers) => {
          setBusy(true);
          setError(null);
          void submit({ answers })
            .catch(() => setError("Could not send your answer. Please try again."))
            .finally(() => setBusy(false));
        }}
        onCancel={handleCancel}
      />
      {error ? (
        <p role="alert" className="mt-2 text-[11px] text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: ASK_USER_QUESTION_RENDERER_ID,
    component: AskUserQuestionInteraction,
  });
});
