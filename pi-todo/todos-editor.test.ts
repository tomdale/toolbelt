import { makeTheme, makeTui } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import type { TaskState } from "./state/state.js";
import {
	addTaskFromEditor,
	deleteTaskFromEditor,
	formatTodoStateForAgent,
	indentTask,
	moveTaskDown,
	moveTaskUp,
	outdentTask,
	TodosEditor,
} from "./todos-editor.js";

function state(): TaskState {
	return {
		tasks: [
			{ id: 1, subject: "Alpha", status: "pending" },
			{ id: 2, subject: "Alpha child", status: "pending", parentId: 1 },
			{ id: 3, subject: "Beta", status: "in_progress", description: "Detailed beta" },
			{ id: 4, subject: "Gamma", status: "completed" },
		],
		nextId: 5,
	};
}

function visibleSubjects(value: TaskState): string[] {
	return value.tasks.filter((task) => task.status !== "deleted").map((task) => task.subject);
}

describe("Todos editor hierarchy operations", () => {
	it("adds a pending sibling after the selected task", () => {
		const result = addTaskFromEditor(state(), "New task", 3);
		expect(result.nextId).toBe(6);
		expect(visibleSubjects(result)).toEqual(["Alpha", "Alpha child", "Beta", "New task", "Gamma"]);
		expect(result.tasks.find((task) => task.id === 5)).toMatchObject({ subject: "New task", status: "pending" });
	});

	it("deletes a task and promotes its direct children", () => {
		const result = deleteTaskFromEditor(state(), 1);
		expect(result.tasks.find((task) => task.id === 1)?.status).toBe("deleted");
		expect(result.tasks.find((task) => task.id === 2)?.parentId).toBeUndefined();
	});

	it("indents beneath the previous sibling and outdents after the parent subtree", () => {
		const nested = indentTask(state(), 4);
		expect(nested.tasks.find((task) => task.id === 4)?.parentId).toBe(3);
		const flat = outdentTask(nested, 4);
		expect(flat.tasks.find((task) => task.id === 4)?.parentId).toBeUndefined();
		expect(visibleSubjects(flat)).toEqual(["Alpha", "Alpha child", "Beta", "Gamma"]);
	});

	it("moves a sibling together with its descendants", () => {
		const down = moveTaskDown(state(), 1);
		expect(visibleSubjects(down)).toEqual(["Beta", "Alpha", "Alpha child", "Gamma"]);
		const restored = moveTaskUp(down, 1);
		expect(visibleSubjects(restored)).toEqual(["Alpha", "Alpha child", "Beta", "Gamma"]);
	});

	it("does not move a task outside its sibling group", () => {
		const result = moveTaskUp(state(), 2);
		expect(result).toEqual(state());
	});
});

describe("Todos editor component", () => {
	it("adds a task and commits the changed draft with q", () => {
		const done = vi.fn();
		const tui = makeTui();
		const editor = new TodosEditor({ tasks: [], nextId: 1 }, tui as never, makeTheme() as never, done);
		editor.focused = true;
		editor.handleInput("a");
		editor.handleInput("First task");
		editor.handleInput("\r");
		editor.handleInput("q");
		expect(done).toHaveBeenCalledWith({
			changed: true,
			state: { tasks: [{ id: 1, subject: "First task", status: "pending" }], nextId: 2 },
		});
	});

	it("keeps focus on a moved item across repeated J presses", () => {
		const done = vi.fn();
		const editor = new TodosEditor(state(), makeTui() as never, makeTheme() as never, done);
		editor.handleInput("J");
		editor.handleInput("J");
		editor.handleInput("q");
		expect(done.mock.calls[0]?.[0].state.tasks.map((task: { subject: string }) => task.subject)).toEqual([
			"Beta",
			"Gamma",
			"Alpha",
			"Alpha child",
		]);
	});

	it("clears the draft with uppercase C and commits on close", () => {
		const done = vi.fn();
		const editor = new TodosEditor(state(), makeTui() as never, makeTheme() as never, done);
		editor.handleInput("C");
		editor.handleInput("q");
		expect(done).toHaveBeenCalledWith({ changed: true, state: { tasks: [], nextId: 1 } });
	});

	it("closes an unchanged draft with escape", () => {
		const done = vi.fn();
		const editor = new TodosEditor(state(), makeTui() as never, makeTheme() as never, done);
		editor.handleInput("\u001b");
		expect(done).toHaveBeenCalledWith({ changed: false, state: state() });
	});
});

describe("Todos editor agent context", () => {
	it("formats the complete detailed hierarchy", () => {
		const output = formatTodoStateForAgent(state());
		expect(output).toContain("complete snapshot");
		expect(output).toContain("1. Alpha [id=#1; status=pending]");
		expect(output).toContain("└─ 1.1. Alpha child [id=#2; status=pending; parentId=#1]");
		expect(output).toContain('2. Beta [id=#3; status=in_progress; description="Detailed beta"]');
		expect(output).toContain("3. Gamma [id=#4; status=completed]");
	});
});
