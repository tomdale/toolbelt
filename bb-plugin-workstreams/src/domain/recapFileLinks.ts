/** Find a closing delimiter without treating escaped punctuation as syntax. */
function closingDelimiter(
  text: string,
  start: number,
  open: string,
  close: string,
) {
  let depth = 1;
  for (let at = start + 1; at < text.length; at++) {
    if (text[at] === "\\") at++;
    else if (open === "[" && text[at] === "`") {
      at = codeSpanEnd(text, at) - 1;
    } else if (
      open === "(" &&
      text[at] === "<" &&
      text.slice(start + 1, at).trim() === ""
    ) {
      const end = text.indexOf(">", at + 1);
      if (end === -1) return -1;
      at = end;
    } else if (
      open === "(" &&
      depth === 1 &&
      /[ \t]/.test(text[at - 1] ?? "") &&
      (text[at] === '"' || text[at] === "'")
    ) {
      const quote = text[at++];
      while (at < text.length && text[at] !== quote) {
        if (text[at] === "\\") at++;
        at++;
      }
      if (at === text.length) return -1;
    } else if (text[at] === open) depth++;
    else if (text[at] === close && --depth === 0) return at;
  }
  return -1;
}

/** Inline syntax must stay whole when the recap decorates hashes and mentions. */
export function* recapMarkdownSpans(text: string) {
  for (let at = 0; at < text.length; at++) {
    if (text[at] === "\\") {
      at++;
      continue;
    }
    if (text[at] === "`") {
      const end = codeSpanEnd(text, at);
      yield { index: at, text: text.slice(at, end), destination: null };
      at = end - 1;
      continue;
    }
    const url = /^(?:<https?:\/\/[^>\s]+>|https?:\/\/\S+)/.exec(text.slice(at));
    if (url) {
      yield { index: at, text: url[0], destination: null };
      at += url[0].length - 1;
      continue;
    }
    if (text[at] !== "[") continue;
    const labelEnd = closingDelimiter(text, at, "[", "]");
    if (labelEnd === -1 || text[labelEnd + 1] !== "(") continue;
    const start = labelEnd + 2;
    const end = closingDelimiter(text, start - 1, "(", ")");
    if (end === -1) continue;
    yield {
      index: at,
      text: text.slice(at, end + 1),
      destination: { start, end },
    };
    at = end;
  }
}

/** A code span closes only with a backtick run of the same length. */
function codeSpanEnd(text: string, start: number) {
  const marker = /^`+/.exec(text.slice(start))![0];
  let at = start + marker.length;
  while ((at = text.indexOf(marker, at)) !== -1) {
    const end = at + marker.length;
    if (text[at - 1] !== "`" && text[end] !== "`") return end;
    at = end;
  }
  return start + marker.length;
}

/**
 * Recap file destinations may contain literal spaces. Encode those before
 * Markdown parsing, where whitespace would otherwise end the destination.
 * Relative destinations belong to the recap's workspace; schemes and anchors
 * keep their own syntax. Code spans and link titles remain verbatim.
 */
export function normalizeRecapFileLinks(text: string): string {
  let output = "";
  let copied = 0;
  for (const span of recapMarkdownSpans(text)) {
    if (!span.destination) continue;
    const { start, end } = span.destination;
    // Angle-bracketed destinations already allow spaces and parentheses.
    const payload = text.slice(start, end);
    if (payload.trimStart().startsWith("<") || /[\r\n]/.test(payload)) {
      continue;
    }
    const parts =
      /^(\s*)(.*?)(\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\)))?(\s*)$/.exec(
        payload,
      );
    if (!parts) continue;
    const [, leading, destination, title = "", trailing] = parts;
    if (
      !/[ \t]/.test(destination!) ||
      /^(?:[a-z][a-z\d+.-]*:|\/\/|#|\?)/i.test(destination!) ||
      /[<>]|\s["']/.test(destination!)
    ) {
      continue;
    }
    const path = destination!
      .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (escape, char) =>
        char === "(" ? "%28" : char === ")" ? "%29" : escape,
      )
      .replace(/[ \t()]/g, (char) =>
        char === " "
          ? "%20"
          : char === "\t"
            ? "%09"
            : char === "("
              ? "%28"
              : "%29",
      );
    output += text.slice(copied, start) + leading + path + title + trailing;
    copied = end;
  }
  return copied ? output + text.slice(copied) : text;
}
