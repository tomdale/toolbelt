import {
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { Hint } from "../Hint.tsx";
import { usePrefs } from "../prefs.ts";

/**
 * Icon-only Archive button in the thread header; the Threads settings section
 * turns it off. It archives through BB's own flow, as the sidebar row's
 * Archive does, so the confirmation for threads with children, the Undo toast,
 * and the move off the archived thread behave as they do everywhere else.
 * `archive` reports no result, so the button can't tell whether the user
 * confirmed and leaves where they land to BB (docs/bb-sdk-wishlist.md). The
 * recap card's Archive is a separate path: it goes through the server and is
 * offered only once the work is confirmed finished.
 */
export function ArchiveHeaderAction({
  threadId,
}: PluginThreadHeaderActionProps) {
  const { prefs } = usePrefs();
  const { threads } = experimental_useSidebarThreads({
    experimental_lifecycles: ["active"],
  });
  const actions = experimental_useSidebarThreadActions();

  // Hidden until the preferences load, so a turned-off button never flashes.
  // Archived threads aren't in the active list, and BB's optimistic archive
  // drops the thread from it at once, which retires the button with it.
  if (
    !prefs?.threads.showArchiveButton ||
    !threads.some((thread) => thread.id === threadId)
  )
    return null;

  return (
    <Hint label="Archive" side="bottom">
      <button
        type="button"
        className={buttonClass}
        aria-label="Archive"
        onClick={() => actions.archive(threadId)}
      >
        <Icon name="Archive" className="size-4" />
      </button>
    </Hint>
  );
}

/** The face of the Snooze button's icon form, so the two sit as a pair. */
const buttonClass =
  "inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
