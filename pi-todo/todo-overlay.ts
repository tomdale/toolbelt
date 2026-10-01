/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form
 * registration in widgetContainerAbove, register-once + requestRender()
 * refresh, configurable collapse-not-scroll (default 12 content rows via
 * getMaxWidgetLines(); plus a trailing spacer row so the widget renders up
 * to 13 lines), Pi tool-output expansion awareness, auto-hide when empty.
 *
 * Reads live state via `getRenderState()` (the ctx-less foreground slot) at render
 * time — NEVER `replayFromBranch` from `tool_execution_end` (branch is stale;
 * `message_end` runs after).
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, getMaxWidgetLines, resolveCollapseKey } from "./config.js";
import { formatStatusLabel, t } from "./state/i18n-bridge.js";
import { selectDisplayTasks, selectHasActive, selectOverlayLayout, selectTodoCounts } from "./state/selectors.js";
import { getRenderState } from "./state/store.js";
import { formatOverlayTaskLine } from "./view/format.js";

const WIDGET_KEY = "rpiv-todos";

// English fallbacks for localized overlay chrome strings.
const OVERLAY_HEADING = "Todos";
const OVERLAY_MORE = "more";
const OVERLAY_EXPAND_HINT = "{key} to expand";
const OVERLAY_COLLAPSED = "collapsed";

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private lastNextId: number | undefined;
	private collapsed = false;

	setUICtx(ctx: ExtensionUIContext): void {
		// Identity-compare so repeat session_start handlers are idempotent;
		// on identity change (/reload) invalidate so update() re-registers.
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	update(): void {
		if (!this.uiCtx) return;
		const snapshot = this.getSnapshot();
		const visible = this.selectOverlayTasks(snapshot);

		if (visible.length === 0) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, factoryTheme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
						invalidate: () => {
							// No rendered strings are cached. Pi invalidates on theme changes;
							// the next render reads uiCtx.theme.
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	resetCompletedDisplayState(): void {
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.lastNextId = undefined;
	}

	hideCompletedTasksFromPreviousTurn(): void {
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const taskId of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(taskId);
		}
		this.completedTaskIdsPendingHide.clear();
		this.tui?.requestRender();
	}

	suspend(): void {
		if (!this.uiCtx || !this.widgetRegistered) return;
		this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	resume(): void {
		this.update();
	}

	toggleCollapse(): void {
		this.collapsed = !this.collapsed;
		// Forced full redraw on the collapsed↔expanded height step, mirroring the
		// lane-dock's requestRender(shapeChanged); distinct from the non-forced
		// requestRender() refresh paths in update()/hideCompletedTasksFromPreviousTurn().
		this.tui?.requestRender(true);
	}

	isRegistered(): boolean {
		return this.widgetRegistered;
	}

	private getSnapshot() {
		const state = getRenderState();
		if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
			this.resetCompletedDisplayState();
		}
		this.lastNextId = state.nextId;
		const completedTaskIds = new Set(
			state.tasks.filter((task) => task.status === "completed").map((task) => task.id),
		);
		for (const taskId of this.completedTaskIdsPendingHide) {
			if (!completedTaskIds.has(taskId)) this.completedTaskIdsPendingHide.delete(taskId);
		}
		for (const taskId of this.hiddenCompletedTaskIds) {
			if (!completedTaskIds.has(taskId)) this.hiddenCompletedTaskIds.delete(taskId);
		}
		return { tasks: [...state.tasks], nextId: state.nextId };
	}

	private selectOverlayTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>) {
		return snapshot.tasks.filter((task) => task.status !== "deleted" && !this.shouldHideCompletedTask(task));
	}

	private shouldHideCompletedTask(task: ReturnType<TodoOverlay["getSnapshot"]>["tasks"][number]): boolean {
		return task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id);
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const snapshot = this.getSnapshot();
		const overlayTasks = this.selectOverlayTasks(snapshot);
		if (overlayTasks.length === 0) return [];

		const overlayState = { tasks: overlayTasks, nextId: snapshot.nextId };
		const truncate = (line: string, maxWidth = width): string => truncateToWidth(line, maxWidth, "…");
		const counts = selectTodoCounts(overlayState);
		const hasActive = selectHasActive(overlayState);
		const displayTasks = new Map(selectDisplayTasks(overlayState).map((display) => [display.task.id, display]));

		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const headingText = `${t("overlay.heading", OVERLAY_HEADING)} (${counts.completed}/${counts.total})`;
		const heading = truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`);

		// Collapsed view: just the heading + a dim "└─" expand hint, then the
		// trailing spacer. Short-circuit before the budget math and the completed-
		// display tracking — nothing is shown to track, and skipping the tracking
		// when nothing is rendered is correctness, not optimization. The hint splices
		// the resolved key into the {key} placeholder (per-render, like the row
		// budget); a config edit needs /reload to re-bind the actual shortcut. The
		// "off" sentinel is reachable here mid-session (config edited after the
		// shortcut was bound and the overlay collapsed) — render a static collapsed
		// label instead of splicing the sentinel into the placeholder.
		if (this.collapsed) {
			const key = resolveCollapseKey();
			const hint =
				key === COLLAPSE_KEY_OFF
					? t("overlay.collapsed", OVERLAY_COLLAPSED)
					: t("overlay.expandHint", OVERLAY_EXPAND_HINT).replace("{key}", key);
			return [heading, truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`)];
		}

		const lines: string[] = [heading];
		// Pi's global tool-output expansion mode is read on every render so its
		// expand/collapse shortcut also expands this live widget. Optional chaining
		// preserves compatibility with hosts predating getToolsExpanded().
		const expanded = this.uiCtx?.getToolsExpanded?.() === true;
		const layoutTaskCount = snapshot.tasks.filter((task) => task.status !== "deleted").length;
		const columnCount = this.columnCount(width, layoutTaskCount);
		const taskRows = expanded
			? Math.max(1, Math.ceil(overlayTasks.length / columnCount))
			: Math.max(1, getMaxWidgetLines() - 1);
		const taskCapacity = taskRows * columnCount;
		const bodyBudget = expanded
			? overlayTasks.length
			: overlayTasks.length > taskCapacity
				? Math.max(1, (taskRows - 1) * columnCount + 1)
				: taskCapacity;
		const layout = selectOverlayLayout(overlayState, bodyBudget);
		const taskLines = layout.visible.map((task) => {
			const display = displayTasks.get(task.id);
			return formatOverlayTaskLine(task, theme, display?.label, display?.prefix);
		});
		lines.push(...this.renderTaskColumns(taskLines, width, columnCount));

		const newlyDisplayedCompletedTaskIds = overlayTasks
			.filter(
				(task) =>
					task.status === "completed" &&
					!this.completedTaskIdsPendingHide.has(task.id) &&
					!this.hiddenCompletedTaskIds.has(task.id),
			)
			.map((task) => task.id);
		for (const taskId of newlyDisplayedCompletedTaskIds) {
			this.completedTaskIdsPendingHide.add(taskId);
		}

		if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
			const last = lines.length - 1;
			lines[last] = lines[last].replace("├─", "└─");
			return lines;
		}

		const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
		const overflowParts: string[] = [];
		if (layout.hiddenCompleted > 0) overflowParts.push(`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`);
		if (layout.truncatedTail > 0) overflowParts.push(`${layout.truncatedTail} ${formatStatusLabel("pending")}`);
		const more = t("overlay.more", OVERLAY_MORE);
		const summary =
			overflowParts.length > 0 ? `+${totalHidden} ${more} (${overflowParts.join(", ")})` : `+${totalHidden} ${more}`;
		lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`));
		return lines;
	}

	private columnCount(width: number, taskCount: number): number {
		if (taskCount <= getMaxWidgetLines()) return 1;
		const minimumColumnWidth = 36;
		for (let count = 3; count >= 2; count--) {
			if (width >= count * minimumColumnWidth + (count - 1) * 2) return count;
		}
		return 1;
	}

	private renderTaskColumns(taskLines: string[], width: number, columnCount: number): string[] {
		if (columnCount === 1)
			return taskLines.map((line, index) =>
				truncateToWidth(line.replace("├─", index === taskLines.length - 1 ? "└─" : "├─"), width, "…"),
			);

		const gap = 2;
		const columnWidth = Math.max(1, Math.floor((width - gap * (columnCount - 1)) / columnCount));
		const rows: string[] = [];
		const rowCount = Math.ceil(taskLines.length / columnCount);
		for (let row = 0; row < rowCount; row++) {
			const columns: string[] = [];
			for (let column = 0; column < columnCount; column++) {
				const index = column * rowCount + row;
				const line = taskLines[index];
				if (line === undefined) break;
				const isLast = index === taskLines.length - 1;
				const rendered = truncateToWidth(line.replace("├─", isLast ? "└─" : "├─"), columnWidth, "…");
				columns.push(rendered + " ".repeat(Math.max(0, columnWidth - visibleWidth(rendered))));
			}
			rows.push(columns.join(" ".repeat(gap)));
		}
		return rows;
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.collapsed = false;
		this.resetCompletedDisplayState();
	}
}
