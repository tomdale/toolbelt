import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { selectDisplayTasks, selectTodoCounts } from "./state/selectors.js";
import type { TaskState } from "./state/state.js";
import type { Task, TaskStatus } from "./tool/types.js";

export interface TodosEditorResult {
	state: TaskState;
	changed: boolean;
}

type EditableField = "subject" | "description" | "activeForm" | "status" | "owner";
type Mode = "list" | "fields" | "input";

const EDITABLE_FIELDS: Array<{ id: EditableField; label: string }> = [
	{ id: "subject", label: "Subject" },
	{ id: "description", label: "Description" },
	{ id: "activeForm", label: "Active form" },
	{ id: "status", label: "Status" },
	{ id: "owner", label: "Owner" },
];
const STATUS_ORDER: TaskStatus[] = ["pending", "in_progress", "completed"];

function cloneTask(task: Task): Task {
	return {
		...task,
		...(task.blockedBy ? { blockedBy: [...task.blockedBy] } : {}),
		...(task.metadata ? { metadata: structuredClone(task.metadata) } : {}),
	};
}

export function cloneTaskState(state: TaskState): TaskState {
	return { tasks: state.tasks.map(cloneTask), nextId: state.nextId };
}

function comparableState(state: TaskState): string {
	return JSON.stringify(state);
}

function visibleTasks(state: TaskState): Task[] {
	return selectDisplayTasks(state).map(({ task }) => task);
}

function canonicalizeVisibleOrder(state: TaskState, orderedVisible: readonly Task[]): TaskState {
	const deleted = state.tasks.filter((task) => task.status === "deleted");
	return { tasks: [...orderedVisible, ...deleted], nextId: state.nextId };
}

function siblingTasks(state: TaskState, task: Task): Task[] {
	return visibleTasks(state).filter((candidate) => candidate.parentId === task.parentId);
}

function subtreeIds(state: TaskState, taskId: number): Set<number> {
	const ids = new Set<number>([taskId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const task of visibleTasks(state)) {
			if (task.parentId !== undefined && ids.has(task.parentId) && !ids.has(task.id)) {
				ids.add(task.id);
				changed = true;
			}
		}
	}
	return ids;
}

function reorderSibling(state: TaskState, taskId: number, offset: -1 | 1): TaskState {
	const task = visibleTasks(state).find((candidate) => candidate.id === taskId);
	if (!task) return state;
	const siblings = siblingTasks(state, task);
	const index = siblings.findIndex((candidate) => candidate.id === taskId);
	const target = siblings[index + offset];
	if (!target) return state;

	const ordered = visibleTasks(state);
	const taskIds = subtreeIds(state, task.id);
	const targetIds = subtreeIds(state, target.id);
	const taskBlock = ordered.filter((candidate) => taskIds.has(candidate.id));
	const targetBlock = ordered.filter((candidate) => targetIds.has(candidate.id));
	const firstOriginal = Math.min(
		ordered.findIndex((candidate) => taskIds.has(candidate.id)),
		ordered.findIndex((candidate) => targetIds.has(candidate.id)),
	);
	const moved = new Set([...taskIds, ...targetIds]);
	const first = ordered.slice(0, firstOriginal).filter((candidate) => !moved.has(candidate.id)).length;
	const remainder = ordered.filter((candidate) => !moved.has(candidate.id));
	const before = remainder.slice(0, first);
	const after = remainder.slice(first);
	const blocks = offset < 0 ? [...taskBlock, ...targetBlock] : [...targetBlock, ...taskBlock];
	return canonicalizeVisibleOrder(state, [...before, ...blocks, ...after]);
}

export function moveTaskUp(state: TaskState, taskId: number): TaskState {
	return reorderSibling(state, taskId, -1);
}

export function moveTaskDown(state: TaskState, taskId: number): TaskState {
	return reorderSibling(state, taskId, 1);
}

export function indentTask(state: TaskState, taskId: number): TaskState {
	const task = visibleTasks(state).find((candidate) => candidate.id === taskId);
	if (!task) return state;
	const siblings = siblingTasks(state, task);
	const index = siblings.findIndex((candidate) => candidate.id === taskId);
	const previous = siblings[index - 1];
	if (!previous) return state;
	const tasks = state.tasks.map((candidate) =>
		candidate.id === task.id ? { ...candidate, parentId: previous.id } : candidate,
	);
	return { tasks, nextId: state.nextId };
}

export function outdentTask(state: TaskState, taskId: number): TaskState {
	const task = visibleTasks(state).find((candidate) => candidate.id === taskId);
	if (!task || task.parentId === undefined) return state;
	const parent = state.tasks.find((candidate) => candidate.id === task.parentId);
	if (!parent) return state;
	const updated = state.tasks.map((candidate) => {
		if (candidate.id !== task.id) return candidate;
		const next = { ...candidate };
		if (parent.parentId === undefined) delete next.parentId;
		else next.parentId = parent.parentId;
		return next;
	});
	const interim = { tasks: updated, nextId: state.nextId };
	const ordered = visibleTasks(interim);
	const movedIds = subtreeIds(interim, task.id);
	const parentIds = subtreeIds(interim, parent.id);
	for (const id of movedIds) parentIds.delete(id);
	const moved = ordered.filter((candidate) => movedIds.has(candidate.id));
	const remainder = ordered.filter((candidate) => !movedIds.has(candidate.id));
	const parentEnd = remainder.reduce((last, candidate, index) => (parentIds.has(candidate.id) ? index + 1 : last), 0);
	return canonicalizeVisibleOrder(interim, [
		...remainder.slice(0, parentEnd),
		...moved,
		...remainder.slice(parentEnd),
	]);
}

export function deleteTaskFromEditor(state: TaskState, taskId: number): TaskState {
	const task = state.tasks.find((candidate) => candidate.id === taskId);
	if (!task || task.status === "deleted") return state;
	return {
		tasks: state.tasks.map((candidate) => {
			if (candidate.id === task.id) return { ...candidate, status: "deleted" };
			if (candidate.parentId !== task.id) return candidate;
			const promoted = { ...candidate };
			if (task.parentId === undefined) delete promoted.parentId;
			else promoted.parentId = task.parentId;
			return promoted;
		}),
		nextId: state.nextId,
	};
}

export function addTaskFromEditor(state: TaskState, subject: string, afterTaskId?: number): TaskState {
	const trimmed = subject.trim();
	if (!trimmed) return state;
	const after = afterTaskId === undefined ? undefined : state.tasks.find((task) => task.id === afterTaskId);
	const task: Task = { id: state.nextId, subject: trimmed, status: "pending" };
	if (after?.parentId !== undefined) task.parentId = after.parentId;
	const tasks = [...state.tasks];
	const index = after ? tasks.findIndex((candidate) => candidate.id === after.id) + 1 : tasks.length;
	tasks.splice(index, 0, task);
	return { tasks, nextId: state.nextId + 1 };
}

export function formatTodoStateForAgent(state: TaskState): string {
	const display = selectDisplayTasks(state);
	const lines = [
		"The user edited the Todo list in the /todos TUI. Treat this complete snapshot as the current Todo state:",
	];
	if (display.length === 0) return `${lines[0]}\n\n(no todos)`;
	for (const { task, label, prefix } of display) {
		const details = [
			`id=#${task.id}`,
			`status=${task.status}`,
			task.parentId !== undefined ? `parentId=#${task.parentId}` : undefined,
			task.description ? `description=${JSON.stringify(task.description)}` : undefined,
			task.activeForm ? `activeForm=${JSON.stringify(task.activeForm)}` : undefined,
			task.blockedBy?.length ? `blockedBy=${task.blockedBy.map((id) => `#${id}`).join(",")}` : undefined,
			task.owner ? `owner=${JSON.stringify(task.owner)}` : undefined,
			task.metadata ? `metadata=${JSON.stringify(task.metadata)}` : undefined,
		].filter(Boolean);
		lines.push(`${prefix}${label} ${task.subject} [${details.join("; ")}]`);
	}
	return lines.join("\n");
}

function fieldValue(task: Task, field: EditableField): string {
	return field === "status" ? task.status : (task[field] ?? "");
}

function withFieldValue(task: Task, field: EditableField, value: string): Task {
	if (field === "status") return { ...task, status: value as TaskStatus };
	const next = { ...task };
	const trimmed = value.trim();
	if (field === "subject") {
		if (trimmed) next.subject = trimmed;
		return next;
	}
	if (trimmed) next[field] = trimmed;
	else delete next[field];
	return next;
}

function statusGlyph(status: TaskStatus): string {
	if (status === "in_progress") return "◐";
	if (status === "completed") return "✓";
	return "○";
}

export class TodosEditor implements Component, Focusable {
	private readonly original: TaskState;
	private draft: TaskState;
	private selected = 0;
	private scroll = 0;
	private mode: Mode = "list";
	private fieldIndex = 0;
	private input = new Input();
	private inputPurpose: "add" | "edit" = "edit";
	private _focused = false;

	constructor(
		state: TaskState,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: (result: TodosEditorResult) => void,
	) {
		this.original = cloneTaskState(state);
		this.draft = cloneTaskState(state);
		this.input.onSubmit = (value) => this.submitInput(value);
		this.input.onEscape = () => {
			this.mode = this.inputPurpose === "add" ? "list" : "fields";
		};
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.mode === "input";
	}

	getState(): TaskState {
		return cloneTaskState(this.draft);
	}

	private display() {
		return selectDisplayTasks(this.draft);
	}

	private selectedTask(): Task | undefined {
		return this.display()[this.selected]?.task;
	}

	private finish(): void {
		this.done({
			state: cloneTaskState(this.draft),
			changed: comparableState(this.original) !== comparableState(this.draft),
		});
	}

	private clampSelection(): void {
		const count = this.display().length;
		this.selected = Math.max(0, Math.min(this.selected, Math.max(0, count - 1)));
	}

	private replaceTask(task: Task): void {
		this.draft = {
			...this.draft,
			tasks: this.draft.tasks.map((candidate) => (candidate.id === task.id ? task : candidate)),
		};
	}

	private followTask(taskId: number): void {
		const index = this.display().findIndex(({ task }) => task.id === taskId);
		if (index >= 0) this.selected = index;
	}

	private beginInput(purpose: "add" | "edit", value = ""): void {
		this.inputPurpose = purpose;
		this.input.setValue(value);
		this.mode = "input";
		this.input.focused = this.focused;
	}

	private submitInput(value: string): void {
		if (this.inputPurpose === "add") {
			const selectedId = this.selectedTask()?.id;
			const beforeNextId = this.draft.nextId;
			this.draft = addTaskFromEditor(this.draft, value, selectedId);
			if (this.draft.nextId !== beforeNextId) {
				const addedId = beforeNextId;
				this.selected = this.display().findIndex(({ task }) => task.id === addedId);
			}
			this.mode = "list";
			return;
		}
		const task = this.selectedTask();
		if (task) this.replaceTask(withFieldValue(task, EDITABLE_FIELDS[this.fieldIndex]!.id, value));
		this.mode = "fields";
	}

	private cycleStatus(direction = 1): void {
		const task = this.selectedTask();
		if (!task) return;
		const current = Math.max(0, STATUS_ORDER.indexOf(task.status));
		const status = STATUS_ORDER[(current + direction + STATUS_ORDER.length) % STATUS_ORDER.length]!;
		this.replaceTask({ ...task, status });
	}

	handleInput(data: string): void {
		if (this.mode === "input") {
			this.input.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (this.mode === "fields") {
			if (matchesKey(data, Key.escape) || data === "q") this.mode = "list";
			else if (matchesKey(data, Key.up)) this.fieldIndex = Math.max(0, this.fieldIndex - 1);
			else if (matchesKey(data, Key.down))
				this.fieldIndex = Math.min(EDITABLE_FIELDS.length - 1, this.fieldIndex + 1);
			else if (matchesKey(data, Key.left) && EDITABLE_FIELDS[this.fieldIndex]?.id === "status") this.cycleStatus(-1);
			else if (matchesKey(data, Key.right) && EDITABLE_FIELDS[this.fieldIndex]?.id === "status") this.cycleStatus(1);
			else if (matchesKey(data, Key.enter)) {
				const field = EDITABLE_FIELDS[this.fieldIndex]!.id;
				if (field === "status") this.cycleStatus(1);
				else {
					const task = this.selectedTask();
					if (task) this.beginInput("edit", fieldValue(task, field));
				}
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape) || data === "q") this.finish();
		else if (matchesKey(data, Key.up)) this.selected--;
		else if (matchesKey(data, Key.down)) this.selected++;
		else if (matchesKey(data, Key.pageUp)) this.selected -= 8;
		else if (matchesKey(data, Key.pageDown)) this.selected += 8;
		else if (data === "a") this.beginInput("add");
		else if (data === "e" || matchesKey(data, Key.enter)) this.mode = "fields";
		else if (data === "C") {
			this.draft = { tasks: [], nextId: 1 };
			this.selected = 0;
			this.scroll = 0;
		} else if (data === "d" || matchesKey(data, Key.delete)) {
			const task = this.selectedTask();
			if (task) this.draft = deleteTaskFromEditor(this.draft, task.id);
		} else if (matchesKey(data, Key.ctrl("up")) || data === "K") {
			const task = this.selectedTask();
			if (task) {
				this.draft = moveTaskUp(this.draft, task.id);
				this.followTask(task.id);
			}
		} else if (matchesKey(data, Key.ctrl("down")) || data === "J") {
			const task = this.selectedTask();
			if (task) {
				this.draft = moveTaskDown(this.draft, task.id);
				this.followTask(task.id);
			}
		} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			const task = this.selectedTask();
			if (task) this.draft = indentTask(this.draft, task.id);
		} else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			const task = this.selectedTask();
			if (task) this.draft = outdentTask(this.draft, task.id);
		}
		this.clampSelection();
		this.tui.requestRender();
	}

	private fit(line: string, width: number): string {
		return truncateToWidth(line, Math.max(1, width), "…");
	}

	private renderTaskLines(width: number, height: number): string[] {
		const display = this.display();
		if (display.length === 0) return [this.theme.fg("muted", "  No todos. Press a to add one.")];
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + height) this.scroll = this.selected - height + 1;
		const lines: string[] = [];
		for (let index = this.scroll; index < Math.min(display.length, this.scroll + height); index++) {
			const { task, label, prefix } = display[index]!;
			const selected = index === this.selected;
			const marker = selected ? this.theme.fg("accent", "›") : " ";
			const subject = selected ? this.theme.fg("accent", this.theme.bold(task.subject)) : task.subject;
			lines.push(this.fit(`${marker} ${prefix}${statusGlyph(task.status)} ${label} ${subject}`, width));
			const metadata = [
				`#${task.id}`,
				task.status,
				task.parentId !== undefined ? `parent: #${task.parentId}` : undefined,
				task.activeForm ? `active: ${task.activeForm}` : undefined,
				task.owner ? `owner: ${task.owner}` : undefined,
				task.blockedBy?.length ? `blocked by: ${task.blockedBy.map((id) => `#${id}`).join(", ")}` : undefined,
				task.metadata ? `metadata: ${JSON.stringify(task.metadata)}` : undefined,
				task.description || undefined,
			].filter(Boolean);
			lines.push(this.fit(`    ${this.theme.fg("dim", metadata.join(" · "))}`, width));
		}
		return lines;
	}

	private renderFields(width: number): string[] {
		const task = this.selectedTask();
		if (!task) return [this.theme.fg("muted", "No task selected")];
		const lines = [this.theme.fg("accent", this.theme.bold(`Edit ${task.subject}`))];
		for (const [index, field] of EDITABLE_FIELDS.entries()) {
			const marker = index === this.fieldIndex ? this.theme.fg("accent", "›") : " ";
			lines.push(
				this.fit(
					`${marker} ${field.label}: ${fieldValue(task, field.id) || this.theme.fg("dim", "(empty)")}`,
					width,
				),
			);
		}
		lines.push("", this.theme.fg("dim", "↑↓ field · enter edit/cycle · ←→ status · esc/q back"));
		return lines;
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		const counts = selectTodoCounts(this.draft);
		const top = this.theme.fg("borderAccent", `┌${"─".repeat(Math.max(1, width - 2))}┐`);
		const bottom = this.theme.fg("borderAccent", `└${"─".repeat(Math.max(1, width - 2))}┘`);
		const content: string[] = [
			this.theme.fg("accent", this.theme.bold(`Todos  ${counts.completed}/${counts.total} completed`)),
			this.theme.fg("dim", "Detailed branch-local task editor"),
			"",
		];
		if (this.mode === "fields") content.push(...this.renderFields(innerWidth));
		else if (this.mode === "input") {
			const label = this.inputPurpose === "add" ? "Add todo" : `Edit ${EDITABLE_FIELDS[this.fieldIndex]!.label}`;
			content.push(
				this.theme.fg("accent", this.theme.bold(label)),
				this.input.render(innerWidth)[0]!,
				"",
				this.theme.fg("dim", "enter save · esc cancel"),
			);
		} else {
			content.push(...this.renderTaskLines(innerWidth, 12));
			content.push("", this.theme.fg("dim", "↑↓ select · e/enter edit · a add · d/del delete · C clear all"));
			content.push(
				this.theme.fg("dim", "ctrl+↑↓ or J/K reorder · tab/→ indent · shift+tab/← outdent · esc/q save & close"),
			);
		}
		const framed = content.map((line) => {
			const clipped = this.fit(line, innerWidth);
			const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
			return `${this.theme.fg("borderAccent", "│")} ${clipped}${padding} ${this.theme.fg("borderAccent", "│")}`;
		});
		return [top, ...framed, bottom];
	}

	invalidate(): void {
		this.input.invalidate();
	}
}
