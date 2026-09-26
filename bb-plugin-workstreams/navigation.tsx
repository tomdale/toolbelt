import type { ExperimentalSidebarNavigationProps } from "@get-bb/plugin-sdk/app";

/** Preserve BB's native navigation layout and activation behavior. */
export function WorkstreamsNavigation({
  experimental_Original: Original,
}: ExperimentalSidebarNavigationProps) {
  return <Original />;
}
