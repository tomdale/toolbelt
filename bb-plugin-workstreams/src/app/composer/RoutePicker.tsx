/**
 * Compact Identity picker for phones.
 */
import { IdentityControl } from "./WorkstreamPicker.tsx";
import type { NewWork } from "./new-work.ts";

export function RoutePicker({ newWork }: { newWork: NewWork }) {
  return <IdentityControl newWork={newWork} />;
}
