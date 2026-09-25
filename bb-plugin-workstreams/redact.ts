export function redact(value: string): string {
  return value
    .replace(
      /\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{16,}|github_pat_[\w_]{16,}|xox[baprs]-[\w-]+)\b/g,
      "[redacted]",
    )
    .replace(/(Bearer\s+)[\w.\/-]+/gi, "$1[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    );
}
