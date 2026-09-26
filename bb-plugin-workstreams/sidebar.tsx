import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ThreadTitle,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Analysis, WorkState } from "./model";
import {
  buildSidebar,
  type SidebarGroup,
  type SidebarRow,
} from "./sidebar-model";
import "./sidebar.css";

const STATE: Record<WorkState, { label: string; glyph: string }> = {
  needs_decision: { label: "Needs decision", glyph: "?" },
  ready_for_review: { label: "Ready for review", glyph: "✓" },
  blocked: { label: "Blocked", glyph: "■" },
  in_progress: { label: "In progress", glyph: "●" },
  done: { label: "Done", glyph: "○" },
};
const ACCENTS = [
  "#4fb3a9",
  "#e0a84f",
  "#e07a6a",
  "#9d8ce0",
  "#8fb87a",
  "#6f9fd8",
  "#d68cb0",
  "#c9a14a",
];
function accent(name: string): string {
  let hash = 0;
  for (const c of name.toLowerCase())
    hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return ACCENTS[hash % ACCENTS.length];
}

function useCollapsed() {
  const key = "workstreams:sidebar-collapsed";
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const toggle = (name: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        /* Collapse state is a convenience. */
      }
      return next;
    });
  return { collapsed, toggle };
}

type Menu = { threadId: string; x: number; y: number; pinned: boolean };

function Row({
  row,
  group,
  active,
  open,
  onMenu,
}: {
  row: SidebarRow;
  group?: string;
  active: boolean;
  open: (split: boolean) => void;
  onMenu: (m: Menu) => void;
}) {
  const state = row.state ? STATE[row.state] : null;
  const label = row.thread.hasPendingInteraction
    ? "Waiting for your input"
    : (state?.label ?? "Not analyzed");
  return (
    <li
      className={[
        "wss-row",
        active && "wss-active",
        row.needsYou && "wss-you",
        row.state === "done" && "wss-done",
        row.thread.isUnread && "wss-unread",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ paddingLeft: 6 + row.depth * 12 }}
    >
      <button
        type="button"
        title={[label, row.recap].filter(Boolean).join(" — ")}
        onClick={(e) => open(e.metaKey || e.ctrlKey)}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu({
            threadId: row.thread.id,
            x: e.clientX,
            y: e.clientY,
            pinned: row.thread.isPinned,
          });
        }}
      >
        <span
          className={`wss-state wss-state-${row.thread.hasPendingInteraction ? "needs_decision" : (row.state ?? "none")}`}
          aria-label={label}
        >
          {row.running ? <span className="wss-spin" /> : (state?.glyph ?? "·")}
        </span>
        <span className="wss-title">
          {group && (
            <span
              className="wss-pill"
              style={{ borderColor: accent(group) }}
              title={group}
            >
              {group}
            </span>
          )}
          <ThreadTitle threadId={row.thread.id} />
        </span>
      </button>
    </li>
  );
}

function Group({
  group,
  banner,
  collapsed,
  toggle,
  renderRow,
}: {
  group: SidebarGroup;
  banner?: string;
  collapsed: boolean;
  toggle: () => void;
  renderRow: (row: SidebarRow) => React.ReactNode;
}) {
  const [showDone, setShowDone] = useState(false);
  const open = group.rows.filter((r) => r.state !== "done" || r.running);
  const done = group.rows.filter((r) => r.state === "done" && !r.running);
  return (
    <section
      className="wss-group"
      style={{ "--wss-accent": accent(group.name) } as React.CSSProperties}
    >
      <button
        type="button"
        className="wss-head"
        aria-expanded={!collapsed}
        onClick={toggle}
        title={
          group.summary
            ? `${group.summary.about}\n${group.summary.needsYou ? `${group.summary.needsYou} need decision(s). ` : ""}${group.summary.status}`
            : undefined
        }
      >
        <span className="wss-caret">{collapsed ? "▸" : "▾"}</span>
        {banner ? (
          <img className="wss-banner" src={banner} alt={group.name} />
        ) : (
          <span className="wss-name">{group.name}</span>
        )}
        {group.needsYou > 0 && (
          <span className="wss-badge">{group.needsYou}</span>
        )}
        <span className="wss-count">{group.rows.length}</span>
      </button>
      {!collapsed && (
        <>
          {group.summary && (
            <p className="wss-summary">
              {group.summary.needsYou
                ? `${group.summary.needsYou} need decision${group.summary.needsYou === 1 ? "" : "s"} · `
                : ""}
              {group.summary.status}
            </p>
          )}
          <ul>{open.map(renderRow)}</ul>
          {done.length > 0 && (
            <>
              <button
                type="button"
                className="wss-more"
                onClick={() => setShowDone(!showDone)}
              >
                {showDone ? "Hide" : "Show"} {done.length} done
              </button>
              {showDone && <ul>{done.map(renderRow)}</ul>}
            </>
          )}
        </>
      )}
    </section>
  );
}

export function WorkstreamsThreadList({
  activeThreadId,
  onNavigate,
}: PluginThreadListProps) {
  const rpc = useRpc<typeof rpcContract>();
  const actions = experimental_useSidebarThreadActions();
  const { threads, sections, projects, status } =
    experimental_useSidebarThreads();
  const [data, setData] = useState<{
    analysis: Analysis | null;
    banners: Record<string, string>;
  }>({ analysis: null, banners: {} });
  const immediateCount = new Set([
    ...threads.filter((t) => t.hasPendingInteraction).map((t) => t.id),
    ...(data.analysis?.items
      .filter((i) => i.state === "needs_decision")
      .map((i) => i.threadId) ?? []),
  ]).size;
  const refresh = useCallback(async () => {
    try {
      setData(await rpc.call("sidebar"));
    } catch {
      /* Without analysis the list still groups by section and project. */
    }
  }, [rpc]);
  useRealtime("changed", refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const { collapsed, toggle } = useCollapsed();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [showAllNeedsYou, setShowAllNeedsYou] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);
  const model = useMemo(
    () =>
      buildSidebar(
        threads,
        data.analysis,
        new Map(sections.map((s) => [s.id, s.name])),
        new Map(projects.map((p) => [p.id, p.name])),
      ),
    [threads, sections, projects, data.analysis],
  );
  const open = (threadId: string, split: boolean) => {
    actions.open(threadId, { split });
    onNavigate();
  };
  const renderRow = (
    row: SidebarRow & { group?: string },
    showGroup = false,
  ) => (
    <Row
      key={row.thread.id}
      row={row}
      group={showGroup ? row.group : undefined}
      active={row.thread.id === activeThreadId}
      open={(split) => open(row.thread.id, split)}
      onMenu={setMenu}
    />
  );
  if (status === "loading")
    return <p className="wss-empty">Loading threads…</p>;
  return (
    <div className="wss">
      {model.needsYou.length > 0 && (
        <section className="wss-needs">
          <button
            type="button"
            className="wss-head wss-needs-head"
            aria-expanded={!collapsed.has("__needs")}
            onClick={() => toggle("__needs")}
          >
            <span className="wss-caret">
              {collapsed.has("__needs") ? "▸" : "▾"}
            </span>
            <span className="wss-name">Needs you</span>
            <span className="wss-count">{immediateCount}</span>
          </button>
          {!collapsed.has("__needs") && (
            <>
              <ul>{model.needsYou.map((r) => renderRow(r, true))}</ul>
              {model.needsYouRemaining > 0 && (
                <button
                  type="button"
                  className="wss-more"
                  onClick={() => setShowAllNeedsYou(!showAllNeedsYou)}
                >
                  {showAllNeedsYou
                    ? "Show fewer"
                    : `Show all ${model.needsYouRemaining} more`}
                </button>
              )}
              {showAllNeedsYou && model.needsYouRemaining > 0 && (
                <ul>
                  {/* The collapsed band is capped; this links to the extra
                      decisions in their own groups instead of duplicating rows. */}
                  {model.allNeedsYou.slice(6).map((r) => renderRow(r, true))}
                </ul>
              )}
            </>
          )}
        </section>
      )}
      {model.groups.map((g) => (
        <Group
          key={g.name}
          group={g}
          banner={data.banners[g.name]}
          collapsed={collapsed.has(g.name)}
          toggle={() => toggle(g.name)}
          renderRow={(r) => renderRow(r)}
        />
      ))}
      {model.other.length > 0 && (
        <Group
          group={{
            name: "Other",
            rows: model.other,
            needsYou: model.other.filter((r) => r.immediateAsk).length,
            summary: null,
          }}
          collapsed={collapsed.has("__other")}
          toggle={() => toggle("__other")}
          renderRow={(r) =>
            renderRow(r as SidebarRow & { group: string }, true)
          }
        />
      )}
      {menu && (
        <div
          className="wss-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          <button role="menuitem" onClick={() => open(menu.threadId, true)}>
            Open in split
          </button>
          <button
            role="menuitem"
            onClick={() => void actions.setPinned(menu.threadId, !menu.pinned)}
          >
            {menu.pinned ? "Unpin" : "Pin"}
          </button>
          <button
            role="menuitem"
            onClick={() => void actions.setRead(menu.threadId, false)}
          >
            Mark unread
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const title = prompt("Rename thread");
              if (title?.trim())
                void actions.rename(menu.threadId, title.trim());
            }}
          >
            Rename…
          </button>
          <button
            role="menuitem"
            onClick={() => actions.archive(menu.threadId)}
          >
            Archive
          </button>
        </div>
      )}
    </div>
  );
}
