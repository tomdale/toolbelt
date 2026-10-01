/**
 * todo tool + /todos command — thin registration shell.
 *
 * Tool/command identity, schema, types, reducer, store, replay, response
 * envelope, selectors, and view formatters live in the layered modules under
 * `tool/`, `state/`, and `view/`. This file is the package-root registration
 * surface — it mirrors `packages/rpiv-ask-user-question/ask-user-question.ts`
 * which keeps the tool registration at the package root.
 *
 * Public re-exports below preserve the pre-refactor import surface so that
 * `index.ts`, `todo-overlay.ts`, and the global `test/setup.ts` `beforeEach`
 * continue to import from `./todo.js`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, validateGuidanceFields } from "./config.js";
import { t } from "./state/i18n-bridge.js";
import { TODO_EDITOR_STATE_ENTRY } from "./state/replay.js";
import { applyTaskMutation } from "./state/state-reducer.js";
import { commitState, getRenderState, getState, sid } from "./state/store.js";
import { formatTodoStateForAgent, TodosEditor } from "./todos-editor.js";
import { buildToolResult } from "./tool/response-envelope.js";
import {
	COMMAND_NAME,
	ERR_REQUIRES_INTERACTIVE,
	type TaskMutationParams,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
} from "./tool/types.js";
import { renderTodoCall, renderTodoResult } from "./view/format.js";

// ---------------------------------------------------------------------------
// Public re-exports — pre-refactor consumers (overlay, tests, index.ts) keep
// importing from `./todo.js`. New code may opt into deeper imports.
// ---------------------------------------------------------------------------

export { isTransitionValid } from "./state/invariants.js";
export { applyTaskMutation } from "./state/state-reducer.js";
export { __resetState, getNextId, getTodos, setActiveRenderSession, sid } from "./state/store.js";
export { deriveBlocks, detectCycle } from "./state/task-graph.js";
export type { Task, TaskAction, TaskDetails, TaskStatus } from "./tool/types.js";
export { TOOL_NAME } from "./tool/types.js";

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
	"When starting a task from the todo list, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task in_progress at a time.",
	"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
	"Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
	'To change a task\'s status, call update with the task id and the target status, e.g. {"action":"update","id":3,"status":"completed"} or {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}. status is the field that changes the task; an update without a mutable field (status or another) is rejected.',
	"Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
	"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
	"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
];

export function registerTodoTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = applyTaskMutation(getState(sid(ctx)), params.action, params as TaskMutationParams);
			commitState(sid(ctx), result.state);
			return buildToolResult(params.action, params as TaskMutationParams, result.state, result.op);
		},

		// renderCall reflects the FOREGROUND slot, not the calling session's. Pi's
		// `ToolRenderContext` carries no session identity (no sessionManager/sessionId),
		// so this ctx-less hook cannot re-key by caller. For the foreground session's
		// own transcript that is exactly right. A detached/child call rendered in the
		// lane-transcript viewer whose task lives only in the child's slot misses the
		// foreground lookup and falls back to `#<id>` (see renderTodoCall). That is the
		// safe outcome: per-session ids restart at 1, so searching sibling slots could
		// surface the WRONG subject — the `#<id>` fallback is intentional, not a gap.
		renderCall(args, theme, _context) {
			return renderTodoCall(args as never, theme, getRenderState());
		},

		renderResult(result, _opts, theme, _context) {
			return renderTodoResult(result, theme);
		},
	});
}

// ---------------------------------------------------------------------------
// /todos modal editor
// ---------------------------------------------------------------------------

export function registerTodosCommand(pi: ExtensionAPI): void {
	function applyUserEdit(sessionId: string, state: import("./state/state.js").TaskState): void {
		commitState(sessionId, state);
		pi.appendEntry(TODO_EDITOR_STATE_ENTRY, state);
		pi.events.emit("rpiv-todo:state-changed", { sessionId });
		pi.sendMessage(
			{
				customType: "rpiv-todo-user-edit",
				content: formatTodoStateForAgent(state),
				display: false,
				details: state,
			},
			{ deliverAs: "nextTurn" },
		);
	}

	pi.registerCommand(COMMAND_NAME, {
		description: "Inspect and edit the full hierarchical todo list; pass clear to remove all todos",
		handler: async (args, ctx) => {
			const sessionId = sid(ctx);
			if (args.trim() === "clear") {
				const current = getState(sessionId);
				if (current.tasks.length > 0 || current.nextId !== 1) applyUserEdit(sessionId, { tasks: [], nextId: 1 });
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /todos or /todos clear", "error");
				return;
			}
			if (!ctx.hasUI || (ctx.mode !== undefined && ctx.mode !== "tui")) {
				ctx.ui.notify(t("command.requires_interactive", ERR_REQUIRES_INTERACTIVE), "error");
				return;
			}

			pi.events.emit("rpiv-todo:editor-open", { sessionId });
			let result: import("./todos-editor.js").TodosEditorResult;
			try {
				result = await ctx.ui.custom<import("./todos-editor.js").TodosEditorResult>(
					(tui, theme, _keybindings, done) => new TodosEditor(getState(sessionId), tui, theme, done),
					{
						overlay: true,
						overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center", margin: 1 },
					},
				);
			} finally {
				pi.events.emit("rpiv-todo:editor-close", { sessionId });
			}
			if (result.changed) applyUserEdit(sessionId, result.state);
		},
	});
}
