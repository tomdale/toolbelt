/**
 * Finds a place for the New thread composer's Topic field in BB's own picker
 * row, before the project picker, so it reads as one more of BB's fields.
 *
 * BB offers plugins no slot in that row. This keeps one anchor element of
 * ours at the start of the row's left group, located by BB's
 * `data-promptbox-project-control` marker (or the stock NewThreadPromptBox
 * structure when no project picker shows), and re-inserts it whenever BB
 * re-renders the row. BB's React only inserts and removes its own nodes, so
 * the extra child is left alone. If the markup changes and the row can't be
 * found, this returns null and the caller renders the field itself.
 *
 * The anchor is also marked as a plugin root. The plugin's utility classes are
 * scoped to plugin roots, and the row belongs to BB, so without the marker
 * only the classes BB's own stylesheet happens to define would style what is
 * portaled into the row.
 */
import { useLayoutEffect, useState } from "react";
import { usePortalScopeProps } from "@/lib/portal-scope";

const ROW_GROUP =
  "[data-promptbox-shell] > [data-promptbox] + div > :first-child";

function pickerGroup(root: HTMLElement): Element | null {
  return (
    root.querySelector("[data-promptbox-project-control]")?.parentElement ??
    root.querySelector(ROW_GROUP)
  );
}

export function useHostPickerRow(root: HTMLElement | null): HTMLElement | null {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const pluginId = usePortalScopeProps()["data-bb-plugin"];
  useLayoutEffect(() => {
    if (!root) return;
    const anchor = document.createElement("span");
    anchor.setAttribute("data-ws-workstream-slot", "");
    anchor.setAttribute("data-bb-plugin-root", "");
    if (pluginId !== undefined) anchor.setAttribute("data-bb-plugin", pluginId);
    anchor.style.display = "contents";
    const place = () => {
      const group = pickerGroup(root);
      if (!group) {
        anchor.remove();
        setTarget(null);
        return;
      }
      if (group.firstChild !== anchor)
        group.insertBefore(anchor, group.firstChild);
      setTarget(anchor);
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      anchor.remove();
      setTarget(null);
    };
  }, [root, pluginId]);
  return target;
}
