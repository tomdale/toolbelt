import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi, createMockUI } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetState, registerTodoTool, setActiveRenderSession, type TaskAction } from "./todo.js";
import { TodoOverlay } from "./todo-overlay.js";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-todo", "config.json");

function writeConfigFile(contents: string): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, contents, "utf-8");
}
function removeConfigFile(): void {
	rmSync(CONFIG_PATH, { force: true });
}

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
};

async function setup(
	actions: Array<{ action: TaskAction; [k: string]: unknown }>,
	uiOverrides: Partial<Omit<ExtensionUIContext, "theme">> = {},
) {
	__resetState();
	setActiveRenderSession("test-session");
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	const tool = captured.tools.get("todo")!;
	const ctx = createMockCtx();
	for (const p of actions) {
		await tool.execute?.("tc", p as never, undefined as never, undefined as never, ctx as never);
	}
	const ui = createMockUI(uiOverrides) as unknown as ExtensionUIContext;
	const overlay = new TodoOverlay();
	overlay.setUICtx(ui);
	overlay.update();
	const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
	const factory = setWidget.mock.calls[0][1] as (
		tui: { requestRender: () => void },
		theme: typeof identityTheme,
	) => { render: (w: number) => string[]; invalidate: () => void };
	const widget = factory({ requestRender: vi.fn() }, identityTheme);
	return { widget, tool, ui, overlay };
}

beforeEach(() => {
	__resetState();
	removeConfigFile();
});
afterEach(() => {
	__resetState();
	removeConfigFile();
	vi.restoreAllMocks();
});

describe("TodoOverlay — heading", () => {
	it("includes 'Todos (completed/total)' count", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "update", id: 1, status: "completed" },
		]);
		const lines = widget.render(200);
		expect(lines[0]).toContain("Todos (1/2)");
	});

	it("uses filled icon '●' when any task is active (pending/in_progress)", async () => {
		const { widget } = await setup([{ action: "create", subject: "a" }]);
		expect(widget.render(200)[0]).toContain("●");
	});

	it("uses hollow icon '○' when all tasks are completed", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "update", id: 1, status: "completed" },
		]);
		expect(widget.render(200)[0]).toContain("○");
	});
});

describe("TodoOverlay — natural-order rendering (no overflow)", () => {
	it("renders one line per visible task plus heading, last row uses '└─'", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "create", subject: "c" },
		]);
		const lines = widget.render(200);
		expect(lines).toHaveLength(4); // heading + 3
		expect(lines[1]).toContain("○ 1 a");
		expect(lines[2]).toContain("○ 2 b");
		expect(lines[3]).toContain("○ 3 c");
	});

	it("omits deleted tasks from the rendered output", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "visible" },
			{ action: "create", subject: "gone" },
			{ action: "update", id: 2, status: "deleted" },
		]);
		const out = widget.render(200).join("\n");
		expect(out).toContain("visible");
		expect(out).not.toContain("gone");
	});
});

describe("TodoOverlay — hierarchy", () => {
	it("renders children directly beneath their parent with indentation", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "parent" },
			{ action: "create", subject: "other root" },
			{ action: "create", subject: "child", parentId: 1 },
			{ action: "create", subject: "grandchild", parentId: 3 },
		]);
		const lines = widget.render(200);
		const parent = lines.findIndex((line) => line.includes("parent"));
		const child = lines.findIndex((line) => line.includes("child") && !line.includes("grandchild"));
		const grandchild = lines.findIndex((line) => line.includes("grandchild"));
		const other = lines.findIndex((line) => line.includes("other root"));
		expect([parent, child, grandchild, other]).toEqual([1, 2, 3, 4]);
		expect(lines[child]).toContain("└─ ○");
		expect(lines[grandchild]).toContain("   └─ ○");
	});
});

describe("TodoOverlay — per-task formatting", () => {
	it("pending task uses '○' glyph", async () => {
		const { widget } = await setup([{ action: "create", subject: "pending-task" }]);
		expect(widget.render(200)[1]).toContain("○");
		expect(widget.render(200)[1]).toContain("pending-task");
	});

	it("in_progress task uses '◐' glyph and appends (activeForm)", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "do it", activeForm: "Doing it" },
			{ action: "update", id: 1, status: "in_progress" },
		]);
		const line = widget.render(200)[1];
		expect(line).toContain("◐");
		expect(line).toContain("do it");
		expect(line).toContain("(Doing it)");
	});

	it("completed task stays visible until the next agent turn starts", async () => {
		const { widget, overlay } = await setup([
			{ action: "create", subject: "done" },
			{ action: "update", id: 1, status: "completed" },
		]);
		const firstRender = widget.render(200);
		expect(firstRender[1]).toContain("✓");
		expect(firstRender[1]).toContain("done");
		expect(widget.render(200)[1]).toContain("done");
		overlay.hideCompletedTasksFromPreviousTurn();
		expect(widget.render(200)).toEqual([]);
	});
});

describe("TodoOverlay — task id display", () => {
	it("pads task IDs to align subjects in a related group", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "root" },
			{ action: "create", subject: "child", parentId: 1 },
			{ action: "create", subject: "two-digit root" },
			{ action: "create", subject: "another root" },
			{ action: "create", subject: "another root" },
			{ action: "create", subject: "another root" },
			{ action: "create", subject: "another root" },
			{ action: "create", subject: "another root" },
			{ action: "create", subject: "another root" },
			{ action: "create", subject: "another root" },
		]);
		const lines = widget.render(200);
		expect(lines.find((line) => line.includes("root"))).toContain("1 root");
		expect(lines.find((line) => line.includes("another root"))).toContain("3 another root");
		expect(lines.find((line) => line.includes("two-digit root"))).toContain("2 two-digit root");
	});

	it("honors showTaskIds: never and always", async () => {
		writeConfigFile(JSON.stringify({ showTaskIds: "never" }));
		let result = await setup([
			{ action: "create", subject: "root" },
			{ action: "create", subject: "child", parentId: 1 },
		]);
		expect(result.widget.render(200).join("\n")).not.toMatch(/#\d/);
		removeConfigFile();
		writeConfigFile(JSON.stringify({ showTaskIds: "always" }));
		result = await setup([{ action: "create", subject: "root" }]);
		expect(result.widget.render(200).join("\n")).toContain("1 root");
	});
});

describe("TodoOverlay — showIds gate", () => {
	it("does NOT show #id prefix when no task has blockedBy", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
		]);
		const out = widget.render(200).join("\n");
		expect(out).not.toMatch(/#\d/);
	});

	it("shows #id prefix and '⛓' dep suffix when any task has blockedBy", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "base" },
			{ action: "create", subject: "follow-up", blockedBy: [1] },
		]);
		const out = widget.render(200).join("\n");
		expect(out).toContain("⛓ #1");
		expect(out).toContain("2 follow-up");
		expect(out).toContain("⛓");
	});
});

describe("TodoOverlay — overflow collapse", () => {
	it("drops completed first when dropping is enough", async () => {
		// 12 total = 8 pending + 4 completed. budget=10. All pending fit,
		// plus 2 of the 4 completed (in natural order). 2 completed hidden.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 8; i++) actions.push({ action: "create", subject: `p${i}` });
		for (let i = 9; i <= 12; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push({ action: "update", id: i, status: "completed" });
		}
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		// heading + 10 visible + 1 summary = 12
		expect(lines).toHaveLength(12);
		// All pending present
		for (let i = 1; i <= 8; i++) expect(lines.join("\n")).toContain(`p${i}`);
		// Last row is the trailing spacer; the summary sits just above it
		expect(lines[lines.length - 1]).toContain("+2 more");
		expect(lines[lines.length - 1]).toContain("2 completed");
	});

	it("truncates pending tail when dropping all completed isn't enough", async () => {
		// 12 pending tasks → budget=10 → visible first 10, 2 pending truncated.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 12; i++) actions.push({ action: "create", subject: `t${i}` });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(12);
		const summary = lines[lines.length - 1];
		expect(summary).toContain("+2 more");
		expect(summary).toContain("2 pending");
		expect(summary).not.toContain("completed");
	});

	it("summary contains both 'completed' and 'pending' when mixed overflow", async () => {
		// 12 pending + 3 completed = 15 total. budget=10. All 12 pending won't
		// fit — visible = first 10 pending, truncatedTail = 2 pending, hidden
		// completed = 3. Summary: "+5 more (3 completed, 2 pending)".
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 12; i++) actions.push({ action: "create", subject: `p${i}` });
		for (let i = 13; i <= 15; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push({ action: "update", id: i, status: "completed" });
		}
		const { widget } = await setup(actions);
		const summary = widget.render(60).slice(-1)[0];
		expect(summary).toContain("+5 more");
		expect(summary).toContain("3 completed");
		expect(summary).toContain("2 pending");
	});

	it("hides overflowed completed tasks on the next agent turn too", async () => {
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 11; i++) actions.push({ action: "create", subject: `p${i}` });
		for (let i = 12; i <= 16; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push({ action: "update", id: i, status: "completed" });
		}
		const { widget, overlay } = await setup(actions);
		const beforeNextTurn = widget.render(60).join("\n");
		expect(beforeNextTurn).toContain("Todos (5/16)");
		expect(beforeNextTurn).toContain("+6 more");
		expect(beforeNextTurn).toContain("5 completed");
		overlay.hideCompletedTasksFromPreviousTurn();
		const afterNextTurn = widget.render(60).join("\n");
		expect(afterNextTurn).toContain("Todos (0/11)");
		expect(afterNextTurn).toContain("p11");
		expect(afterNextTurn).not.toContain("+1 more");
		expect(afterNextTurn).not.toContain("completed");
	});

	it("does not engage overflow at exactly 11 visible tasks", async () => {
		// 11 tasks → all fit (heading + 11 = 12). No summary row.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 11; i++) actions.push({ action: "create", subject: `t${i}` });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(12);
		expect(lines[lines.length - 1]).not.toContain("+");
		expect(lines[lines.length - 1]).toContain("○ 11 t11");
	});

	it("follows Pi's tool-output expansion mode and renders every task", async () => {
		let toolsExpanded = false;
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 17; i++) actions.push({ action: "create", subject: `t${i}` });
		const { widget } = await setup(actions, { getToolsExpanded: () => toolsExpanded });

		const collapsed = widget.render(60).join("\n");
		expect(collapsed).toContain("+7 more");
		expect(collapsed).not.toContain("t17");

		toolsExpanded = true;
		const expanded = widget.render(200);
		expect(expanded).toHaveLength(7); // heading + 6 rows of 3 tasks
		expect(expanded.join("\n")).toContain("t17");
		expect(expanded.join("\n")).not.toContain(" more");
		expect(expanded.some((line) => line.includes("○ 17 t17"))).toBe(true);

		toolsExpanded = false;
		expect(widget.render(60).join("\n")).toContain("+7 more");
	});

	it("keeps the configured budget when the host has no expansion-state API", async () => {
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 17; i++) actions.push({ action: "create", subject: `t${i}` });
		const { widget } = await setup(actions);
		expect(widget.render(60).join("\n")).toContain("+7 more");
	});
});

describe("TodoOverlay — collapse/expand render", () => {
	it("collapsed view returns heading and expand hint", async () => {
		const { widget, overlay } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "update", id: 1, status: "completed" },
		]);
		overlay.toggleCollapse(); // collapse
		const lines = widget.render(200);
		expect(lines).toHaveLength(2); // heading + hint
		expect(lines[0]).toContain("Todos (1/2)");
		expect(lines[1]).toContain("└─");
		expect(lines[1]).toContain("ctrl+shift+t to expand");
	});

	it("uncollapsed (default) yields the unchanged full render (regression-safe)", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
		]);
		// Full render: heading + 2 tasks = 3 lines
		const lines = widget.render(200);
		expect(lines).toHaveLength(3);
		expect(lines.some((l) => l.includes("a"))).toBe(true);
		expect(lines.some((l) => l.includes("b"))).toBe(true);
	});

	it("collapsed render short-circuits before completed-display tracking (no task queued for hide while collapsed)", async () => {
		const { widget, overlay } = await setup([
			{ action: "create", subject: "done" },
			{ action: "update", id: 1, status: "completed" },
		]);
		overlay.toggleCollapse(); // collapse
		widget.render(200); // collapsed render — must NOT queue the completed task
		// Draining the pending-hide set is a no-op because nothing was queued.
		overlay.hideCompletedTasksFromPreviousTurn();
		overlay.toggleCollapse(); // expand
		// The completed task is still visible: the collapsed render never queued it,
		// so the drain above couldn't hide it.
		const expanded = widget.render(200).join("\n");
		expect(expanded).toContain("done");
		expect(expanded).toContain("✓");
	});
});

describe("TodoOverlay — collapse hint resolves the key from config", () => {
	// resolveCollapseKey() runs at render time (per-render, like the row budget), so
	// the config MUST be written before widget.render(). setup() itself doesn't read
	// the collapse key — it constructs the overlay directly.

	it("renders the configured key in the collapsed hint (alt+o)", async () => {
		writeConfigFile(JSON.stringify({ collapseKey: "alt+o" }));
		const { widget, overlay } = await setup([{ action: "create", subject: "a" }]);
		overlay.toggleCollapse(); // collapse
		const lines = widget.render(200);
		expect(lines[1]).toContain("alt+o to expand");
		// The placeholder is always spliced — never leaks the raw {key} token.
		expect(lines[1]).not.toContain("{key}");
		expect(lines[1]).not.toContain("ctrl+shift+t");
	});

	it("renders the default key in the collapsed hint when config is missing", async () => {
		const { widget, overlay } = await setup([{ action: "create", subject: "a" }]);
		overlay.toggleCollapse(); // collapse
		const lines = widget.render(200);
		expect(lines[1]).toContain("ctrl+shift+t to expand");
		expect(lines[1]).not.toContain("{key}");
	});

	it("renders the default key when the configured spec is invalid", async () => {
		writeConfigFile(JSON.stringify({ collapseKey: "ctr+t" }));
		const { widget, overlay } = await setup([{ action: "create", subject: "a" }]);
		overlay.toggleCollapse(); // collapse
		const lines = widget.render(200);
		expect(lines[1]).toContain("ctrl+shift+t to expand");
	});

	it("renders a static collapsed label — not the sentinel — when the key resolves to off", async () => {
		// Reachable mid-session: collapse with a bound key, then edit the config to
		// "off" without /reload. The per-render resolver returns the sentinel; the
		// hint must not splice it into the {key} placeholder ("off to expand").
		const { widget, overlay } = await setup([{ action: "create", subject: "a" }]);
		overlay.toggleCollapse(); // collapse
		writeConfigFile(JSON.stringify({ collapseKey: "off" }));
		const lines = widget.render(200);
		expect(lines[1]).toContain("collapsed");
		expect(lines[1]).not.toContain("off to expand");
		expect(lines[1]).not.toContain("{key}");
	});
});

describe("TodoOverlay — width truncation", () => {
	it("fills columns downward before moving to the next column", async () => {
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 30; i++) actions.push({ action: "create", subject: `task-${i}` });

		const { widget } = await setup(actions);
		const lines = widget.render(120);

		expect(lines[1]).toContain("task-1");
		expect(lines[1]).toContain("task-11");
		expect(lines[1]).toContain("task-21");
		expect(lines[2]).toContain("task-2");
		expect(lines[2]).toContain("task-12");
		expect(lines[2]).toContain("task-22");
		expect(lines[1]).not.toMatch(/task-2\s/);
	});

	it("renders without throwing at small widths", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a very long subject that would overflow a narrow column" },
		]);
		expect(() => widget.render(20)).not.toThrow();
	});

	it("drops completed tasks from counts after the next agent turn starts", async () => {
		const { widget, overlay } = await setup([
			{ action: "create", subject: "done" },
			{ action: "update", id: 1, status: "completed" },
			{ action: "create", subject: "next" },
		]);
		expect(widget.render(200).join("\n")).toContain("Todos (1/2)");
		const secondRender = widget.render(200).join("\n");
		expect(secondRender).toContain("Todos (1/2)");
		expect(secondRender).toContain("next");
		expect(secondRender).toContain("done");
		overlay.hideCompletedTasksFromPreviousTurn();
		const hiddenRender = widget.render(200).join("\n");
		expect(hiddenRender).toContain("Todos (0/1)");
		expect(hiddenRender).toContain("next");
		expect(hiddenRender).not.toContain("done");
	});

	it("re-renders reflect live state changes without re-registering", async () => {
		const { widget, tool } = await setup([{ action: "create", subject: "first" }]);
		const out1 = widget.render(200).join("\n");
		expect(out1).toContain("first");
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "second" } as never,
			undefined as never,
			undefined as never,
			createMockCtx() as never,
		);
		const out2 = widget.render(200).join("\n");
		expect(out2).toContain("first");
		expect(out2).toContain("second");
	});
});
