import type { Task, TaskStatus } from "../tool/types.js";
import type { TaskState } from "./state.js";

/**
 * Tasks excluding deleted tombstones, ordered depth-first by parentId. A child
 * whose parent is deleted or absent remains visible as a root so a tombstone or
 * malformed historic replay cannot hide active work.
 */
export function selectVisibleTasks(state: TaskState): readonly Task[] {
	const visible = state.tasks.filter((task) => task.status !== "deleted");
	const visibleIds = new Set(visible.map((task) => task.id));
	const children = new Map<number, Task[]>();
	const roots: Task[] = [];
	for (const task of visible) {
		if (task.parentId !== undefined && visibleIds.has(task.parentId)) {
			const siblings = children.get(task.parentId) ?? [];
			siblings.push(task);
			children.set(task.parentId, siblings);
		} else {
			roots.push(task);
		}
	}
	const ordered: Task[] = [];
	const visited = new Set<number>();
	const visit = (task: Task) => {
		if (visited.has(task.id)) return;
		visited.add(task.id);
		ordered.push(task);
		for (const child of children.get(task.id) ?? []) visit(child);
	};
	for (const root of roots) visit(root);
	// Historic snapshots predate parent validation; retain every task even if a
	// corrupt cycle leaves a component with no root.
	for (const task of visible) visit(task);
	return ordered;
}

export interface DisplayTask {
	task: Task;
	path: string;
	label: string;
	prefix: string;
}

/**
 * Presentation-only tree projection. `path` is derived from current visible
 * order; persistent task ids stay stable for the tool contract and never leak
 * into the hierarchy UI.
 */
export function selectDisplayTasks(state: TaskState): readonly DisplayTask[] {
	const visible = selectVisibleTasks(state);
	const visibleIds = new Set(visible.map((task) => task.id));
	const children = new Map<number, Task[]>();
	const roots: Task[] = [];
	for (const task of visible) {
		if (task.parentId !== undefined && visibleIds.has(task.parentId)) {
			const siblings = children.get(task.parentId) ?? [];
			siblings.push(task);
			children.set(task.parentId, siblings);
		} else {
			roots.push(task);
		}
	}

	const display: DisplayTask[] = [];
	const visited = new Set<number>();
	const visit = (task: Task, path: string, ancestorPrefix: string, isLast: boolean, isChild: boolean) => {
		if (visited.has(task.id)) return;
		visited.add(task.id);
		const prefix = isChild ? `${ancestorPrefix}${isLast ? "└─ " : "├─ "}` : "";
		display.push({ task, path, label: isChild ? path : `${path}.`, prefix });
		const descendants = children.get(task.id) ?? [];
		for (const [index, child] of descendants.entries()) {
			visit(
				child,
				`${path}.${index + 1}`,
				isChild ? `${ancestorPrefix}${isLast ? "   " : "│  "}` : "",
				index === descendants.length - 1,
				true,
			);
		}
	};
	for (const [index, root] of roots.entries()) visit(root, String(index + 1), "", index === roots.length - 1, false);
	// Historic snapshots predate parent validation; retain cyclic components.
	for (const task of visible) visit(task, String(display.length + 1), "", true, false);
	return display;
}

/**
 * Group visible tasks by status. Iteration order at the call site uses
 * (`completed`, `inProgress`, `pending`) to match the `/todos` header part
 * order pinned by `todo.command.test.ts`.
 */
export interface TasksByStatus {
	pending: readonly Task[];
	inProgress: readonly Task[];
	completed: readonly Task[];
}
export function selectTasksByStatus(state: TaskState): TasksByStatus {
	const visible = selectVisibleTasks(state);
	return {
		pending: visible.filter((t) => t.status === "pending"),
		inProgress: visible.filter((t) => t.status === "in_progress"),
		completed: visible.filter((t) => t.status === "completed"),
	};
}

/** Total counts for the overlay heading (`Todos (n/m)`) and `/todos` header. */
export interface TodoCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
}
export function selectTodoCounts(state: TaskState): TodoCounts {
	const groups = selectTasksByStatus(state);
	return {
		total: groups.pending.length + groups.inProgress.length + groups.completed.length,
		pending: groups.pending.length,
		inProgress: groups.inProgress.length,
		completed: groups.completed.length,
	};
}

/**
 * Resolve a task's subject by id from the live state for renderCall's
 * accent label. `undefined` when the id is unknown — caller falls back to
 * `#id` plain rendering.
 */
export function selectTaskSubjectById(state: TaskState, id: number): string | undefined {
	return state.tasks.find((t) => t.id === id)?.subject;
}

/**
 * Overlay layout decision. Encapsulates the "drop completed first, then
 * truncate non-completed tail" rule pre-refactor lived in
 * `todo-overlay.ts:144-188`. `budget` is the body-slot count (caller passes
 * `getMaxWidgetLines() - 1` to reserve the heading row); on overflow the
 * selector reserves one more slot internally for the summary row. Returns
 * the visible task slice plus the overflow summary parts.
 */
export interface OverlayLayout {
	visible: readonly Task[];
	hiddenCompleted: number;
	truncatedTail: number;
}
export function selectOverlayLayout(state: TaskState, budget: number): OverlayLayout {
	const all = selectVisibleTasks(state);
	if (all.length <= budget) {
		return { visible: all, hiddenCompleted: 0, truncatedTail: 0 };
	}
	const innerBudget = budget - 1;
	const nonCompleted = all.filter((t) => t.status !== "completed");
	const totalCompleted = all.length - nonCompleted.length;
	if (nonCompleted.length <= innerBudget) {
		const kept = new Set<Task>(nonCompleted);
		for (const t of all) {
			if (kept.size >= innerBudget) break;
			if (t.status === "completed") kept.add(t);
		}
		const visible = all.filter((t) => kept.has(t));
		const shownCompleted = visible.filter((t) => t.status === "completed").length;
		return { visible, hiddenCompleted: totalCompleted - shownCompleted, truncatedTail: 0 };
	}
	const visible = nonCompleted.slice(0, innerBudget);
	const truncatedTail = nonCompleted.length - innerBudget;
	return { visible, hiddenCompleted: totalCompleted, truncatedTail };
}

/**
 * Helper: whether any visible task is `pending` or `in_progress`. The overlay
 * uses this to pick the heading icon (`accent`+`●` vs `dim`+`○`).
 */
export function selectHasActive(state: TaskState): boolean {
	return selectVisibleTasks(state).some((t) => t.status === "in_progress" || t.status === "pending");
}

export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(["pending", "in_progress"]);
