/** Complete group lists use lexical names; attention-ranked views use their own order. */
export function compareGroupNames(a: string, b: string): number {
  return (
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: false }) ||
    a.localeCompare(b)
  );
}
