import type {
  Question,
  QuestionOption,
  QuestionAnswer,
} from "./question-form-state.ts";
import {
  useQuestionFormHost,
  type QuestionShortcut,
} from "./question-form-host.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_NewThreadComposer,
  Markdown,
  useComposers,
} from "@get-bb/plugin-sdk/app";
import { plainText } from "../../domain/recap.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  answerStateFor,
  buildQuestionAnswers,
  createInitialFormState,
  isQuestionAnswered,
  resolveQuestionShortcutChoice,
  type QuestionAnswerState,
  type QuestionFormState,
} from "./question-form-state.ts";

const BBNewThreadComposer = experimental_NewThreadComposer;
const OTHER_OPTION_LABEL = "Other…";
const QUESTION_COMPOSER_KEY = "workstreams-ask-user-question";
const PREVIEW_MAX_HEIGHT = 220;

// A step below the recap card's type scale: a question card carries more
// lines than a recap, so options stay compact.
const PROMPT_CLASS = "text-[13.5px] leading-[1.4] [text-wrap:pretty]";
const MARKDOWN_CLASS =
  "text-inherit [&_*]:!text-inherit [&_*]:!text-[length:inherit] [&_*]:!leading-[inherit] [&_p]:!m-0 [&_code]:!rounded [&_code]:!px-1 [&_code]:!py-px [&_code]:!text-[0.923em]";
const LABEL_CLASS = "text-[12.5px] leading-[1.45]";
const DESCRIPTION_CLASS = "text-[11.5px] leading-[1.45] [text-wrap:pretty]";

interface QuestionOptionRowProps {
  checked: boolean;
  label: string;
  description?: string;
  multiSelect: boolean;
  onSelect: () => void;
  shortcut?: QuestionShortcut;
}

function QuestionOptionRow({
  checked,
  label,
  description,
  multiSelect,
  onSelect,
  shortcut,
}: QuestionOptionRowProps) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      onClick={onSelect}
      className="flex w-full cursor-pointer items-start gap-2 rounded-md py-1 text-left disabled:cursor-default"
    >
      <span
        className={cn(
          "mt-[3px] flex size-3.5 shrink-0 items-center justify-center border",
          multiSelect ? "rounded" : "rounded-full",
          checked
            ? "border-amber-600 bg-amber-600 text-white dark:border-amber-400 dark:bg-amber-400 dark:text-amber-950"
            : "border-foreground/25",
        )}
      >
        {checked ? (
          <Icon name="Check" className="size-2.5" aria-hidden />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block font-medium text-foreground", LABEL_CLASS)}>
          {label}
        </span>
        {description ? (
          <span
            className={cn(
              "mt-px block text-muted-foreground",
              DESCRIPTION_CLASS,
            )}
          >
            {description}
          </span>
        ) : null}
      </span>
      {shortcut ? (
        <kbd
          aria-hidden="true"
          className="mt-px shrink-0 text-[11px] font-medium tabular-nums text-foreground/50"
        >
          {shortcut.label}
        </kbd>
      ) : null}
    </button>
  );
}

function QuestionOptionPreview({ preview }: { preview: string }) {
  return (
    <pre
      className="mx-2.5 mb-1 mt-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background/60 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-foreground"
      style={{ maxHeight: `${PREVIEW_MAX_HEIGHT}px` }}
    >
      {preview}
    </pre>
  );
}

interface QuestionTabsProps {
  currentIndex: number;
  formState: QuestionFormState;
  onSelect: (index: number) => void;
  questions: readonly Question[];
}

function QuestionTabs({
  currentIndex,
  formState,
  onSelect,
  questions,
}: QuestionTabsProps) {
  return (
    <div className="mb-2 flex shrink-0 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {questions.map((question, index) => {
          const answered = isQuestionAnswered(
            question,
            answerStateFor(formState, question),
          );
          const isActive = index === currentIndex;
          return (
            <div
              key={question.id}
              className={cn(
                "relative inline-flex shrink-0 items-center rounded-full border",
                isActive
                  ? "border-amber-500/50 bg-amber-500/[0.08] text-foreground dark:border-amber-300/40 dark:bg-amber-300/[0.08]"
                  : "border-border bg-background/60 text-foreground/70 hover:border-foreground/25 hover:text-foreground",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(index)}
                aria-pressed={isActive}
                title={plainText(question.prompt)}
                className="flex min-w-0 items-center gap-1 rounded-full px-2 py-px focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {answered ? (
                  <Icon
                    name="Check"
                    aria-hidden
                    className="size-3 shrink-0 text-amber-700 dark:text-amber-300"
                  />
                ) : null}
                <span
                  className={cn(
                    "truncate text-[11.5px] font-medium leading-[1.6]",
                    answered ? "line-through" : undefined,
                  )}
                  style={{ maxWidth: "180px" }}
                >
                  {question.shortLabel}
                </span>
              </button>
            </div>
          );
        })}
      </div>
      <span className="shrink-0 text-[11px] font-medium tabular-nums text-amber-700 dark:text-amber-300">
        {currentIndex + 1} of {questions.length}
      </span>
    </div>
  );
}

interface QuestionInputBlockProps {
  disabled: boolean;
  question: Question;
  state: QuestionAnswerState;
  onToggleOption: (optionValue: string) => void;
  onSelectOther: () => void;
  onShortcutSubmit: () => void;
  onComposerSubmit: (
    request: Parameters<
      React.ComponentProps<typeof experimental_NewThreadComposer>["onSubmit"]
    >[0],
  ) => void;
  composerKey: string;
  shortcuts: ReadonlyMap<string, QuestionShortcut>;
}

function QuestionInputBlock({
  disabled,
  question,
  state,
  onToggleOption,
  onSelectOther,
  onShortcutSubmit,
  onComposerSubmit,
  composerKey,
  shortcuts,
}: QuestionInputBlockProps) {
  const options = question.options;

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="sr-only">{plainText(question.prompt)}</legend>
      {question.prompt ? (
        <div
          role="heading"
          aria-level={2}
          className={cn(
            "font-medium tracking-[-0.006em] text-foreground",
            PROMPT_CLASS,
          )}
        >
          <Markdown content={question.prompt} className={MARKDOWN_CLASS} />
        </div>
      ) : null}
      <div className="mt-1.5 space-y-px">
        {options.map((option: QuestionOption, index) => {
          const checked = state.selected.includes(option.value);
          return (
            <div key={option.value}>
              <QuestionOptionRow
                checked={checked}
                label={option.label}
                description={option.description}
                multiSelect={question.multiSelect}
                onSelect={() => onToggleOption(option.value)}
                shortcut={shortcuts.get(String(index))}
              />
              {checked && option.preview ? (
                <QuestionOptionPreview preview={option.preview} />
              ) : null}
            </div>
          );
        })}
        {question.allowFreeText && options.length > 0 ? (
          <QuestionOptionRow
            checked={state.otherSelected}
            label={OTHER_OPTION_LABEL}
            multiSelect={question.multiSelect}
            onSelect={onSelectOther}
            shortcut={shortcuts.get(String(options.length))}
          />
        ) : null}
      </div>
      {state.otherSelected ? (
        <div className="mt-2 overflow-hidden rounded-md border border-border bg-background/60">
          <BBNewThreadComposer
            key={`${QUESTION_COMPOSER_KEY}:${composerKey}:${question.id}`}
            draftKey={`${QUESTION_COMPOSER_KEY}:${composerKey}:${question.id}`}
            placeholder="Type your own answer…"
            layout="document"
            onSubmit={onComposerSubmit}
            className="[&_[data-promptbox-shell]]:!border-0 [&_[data-promptbox-shell]]:!bg-transparent [&_[data-promptbox-shell]]:!shadow-none [&_[data-promptbox-shell]]:!p-0 [&_[data-promptbox-shell]]:!min-h-0 [&_[data-promptbox-shell]]:!rounded-none [&_[data-promptbox]]:!min-h-[84px] [&_[data-promptbox]]:!max-h-[158px] [&_[data-promptbox]]:text-[12.5px] [&_textarea]:!min-h-[84px] [&_textarea]:!max-h-[158px]"
          />
        </div>
      ) : null}
    </fieldset>
  );
}

export interface QuestionFormProps {
  persistenceKey?: string;
  questions: readonly Question[];
  disabled: boolean;
  cancelDisabled: boolean;
  onSubmit: (answers: Record<string, QuestionAnswer>) => void;
  onCancel: () => void;
  composerKey: string;
}

export function QuestionForm({
  persistenceKey,
  questions,
  disabled,
  cancelDisabled,
  onSubmit,
  onCancel,
  composerKey,
}: QuestionFormProps) {
  const storageKey = persistenceKey
    ? `ws-question-draft:${persistenceKey}`
    : null;
  const [formState, setFormState] = useState<QuestionFormState>(() => {
    try {
      const saved = storageKey ? sessionStorage.getItem(storageKey) : null;
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (
          parsed &&
          typeof parsed === "object" &&
          Object.values(parsed).every(
            (value) =>
              value &&
              typeof value === "object" &&
              Array.isArray(value.selected) &&
              value.selected.every(
                (item: unknown) => typeof item === "string",
              ) &&
              typeof value.otherSelected === "boolean" &&
              typeof value.otherText === "string" &&
              (value.otherAttachments === undefined ||
                Array.isArray(value.otherAttachments)),
          )
        )
          return parsed as QuestionFormState;
      }
    } catch {
      /* Storage may be unavailable in embedded composers. */
    }
    return createInitialFormState(questions);
  });
  const [currentIndex, setCurrentIndex] = useState(0);
  useEffect(() => {
    if (!storageKey) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(formState));
    } catch {
      /* Keep the form usable without storage. */
    }
  }, [storageKey, formState]);
  const formRef = useRef<HTMLDivElement>(null);
  const { shortcuts, registerChoiceHandler } = useQuestionFormHost();
  const totalQuestions = questions.length;
  const currentQuestion = questions[currentIndex] ?? null;
  const answerComposerKey = `${QUESTION_COMPOSER_KEY}:${composerKey}:`;
  const answerComposers = useComposers().filter(
    (composer) =>
      composer.key.includes(encodeURIComponent(answerComposerKey)) &&
      composer.scope.kind === "new-thread",
  );
  const answerComposer = answerComposers.find((composer) =>
    composer.key.endsWith(`:${currentQuestion?.id ?? questions[0]?.id}`),
  );
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === totalQuestions - 1;
  const currentState = answerStateFor(
    formState,
    currentQuestion ?? questions[0]!,
  );
  const liveAnswerState: QuestionAnswerState =
    answerComposer && !answerComposer.isEmpty
      ? {
          ...currentState,
          otherSelected: true,
          otherText: answerComposer.text,
          otherAttachments: answerComposer.draft.attachments.map(
            (attachment) => ({
              ...attachment,
              projectId:
                answerComposer.scope.kind === "new-thread"
                  ? (answerComposer.scope.projectId ?? "")
                  : "",
            }),
          ),
        }
      : currentState;
  const stateForAnswers = Object.fromEntries(
    questions.map((question) => {
      const composer = answerComposers.find((candidate) =>
        candidate.key.endsWith(`:${question.id}`),
      );
      const state = answerStateFor(formState, question);
      if (!composer || composer.isEmpty) return [question.id, state];
      return [
        question.id,
        {
          ...state,
          otherSelected: true,
          otherText: composer.text,
          otherAttachments: composer.draft.attachments.map((attachment) => ({
            ...attachment,
            projectId:
              composer.scope.kind === "new-thread"
                ? (composer.scope.projectId ?? "")
                : "",
          })),
        },
      ];
    }),
  ) as QuestionFormState;
  const allAnswered = useMemo(
    () =>
      totalQuestions > 0 &&
      questions.every((question) =>
        isQuestionAnswered(question, answerStateFor(stateForAnswers, question)),
      ),
    [questions, stateForAnswers, totalQuestions],
  );

  const updateQuestionState = useCallback(
    (
      question: Question,
      update: (state: QuestionAnswerState) => QuestionAnswerState,
    ): void => {
      setFormState((current) => ({
        ...current,
        [question.id]: update(answerStateFor(current, question)),
      }));
    },
    [],
  );

  const handleToggleOption = useCallback(
    (question: Question, optionValue: string): void => {
      updateQuestionState(question, (state) => {
        if (question.multiSelect) {
          const selected = state.selected.includes(optionValue)
            ? state.selected.filter((value) => value !== optionValue)
            : [...state.selected, optionValue];
          return { ...state, selected };
        }
        return { ...state, selected: [optionValue], otherSelected: false };
      });
    },
    [updateQuestionState],
  );

  const handleSelectOther = useCallback(
    (question: Question): void => {
      updateQuestionState(question, (state) =>
        question.multiSelect
          ? { ...state, otherSelected: !state.otherSelected }
          : { ...state, selected: [], otherSelected: true },
      );
    },
    [updateQuestionState],
  );

  const submitAnswer = (): void => {
    if (disabled || !allAnswered) return;
    onSubmit(buildQuestionAnswers(questions, stateForAnswers));
  };

  const handleAdvance = (): void => {
    if (isLast) {
      submitAnswer();
      return;
    }
    if (currentQuestion && answerComposer && !answerComposer.isEmpty) {
      setFormState(stateForAnswers);
    }
    setCurrentIndex((index) => Math.min(index + 1, totalQuestions - 1));
  };

  useEffect(() => {
    if (disabled || currentQuestion === null) return;
    return registerChoiceHandler((index) => {
      const choice = resolveQuestionShortcutChoice(currentQuestion, index);
      if (!choice) return false;
      if (choice.kind === "option") {
        handleToggleOption(currentQuestion, choice.value);
        formRef.current?.focus();
      } else handleSelectOther(currentQuestion);
      return true;
    });
  }, [
    disabled,
    currentQuestion,
    registerChoiceHandler,
    handleToggleOption,
    handleSelectOther,
  ]);

  if (!currentQuestion) return null;

  return (
    <div
      ref={formRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (
          event.target !== event.currentTarget ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.key !== "Enter" ||
          event.shiftKey ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          disabled
        )
          return;
        event.preventDefault();
        handleAdvance();
      }}
      className="flex max-h-[min(32rem,60dvh)] min-h-0 flex-col text-foreground focus-visible:outline-none"
    >
      {totalQuestions > 1 ? (
        <QuestionTabs
          currentIndex={currentIndex}
          formState={formState}
          onSelect={setCurrentIndex}
          questions={questions}
        />
      ) : null}
      <div
        className="min-h-0 touch-pan-y overflow-y-auto overscroll-contain"
        onKeyDown={(event) => {
          if (
            event.target !== event.currentTarget &&
            (event.key === "Enter" || event.key === "Escape")
          ) {
            event.stopPropagation();
          }
        }}
      >
        <QuestionInputBlock
          disabled={disabled}
          question={currentQuestion}
          state={currentState}
          onToggleOption={(optionValue) =>
            handleToggleOption(currentQuestion, optionValue)
          }
          onSelectOther={() => handleSelectOther(currentQuestion)}
          onShortcutSubmit={handleAdvance}
          composerKey={composerKey}
          onComposerSubmit={(request) => {
            const nextState: QuestionAnswerState = {
              ...currentState,
              otherText: request.input
                .filter((input) => input.type === "text")
                .map((input) => input.text)
                .join("\n\n"),
              otherAttachments: request.input.flatMap((input) =>
                input.type === "localImage" || input.type === "localFile"
                  ? [
                      {
                        type: input.type,
                        projectId: request.projectId,
                        path: input.path,
                        ...(input.type === "localFile" && input.name
                          ? { name: input.name }
                          : {}),
                        ...(input.type === "localFile" && input.mimeType
                          ? { mimeType: input.mimeType }
                          : {}),
                        ...(input.type === "localFile" && input.sizeBytes
                          ? { sizeBytes: input.sizeBytes }
                          : {}),
                      },
                    ]
                  : [],
              ),
            };
            const nextFormState = {
              ...formState,
              [currentQuestion.id]: nextState,
            };
            setFormState(nextFormState);
          }}
          shortcuts={shortcuts}
        />
      </div>
      {/* An edge-to-edge footer strip like the recap card's, offset by the
          card's px-4 py-3 padding. */}
      <div className="-mx-4 -mb-3 mt-2.5 flex shrink-0 items-center justify-between gap-2 rounded-b-[7px] border-t border-amber-900/10 bg-amber-500/[0.05] px-3 py-1.5 dark:border-amber-200/15 dark:bg-amber-300/[0.04]">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={cancelDisabled}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <div className="flex items-center gap-2">
          {!isFirst ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="bg-background/60"
              disabled={disabled}
              onClick={() => setCurrentIndex((index) => Math.max(index - 1, 0))}
            >
              Back
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={disabled || (isLast && !allAnswered)}
            onClick={handleAdvance}
          >
            {disabled ? (
              <Icon name="Spinner" className="size-3 animate-spin" />
            ) : null}
            {isLast ? "Submit" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
