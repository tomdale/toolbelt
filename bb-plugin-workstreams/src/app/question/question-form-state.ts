export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface Question {
  id: string;
  prompt: string;
  shortLabel: string;
  multiSelect: boolean;
  allowFreeText: boolean;
  options: readonly QuestionOption[];
}

export interface QuestionAttachment {
  type: "localImage" | "localFile";
  projectId: string;
  path: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export type QuestionAnswer = {
  selected: string[];
  freeText?: string;
  attachments?: QuestionAttachment[];
};

export interface QuestionAnswerState {
  selected: string[];
  otherSelected: boolean;
  otherText: string;
  otherAttachments: QuestionAttachment[];
}

export type QuestionFormState = Record<string, QuestionAnswerState>;

function questionHasOptions(question: Question): boolean {
  return question.options.length > 0;
}

function emptyAnswerState(question: Question): QuestionAnswerState {
  return {
    selected: [],
    otherSelected: !questionHasOptions(question),
    otherText: "",
    otherAttachments: [],
  };
}

export function createInitialFormState(
  questions: readonly Question[],
): QuestionFormState {
  const state: QuestionFormState = {};
  for (const question of questions) {
    state[question.id] = emptyAnswerState(question);
  }
  return state;
}

export function answerStateFor(
  formState: QuestionFormState,
  question: Question,
): QuestionAnswerState {
  return {
    ...emptyAnswerState(question),
    ...formState[question.id],
    otherAttachments: formState[question.id]?.otherAttachments ?? [],
  };
}

function validSelectedValues(
  question: Question,
  selectedValues: readonly string[],
): string[] {
  const optionValues = new Set(question.options.map((option) => option.value));
  return selectedValues.filter((value) => optionValues.has(value));
}

export function isQuestionAnswered(
  question: Question,
  state: QuestionAnswerState,
): boolean {
  if (validSelectedValues(question, state.selected).length > 0) return true;
  return (
    state.otherSelected &&
    (state.otherText.trim().length > 0 || state.otherAttachments.length > 0)
  );
}

function buildQuestionAnswer(
  question: Question,
  state: QuestionAnswerState,
): QuestionAnswer {
  const freeText = state.otherText.trim();
  const includeFreeText = state.otherSelected && freeText.length > 0;
  const attachments = state.otherSelected ? state.otherAttachments : [];
  const freeform = {
    ...(includeFreeText ? { freeText } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
  if (question.multiSelect) {
    const selected = validSelectedValues(question, state.selected);
    return { selected, ...freeform };
  }
  if (state.otherSelected) {
    return { selected: [], ...freeform };
  }
  return { selected: validSelectedValues(question, state.selected) };
}

export function buildQuestionAnswers(
  questions: readonly Question[],
  formState: QuestionFormState,
): Record<string, QuestionAnswer> {
  const answers: Record<string, QuestionAnswer> = {};
  for (const question of questions) {
    answers[question.id] = buildQuestionAnswer(
      question,
      answerStateFor(formState, question),
    );
  }
  return answers;
}

export type QuestionShortcutChoice =
  { kind: "option"; value: string } | { kind: "other" } | null;

export function resolveQuestionShortcutChoice(
  question: Question,
  index: number,
): QuestionShortcutChoice {
  const option = question.options[index];
  if (option) return { kind: "option", value: option.value };
  if (
    index === question.options.length &&
    question.options.length > 0 &&
    question.allowFreeText
  ) {
    return { kind: "other" };
  }
  return null;
}
