/** Button styles shared by the Map tab's editor and organizing flow. */
const base =
  "inline-flex h-7 shrink-0 items-center justify-center rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50";

export const primaryButton = `${base} bg-primary text-primary-foreground hover:opacity-90`;
export const secondaryButton = `${base} border border-border hover:bg-state-hover`;
export const ghostButton = `${base} text-muted-foreground hover:bg-state-hover hover:text-foreground`;
