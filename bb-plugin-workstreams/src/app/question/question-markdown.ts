/**
 * Prepares agent-written question text for BB's Markdown renderer.
 *
 * That renderer follows CommonMark without soft-break preservation: a single
 * newline renders as a space, and a "•" is ordinary text. Agents write
 * plain-text lists and one-fact-per-line paragraphs exactly that way, so a
 * card would show them as one run-on paragraph. This restores the line
 * structure the agent wrote and leaves everything else, including fenced code,
 * untouched. Running it on its own output changes nothing.
 */

type LineKind = "blank" | "code" | "item" | "block" | "text";

interface Line {
  text: string;
  kind: LineKind;
}

const UNICODE_BULLET = /^([ \t]*)[•‣◦▪●∙·][ \t]+/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
/** Headings, quotes, table rows, HTML, thematic breaks and setext underlines,
 * and indented code: lines whose own syntax a trailing break would corrupt. */
const OTHER_BLOCK =
  /^(?:[ \t]*(?:#{1,6}(?:[ \t]|$)|>|\||<)|[ \t]*([-*_=])(?:[ \t]*\1){2,}[ \t]*$| {4}|\t)/;
/** A continuation line of a list item is indented at least this far. */
const ITEM_CONTINUATION_INDENT = 2;

function classify(source: string): Line[] {
  let fence: string | null = null;
  return source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((raw): Line => {
      const marker = FENCE.exec(raw)?.[1];
      if (fence !== null) {
        if (
          marker !== undefined &&
          marker[0] === fence[0] &&
          marker.length >= fence.length &&
          raw.trim() === marker
        )
          fence = null;
        return { text: raw, kind: "code" };
      }
      if (marker !== undefined) {
        fence = marker;
        return { text: raw, kind: "code" };
      }
      if (raw.trim() === "") return { text: "", kind: "blank" };
      const text = raw.replace(UNICODE_BULLET, "$1- ");
      if (LIST_ITEM.test(text)) return { text, kind: "item" };
      return { text, kind: OTHER_BLOCK.test(text) ? "block" : "text" };
    });
}

const indentOf = (text: string) => text.length - text.trimStart().length;

export function formatQuestionText(source: string): string {
  const lines = classify(source);
  const out: string[] = [];
  // Whether the previous lines belong to an open list item, which an
  // unindented paragraph line ends rather than continues.
  let inList = false;
  lines.forEach(({ text, kind }, index) => {
    const previous = lines[index - 1]?.kind;
    const next = lines[index + 1];
    if (kind === "item" && previous === "text" && !inList) out.push("");
    if (
      kind === "text" &&
      inList &&
      indentOf(text) < ITEM_CONTINUATION_INDENT
    ) {
      if (previous !== "blank") out.push("");
      inList = false;
    }
    if (kind === "item") inList = true;
    if (kind === "block") inList = false;
    const continuesParagraph =
      (kind === "text" || kind === "item") &&
      next?.kind === "text" &&
      !(inList && indentOf(next.text) < ITEM_CONTINUATION_INDENT);
    out.push(
      continuesParagraph && !/(?: {2}|\\)$/.test(text)
        ? `${text.trimEnd()}  `
        : text,
    );
  });
  return out.join("\n");
}
