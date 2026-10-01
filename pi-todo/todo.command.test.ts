import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TODO_EDITOR_STATE_ENTRY } from "./state/replay.js";
import type { TaskState } from "./state/state.js";
import { __resetState, registerTodosCommand, registerTodoTool, TOOL_NAME } from "./todo.js";

function setup(overrides: Parameters<typeof createMockPi>[0] = {}) {
	__resetState();
	const { pi, captured } = createMockPi(overrides);
	registerTodoTool(pi);
	registerTodosCommand(pi);
	const tool = captured.tools.get(TOOL_NAME);
	if (!tool) throw new Error("tool not registered");
	const cmd = captured.commands.get("todos");
	if (!cmd) throw new Error("command not registered");
	return { pi, tool, cmd };
}

async function seed(tool: ReturnType<typeof setup>["tool"], actions: Array<Record<string, unknown>>) {
	const ctx = createMockCtx({ sessionId: "test-session" });
	for (const params of actions) {
		await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);
	}
}

beforeEach(() => __resetState());
afterEach(() => {
	__resetState();
	vi.restoreAllMocks();
});

describe("/todos command", () => {
	it("registers the interactive hierarchical editor", () => {
		const { cmd } = setup();
		expect(cmd.description).toContain("edit");
		expect(cmd.description).toContain("hierarchical");
	});

	it("rejects non-interactive modes", async () => {
		const { cmd } = setup();
		const ctx = createMockCtx({ hasUI: false });
		await cmd.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
	});

	it("rejects unknown arguments", async () => {
		const { cmd } = setup();
		const ctx = createMockCtx({ hasUI: true, mode: "tui" });
		await cmd.handler("wat", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /todos or /todos clear", "error");
	});

	it("opens an overlay editor even when the list is empty", async () => {
		const state: TaskState = { tasks: [], nextId: 1 };
		const custom = vi.fn(async (..._args: unknown[]) => ({ state, changed: false }));
		const { cmd } = setup();
		const ctx = createMockCtx({ hasUI: true, mode: "tui", ui: { custom } as never });
		await cmd.handler("", ctx as never);
		expect(custom).toHaveBeenCalledTimes(1);
		expect(custom.mock.calls[0]?.[1]).toMatchObject({
			overlay: true,
			overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" },
		});
	});

	it("clears all tasks without opening the modal and queues the empty snapshot", async () => {
		const sendMessage = vi.fn();
		const appendEntry = vi.fn();
		const eventEmit = vi.fn();
		const { tool, cmd } = setup({
			sendMessage,
			appendEntry,
			events: { emit: eventEmit, on: vi.fn() } as never,
		});
		await seed(tool, [{ action: "create", subject: "Remove me" }]);
		const custom = vi.fn();
		const ctx = createMockCtx({ hasUI: true, mode: "tui", ui: { custom } as never });
		await cmd.handler("clear", ctx as never);
		expect(custom).not.toHaveBeenCalled();
		expect(appendEntry).toHaveBeenCalledWith(TODO_EDITOR_STATE_ENTRY, { tasks: [], nextId: 1 });
		expect(sendMessage.mock.calls[0]?.[0].content).toContain("(no todos)");
	});

	it("does not persist or notify the agent when the draft is unchanged", async () => {
		const state: TaskState = { tasks: [], nextId: 1 };
		const sendMessage = vi.fn();
		const appendEntry = vi.fn();
		const { cmd } = setup({ sendMessage, appendEntry });
		const ctx = createMockCtx({
			hasUI: true,
			mode: "tui",
			ui: { custom: vi.fn(async () => ({ state, changed: false })) } as never,
		});
		await cmd.handler("", ctx as never);
		expect(appendEntry).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("persists an edited snapshot and queues the complete state for the next turn", async () => {
		const sendMessage = vi.fn();
		const appendEntry = vi.fn();
		const eventEmit = vi.fn();
		const { tool, cmd } = setup({
			sendMessage,
			appendEntry,
			events: { emit: eventEmit, on: vi.fn() } as never,
		});
		await seed(tool, [{ action: "create", subject: "Original" }]);
		const edited: TaskState = {
			tasks: [
				{ id: 1, subject: "Renamed", status: "in_progress", description: "Full details" },
				{ id: 2, subject: "Child", status: "pending", parentId: 1 },
			],
			nextId: 3,
		};
		const ctx = createMockCtx({
			hasUI: true,
			mode: "tui",
			sessionId: "test-session",
			ui: { custom: vi.fn(async () => ({ state: edited, changed: true })) } as never,
		});

		await cmd.handler("", ctx as never);

		expect(appendEntry).toHaveBeenCalledWith(TODO_EDITOR_STATE_ENTRY, edited);
		expect(eventEmit).toHaveBeenCalledWith("rpiv-todo:state-changed", { sessionId: "test-session" });
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "rpiv-todo-user-edit",
				display: false,
				content: expect.stringContaining("1. Renamed [id=#1; status=in_progress"),
			}),
			{ deliverAs: "nextTurn" },
		);
		expect(sendMessage.mock.calls[0]?.[0].content).toContain("└─ 1.1. Child [id=#2; status=pending; parentId=#1]");
	});
});
