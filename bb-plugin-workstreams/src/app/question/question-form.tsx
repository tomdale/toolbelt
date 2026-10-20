import type {
  Question,
  QuestionOption,
  QuestionAnswer,
  QuestionAttachment,
} from "./question-form-state.ts";
import {
  useQuestionFormHost,
  type QuestionShortcut,
} from "./question-form-host.tsx";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { Markdown, useBbContext, useSdk } from "@get-bb/plugin-sdk/app";
import { plainText } from "../../domain/recap.ts";
import { formatQuestionText } from "./question-markdown.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@/components/ui/hooks/use-pointer-coarse";
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

const OTHER_OPTION_LABEL = "Other…";
const PREVIEW_MAX_HEIGHT = 220;
const MAX_FREE_TEXT_LENGTH = 4096;

// The card's type scale, largest to smallest: the question (in the card's
// amber accent, which replaces a separate state label; a lighter amber than
// the border so it stays legible as text), option labels, details,
// then option descriptions. On a phone (a viewport under 768px with a coarse
// pointer) the text follows BB's own rule and takes the next token up: the
// question is 22px, labels `text-base`, the timeline's size, and the
// rest `text-sm`. The answer field must be at least 16px or iOS zooms the page
// when it takes focus.
const PROMPT_CLASS =
  "text-[20px] leading-[1.3] text-amber-700 dark:text-amber-300 max-md:pointer-coarse:text-[22px] [text-wrap:pretty]";
// The renderer's root sets its own size and color, so the root takes the
// prompt's here, and code chips stay in the foreground color for legibility.
const MARKDOWN_CLASS =
  "!text-inherit !text-[length:inherit] !leading-[inherit] [&_*]:!text-inherit [&_*]:!text-[length:inherit] [&_*]:!leading-[inherit] [&_p]:!m-0 [&_code]:!rounded [&_code]:!px-[3px] [&_code]:!py-px [&_code]:!text-[0.923em] [&_code]:!text-foreground";
// The host renderer gives every element its own color, size, and margins, as
// it does for chat messages. Details are context for the choice below them, so
// they sit a step below the question and the option labels in size and compact
// spacing, at full brightness so they stay easy to read. Top-level list text
// lines up with the option labels (see OPTION_TEXT_INDENT), bold stays below
// the question's weight, and headings sit tight to their paragraphs.
const DETAILS_CLASS =
  "!text-[length:inherit] !leading-[inherit] [&_*]:!text-[length:inherit] [&_*]:!leading-[inherit] [&_p]:!mb-1.5 [&_ul]:!mb-1.5 [&_ol]:!mb-1.5 [&_li]:!mb-0.5 [&_ul]:!pl-6 [&_ol]:!pl-6 [&_li_ul]:!pl-5 [&_li_ol]:!pl-5 [&_strong]:!font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:!mt-2 [&_:is(h1,h2,h3,h4,h5,h6)]:!mb-1 [&_:last-child]:!mb-0 [&_code]:!rounded [&_code]:!px-[3px] [&_code]:!py-px [&_code]:!text-[0.923em]";
// Agents put paths and URLs in option text; wrap them rather than overflow.
// Footer buttons match the details text size, and reach 44px on a phone.
const FOOTER_BUTTON_CLASS = "text-[13px] max-md:pointer-coarse:h-11";
const LABEL_CLASS =
  "text-[13.5px] leading-[1.4] max-md:pointer-coarse:text-base [overflow-wrap:anywhere]";
const DESCRIPTION_CLASS =
  "text-[12px] leading-[1.45] max-md:pointer-coarse:text-sm [text-wrap:pretty] [overflow-wrap:anywhere]";
// The radio (14px, 18px on a phone) plus its 10px gap: where option text
// starts. Details lists, option previews, and the answer field align to it.
const OPTION_TEXT_INDENT = "ml-6 max-md:pointer-coarse:ml-7";

interface QuestionOptionRowProps {
  checked: boolean;
  label: string;
  description?: string;
  multiSelect: boolean;
  onSelect: () => void;
  shortcut?: QuestionShortcut;
  /** Single-select rows form a radio group with one tab stop. */
  tabStop: boolean;
}

function QuestionOptionRow({
  checked,
  label,
  description,
  multiSelect,
  onSelect,
  shortcut,
  tabStop,
}: QuestionOptionRowProps) {
  return (
    <button
      type="button"
      role={multiSelect ? "checkbox" : "radio"}
      aria-checked={checked}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      tabIndex={tabStop ? 0 : -1}
      onClick={onSelect}
      // The row's padding extends its hover fill and focus outline 8px past
      // the content edge, while the radio and label stay on it. A phone row
      // reaches the 44px touch target.
      className="group -mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-state-hover hover:duration-0 disabled:cursor-default disabled:hover:bg-transparent max-md:pointer-coarse:py-[11px]"
    >
      <span
        className={cn(
          "mt-[2.5px] flex size-3.5 shrink-0 items-center justify-center border transition-colors duration-150 motion-reduce:transition-none max-md:pointer-coarse:mt-[2px] max-md:pointer-coarse:size-[18px]",
          multiSelect ? "rounded" : "rounded-full",
          checked
            ? "border-amber-600 bg-amber-600 text-white dark:border-amber-400 dark:bg-amber-400 dark:text-amber-950"
            : "border-foreground/55 group-hover:border-foreground/80",
        )}
      >
        {checked ? (
          multiSelect ? (
            <Icon name="Check" className="size-2.5" aria-hidden />
          ) : (
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
          )
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
          className="mt-px shrink-0 text-xs font-medium tabular-nums text-muted-foreground max-md:pointer-coarse:hidden"
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
      className={cn(
        "mb-1 mt-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background/60 px-2.5 py-2 font-mono text-[12.5px] leading-relaxed text-foreground max-md:pointer-coarse:text-xs",
        OPTION_TEXT_INDENT,
      )}
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

/**
 * Navigation between questions. A wide card shows every label as underline
 * tabs; a narrow viewport (BB's compact layout, where the labels no longer fit)
 * shows one dot per question beside the current label.
 */
function QuestionTabs({
  currentIndex,
  formState,
  onSelect,
  questions,
}: QuestionTabsProps) {
  const compact = useIsCompactViewport();
  const steps = questions.map((question, index) => ({
    question,
    index,
    active: index === currentIndex,
    answered: isQuestionAnswered(question, answerStateFor(formState, question)),
  }));
  const current = steps[currentIndex];
  if (compact)
    return (
      <div className="mb-1 flex shrink-0 items-center gap-2.5">
        <div className="flex items-center">
          {steps.map(({ question, index, active, answered }) => (
            <button
              key={question.id}
              type="button"
              onClick={() => onSelect(index)}
              aria-current={active ? "step" : undefined}
              aria-label={`${question.shortLabel}${answered ? ", answered" : ""}`}
              title={plainText(question.prompt)}
              className="group flex cursor-pointer items-center px-[3px] py-2.5 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring max-md:pointer-coarse:py-[18px]"
            >
              <span
                className={cn(
                  "block h-[7px] rounded-full transition-all duration-150 motion-reduce:transition-none",
                  active
                    ? "w-[18px] bg-amber-600 dark:bg-amber-400"
                    : answered
                      ? "w-[7px] bg-amber-600/70 dark:bg-amber-500/70"
                      : "w-[7px] bg-foreground/20 group-hover:bg-foreground/40",
                )}
              />
            </button>
          ))}
        </div>
        <span className="flex min-w-0 items-center gap-1 text-[13px] font-medium text-foreground">
          {current?.answered ? (
            <Icon
              name="Check"
              aria-hidden
              className="size-3 shrink-0 text-amber-700 dark:text-amber-300"
            />
          ) : null}
          <span className="truncate">{current?.question.shortLabel}</span>
        </span>
        <span className="ml-auto shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
          {currentIndex + 1} of {questions.length}
        </span>
      </div>
    );
  return (
    <div className="mb-1.5 flex shrink-0 gap-5 border-b border-border">
      {steps.map(({ question, index, active, answered }) => (
        <button
          key={question.id}
          type="button"
          onClick={() => onSelect(index)}
          aria-current={active ? "step" : undefined}
          title={plainText(question.prompt)}
          // The active tab's underline overlays the strip's baseline.
          className={cn(
            "-mb-px flex min-w-0 max-w-[180px] shrink cursor-pointer items-center gap-1 border-b-2 pb-1.5 pt-0.5 text-[12.5px] font-medium leading-[1.6] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
            active
              ? "border-amber-600 text-foreground dark:border-amber-400"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {answered ? (
            <Icon
              name="Check"
              aria-hidden
              className="size-3 shrink-0 text-amber-700 dark:text-amber-300"
            />
          ) : null}
          <span className="truncate">{question.shortLabel}</span>
          {answered ? <span className="sr-only">, answered</span> : null}
        </button>
      ))}
    </div>
  );
}

interface QuestionInputBlockProps {
  disabled: boolean;
  question: Question;
  state: QuestionAnswerState;
  onToggleOption: (optionValue: string) => void;
  onSelectOther: () => void;
  onFreeTextChange: (value: string) => void;
  onAttachmentsChange: (attachments: QuestionAttachment[]) => void;
  onShortcutSubmit: () => void;
  /** What Enter does in the answer field: go to the next question or submit. */
  advance: "next" | "submit";
  shortcuts: ReadonlyMap<string, QuestionShortcut>;
}

/** The character count appears only as the answer nears its limit. */
const FREE_TEXT_COUNT_THRESHOLD = Math.floor(MAX_FREE_TEXT_LENGTH * 0.8);

function QuestionInputBlock({
  disabled,
  question,
  state,
  onToggleOption,
  onSelectOther,
  onFreeTextChange,
  onAttachmentsChange,
  onShortcutSubmit,
  advance,
  shortcuts,
}: QuestionInputBlockProps) {
  const options = question.options;
  const softKeyboard = useIsCompactViewport() && usePointerCoarse();
  const { projectId } = useBbContext();
  const sdk = useSdk();
  const [uploading, setUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const freeformLabel = `${question.shortLabel} answer`;
  const attachFiles = async (files: File[]) => {
    if (!projectId || files.length === 0) return;
    setUploading(true);
    setAttachmentError(null);
    try {
      const uploaded = await Promise.all(
        files.map((file) =>
          sdk.projects.attachments.upload({ projectId, clientFile: file }),
        ),
      );
      onAttachmentsChange([
        ...state.otherAttachments,
        ...uploaded.map((attachment) => ({ ...attachment, projectId })),
      ]);
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // A radio group has one tab stop, on the chosen row (the first when none is
  // chosen); arrow keys move the choice, as they do for native radios.
  const rowCount =
    options.length + (question.allowFreeText && options.length > 0 ? 1 : 0);
  const chosenRow = state.otherSelected
    ? options.length
    : options.findIndex((option) => state.selected.includes(option.value));
  const tabStopIndex = chosenRow >= 0 && chosenRow < rowCount ? chosenRow : 0;
  const moveRadioSelection = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (step === 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
    const current = rows.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    const next = rows[(current + step + rows.length) % rows.length]!;
    next.focus();
    next.click();
  };

  return (
    <fieldset
      disabled={disabled}
      className="min-w-0"
      aria-describedby={question.details ? `${question.id}-details` : undefined}
    >
      <legend className="sr-only">{plainText(question.prompt)}</legend>
      {question.prompt ? (
        <div
          id={`${question.id}-prompt`}
          role="heading"
          aria-level={2}
          // The question carries the card's extra top spacing, so question
          // tabs, when shown, sit close to the card's top edge.
          className={cn("pt-2 font-medium tracking-[-0.006em]", PROMPT_CLASS)}
        >
          <Markdown content={question.prompt} className={MARKDOWN_CLASS} />
        </div>
      ) : null}
      {question.details ? (
        <div
          id={`${question.id}-details`}
          className="mt-2 text-[13px] leading-[1.5] max-md:pointer-coarse:text-sm [text-wrap:pretty]"
        >
          <Markdown
            content={formatQuestionText(question.details)}
            className={DETAILS_CLASS}
          />
        </div>
      ) : null}
      <div
        role={question.multiSelect ? "group" : "radiogroup"}
        aria-labelledby={`${question.id}-prompt`}
        onKeyDown={question.multiSelect ? undefined : moveRadioSelection}
        className={cn("space-y-px", question.details ? "mt-3" : "mt-2")}
      >
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
                tabStop={question.multiSelect || tabStopIndex === index}
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
            tabStop={question.multiSelect || tabStopIndex === options.length}
          />
        ) : null}
      </div>
      {state.otherSelected ? (
        <div
          className={cn(
            "mt-2 overflow-hidden rounded-lg border border-border bg-background/50 focus-within:border-ring/50 focus-within:ring-1 focus-within:ring-ring/30",
            options.length > 0 && OPTION_TEXT_INDENT,
          )}
        >
          <input
            ref={fileInputRef}
            aria-label="Attach files or images"
            className="hidden"
            type="file"
            multiple
            onChange={(event) =>
              void attachFiles(Array.from(event.currentTarget.files ?? []))
            }
          />
          <textarea
            aria-label={freeformLabel}
            rows={2}
            value={state.otherText}
            maxLength={MAX_FREE_TEXT_LENGTH}
            placeholder="Type an answer or paste an image…"
            onChange={(event) => onFreeTextChange(event.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length > 0) {
                event.preventDefault();
                void attachFiles(files);
              }
            }}
            onKeyDown={(event) => {
              if (
                softKeyboard ||
                event.nativeEvent.isComposing ||
                event.key !== "Enter" ||
                event.shiftKey
              )
                return;
              event.preventDefault();
              onShortcutSubmit();
            }}
            className="block max-h-28 min-h-14 w-full resize-y bg-transparent px-3 py-2.5 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground max-md:pointer-coarse:text-base"
          />
          {state.otherAttachments.length > 0 ? (
            <ul
              aria-label="Attached files"
              className="flex flex-wrap gap-1.5 px-2.5 pb-2"
            >
              {state.otherAttachments.map((attachment) => (
                <li
                  key={`${attachment.projectId}:${attachment.path}`}
                  className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
                >
                  <Icon
                    name={
                      attachment.type === "localImage" ? "Image" : "Paperclip"
                    }
                    className="size-3.5"
                    aria-hidden
                  />
                  <span className="max-w-40 truncate">
                    {attachment.name ?? attachment.path.split("/").at(-1)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name ?? "attachment"}`}
                    onClick={() =>
                      onAttachmentsChange(
                        state.otherAttachments.filter(
                          (item) =>
                            item.path !== attachment.path ||
                            item.projectId !== attachment.projectId,
                        ),
                      )
                    }
                    className="rounded-sm text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="Close" className="size-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {attachmentError ? (
            <p role="alert" className="px-3 pb-2 text-xs text-destructive">
              {attachmentError}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3 border-t border-border/70 px-2 py-1">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Attach files or images"
                disabled={disabled || uploading || !projectId}
                onClick={() => fileInputRef.current?.click()}
                className="size-7"
              >
                {uploading ? (
                  <Icon name="Spinner" className="size-4 animate-spin" />
                ) : (
                  <Icon name="Plus" className="size-4" />
                )}
              </Button>
              {!projectId ? (
                <span className="text-xs text-muted-foreground">
                  Attachments need a project.
                </span>
              ) : null}
            </div>
            <div className="text-right text-xs text-muted-foreground">
              {state.otherText.length >= FREE_TEXT_COUNT_THRESHOLD ? (
                <div>
                  {state.otherText.length}/{MAX_FREE_TEXT_LENGTH}
                </div>
              ) : null}
              {softKeyboard ? null : (
                <div>
                  {advance === "submit" ? "Enter to submit" : "Enter for next"}{" "}
                  · Shift+Enter for a new line
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}

/** Digit-key shortcuts for 1–9, for a form BB's question host does not serve. */
const LOCAL_SHORTCUTS: ReadonlyMap<string, QuestionShortcut> = new Map(
  Array.from({ length: 9 }, (_, index) => [
    String(index),
    { label: String(index + 1), ariaKeyshortcuts: String(index + 1) },
  ]),
);

function isEditableTarget(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
      target.isContentEditable)
  );
}

// The scroll area's mask reads these two lengths (0 when an edge has nothing
// beyond it), so the fade is a class, and the hook only reports the edges.
const FADE_MASK_CLASS =
  "[mask-image:linear-gradient(to_bottom,transparent,#000_var(--fade-top,0px),#000_calc(100%_-_var(--fade-bottom,0px)),transparent)]";

/**
 * Fades the edges of a scroll area that has content beyond them, since the
 * scrollbar alone is too faint a cue that an option is cut off. A mask fades
 * the content itself, so it works on any card tint.
 */
function useScrollFade(ref: RefObject<HTMLElement | null>) {
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const update = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const top = node.scrollTop > 1;
    const bottom = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
    setEdges((current) =>
      current.top === top && current.bottom === bottom
        ? current
        : { top, bottom },
    );
  }, [ref]);
  // Content height changes with the question and with the answer field.
  useEffect(update);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    for (const child of Array.from(node.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [ref, update]);
  return {
    onScroll: update,
    style: {
      "--fade-top": edges.top ? "12px" : undefined,
      "--fade-bottom": edges.bottom ? "28px" : undefined,
    } as CSSProperties,
  };
}

export interface QuestionFormProps {
  persistenceKey?: string;
  questions: readonly Question[];
  disabled: boolean;
  cancelDisabled: boolean;
  onSubmit: (answers: Record<string, QuestionAnswer>) => void;
  onCancel: () => void;
  /** A failed submit or cancel, shown in the footer beside the buttons. */
  error?: string | null;
}

export function QuestionForm({
  persistenceKey,
  questions,
  disabled,
  cancelDisabled,
  onSubmit,
  onCancel,
  error,
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
  const latestFormState = useRef(formState);
  latestFormState.current = formState;
  const persistDraft = useCallback(
    (state: QuestionFormState) => {
      if (!storageKey) return;
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(state));
      } catch {
        /* Keep the form usable without storage. */
      }
    },
    [storageKey],
  );
  useEffect(() => {
    if (!storageKey) return;
    const timeout = window.setTimeout(() => persistDraft(formState), 250);
    return () => window.clearTimeout(timeout);
  }, [storageKey, formState, persistDraft]);
  useEffect(() => () => persistDraft(latestFormState.current), [persistDraft]);
  const formRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollFade = useScrollFade(scrollRef);
  const host = useQuestionFormHost();
  const { registerChoiceHandler } = host;
  // A restored question renders outside BB's question host, which then binds
  // no shortcuts; the form binds the digit keys itself, while focus is inside.
  const ownsShortcuts = host.shortcuts.size === 0;
  const shortcuts = ownsShortcuts ? LOCAL_SHORTCUTS : host.shortcuts;
  const totalQuestions = questions.length;
  const currentQuestion = questions[currentIndex] ?? null;
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === totalQuestions - 1;
  const currentState = answerStateFor(
    formState,
    currentQuestion ?? questions[0]!,
  );
  const stateForAnswers = formState;
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
    setCurrentIndex((index) => Math.min(index + 1, totalQuestions - 1));
  };

  const applyChoice = useCallback(
    (index: number): boolean => {
      if (currentQuestion === null) return false;
      const choice = resolveQuestionShortcutChoice(currentQuestion, index);
      if (!choice) return false;
      if (choice.kind === "option") {
        handleToggleOption(currentQuestion, choice.value);
        formRef.current?.focus();
      } else handleSelectOther(currentQuestion);
      return true;
    },
    [currentQuestion, handleToggleOption, handleSelectOther],
  );

  useEffect(() => {
    if (disabled) return;
    return registerChoiceHandler(applyChoice);
  }, [disabled, registerChoiceHandler, applyChoice]);

  if (!currentQuestion) return null;

  return (
    <div
      ref={formRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (
          ownsShortcuts &&
          !disabled &&
          /^[1-9]$/.test(event.key) &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.nativeEvent.isComposing &&
          !isEditableTarget(event.target)
        ) {
          if (applyChoice(Number(event.key) - 1)) event.preventDefault();
          return;
        }
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
      className="flex max-h-[min(36rem,65dvh)] min-h-0 flex-col text-foreground focus-visible:outline-none"
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
        ref={scrollRef}
        // Extends 8px into the card's padding so an option row's hover fill
        // and focus outline are not clipped; the bottom padding does the same
        // for the last row's outline.
        className={cn(
          "-mx-2 min-h-0 touch-pan-y overflow-y-auto overscroll-contain px-2 pb-1",
          FADE_MASK_CLASS,
        )}
        onScroll={scrollFade.onScroll}
        style={scrollFade.style}
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
          onFreeTextChange={(value) =>
            updateQuestionState(currentQuestion, (state) => ({
              ...state,
              otherText: value,
            }))
          }
          onAttachmentsChange={(attachments) =>
            updateQuestionState(currentQuestion, (state) => ({
              ...state,
              otherAttachments: attachments,
            }))
          }
          onShortcutSubmit={handleAdvance}
          advance={isLast ? "submit" : "next"}
          shortcuts={shortcuts}
        />
      </div>
      {/* An edge-to-edge footer strip like the recap card's, offset by the
          card's px-4 py-3 padding; its controls sit on the content's 16px
          insets (the ghost Cancel's padding is pulled back to match). */}
      <div className="-mx-4 -mb-3 mt-1.5 flex shrink-0 items-center justify-between gap-2 rounded-b-[calc(var(--radius-lg,0.5rem)-1px)] border-t border-amber-900/10 bg-amber-500/[0.05] px-4 py-1.5 dark:border-amber-200/15 dark:bg-amber-300/[0.04]">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn("-ml-2 px-2", FOOTER_BUTTON_CLASS)}
          disabled={cancelDisabled}
          onClick={onCancel}
        >
          Cancel
        </Button>
        {error ? (
          <p
            role="alert"
            title={error}
            className="line-clamp-2 min-w-0 flex-1 text-xs leading-snug text-red-700 dark:text-red-300"
          >
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          {!isFirst ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={cn("bg-background/60", FOOTER_BUTTON_CLASS)}
              disabled={disabled}
              onClick={() => setCurrentIndex((index) => Math.max(index - 1, 0))}
            >
              Back
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            className={FOOTER_BUTTON_CLASS}
            disabled={disabled || (isLast && !allAnswered)}
            onClick={handleAdvance}
          >
            {disabled ? (
              <Icon name="Spinner" className="size-3 animate-spin" />
            ) : null}
            {disabled ? "Submitting…" : isLast ? "Submit" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
