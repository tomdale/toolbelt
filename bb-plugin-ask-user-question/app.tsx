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
    <div className="space-y-3">
      <p role="status" className="text-xs font-medium text-muted-foreground">
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
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: ASK_USER_QUESTION_RENDERER_ID,
    component: AskUserQuestionInteraction,
  });
});
