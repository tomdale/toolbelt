import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { HerdrClient, HerdrCommandError, type SplitDirection } from "../src/herdr.ts";
import { captureSessionSnapshot, createOffshootSession } from "../src/session.ts";

const RIGHT_SHORTCUT = "ctrl+alt+right";
const DOWN_SHORTCUT = "ctrl+alt+down";

type OffshootContext = ExtensionContext | ExtensionCommandContext;

function parseDirection(value: string): SplitDirection | undefined {
	switch (value.trim().toLowerCase()) {
		case "":
		case "vertical":
		case "right":
		case "v":
			return "right";
		case "horizontal":
		case "down":
		case "h":
			return "down";
		default:
			return undefined;
	}
}

function agentName(): string {
	return `offshoot-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message ? error.message : "Offshoot could not be created.";
}

function layoutName(direction: SplitDirection): string {
	return direction === "right" ? "vertical (right)" : "horizontal (down)";
}

export default function offshootExtension(pi: ExtensionAPI): void {
	const herdr = new HerdrClient((command, args, options) => pi.exec(command, args, options));
	let launching = false;

	async function launch(direction: SplitDirection, ctx: OffshootContext, waitForIdle: boolean): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Offshoot requires Pi's interactive TUI.", "error");
			return;
		}
		if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
			ctx.ui.notify("Offshoot requires Pi to be running inside a Herdr pane.", "error");
			return;
		}
		if (launching) {
			ctx.ui.notify("An offshoot is already being created.", "warning");
			return;
		}
		if (!waitForIdle && !ctx.isIdle()) {
			ctx.ui.notify("Wait for the current Pi turn to finish before using the offshoot shortcut.", "warning");
			return;
		}

		launching = true;
		let childSessionFile: string | undefined;
		let childPaneId: string | undefined;
		try {
			if (waitForIdle) await (ctx as ExtensionCommandContext).waitForIdle();
			const parentPaneId = process.env.HERDR_PANE_ID;
			if (!parentPaneId) throw new Error("HERDR_PANE_ID disappeared before the offshoot could be created.");

			// Validate Herdr before creating a durable child session. Capture the
			// session only after Pi is idle so file and leaf refer to one settled turn.
			await herdr.requirePane(parentPaneId, ctx.signal);
			const snapshot = captureSessionSnapshot(ctx.sessionManager, ctx.cwd);
			const child = await createOffshootSession(snapshot);
			childSessionFile = child.childSessionFile;

			let pane;
			try {
				pane = await herdr.splitPane({
					parentPaneId,
					direction,
					cwd: ctx.cwd,
					focus: true,
				}, ctx.signal);
			} catch (error) {
				if (error instanceof HerdrCommandError) childPaneId = error.paneId;
				throw error;
			}
			childPaneId = pane.paneId;
			if (childPaneId === parentPaneId) throw new Error("Herdr returned the parent pane as the offshoot pane.");

			const name = agentName();
			await herdr.startPi({ name, paneId: childPaneId, sessionFile: childSessionFile }, ctx.signal);
			ctx.ui.notify(
				`Offshoot opened in ${layoutName(direction)} split ${childPaneId}. Child session: ${childSessionFile}`,
				"info",
			);
		} catch (error) {
			if (childSessionFile) {
				const pane = childPaneId ? ` Herdr pane ${childPaneId} was left open for recovery.` : "";
				ctx.ui.notify(
					`${errorMessage(error)} The independent child session was preserved at ${childSessionFile}.${pane}`,
					"error",
				);
			} else {
				ctx.ui.notify(errorMessage(error), "error");
			}
		} finally {
			launching = false;
		}
	}

	pi.registerCommand("offshoot", {
		description: "Fork the active Pi session into a new Herdr pane: /offshoot [vertical|horizontal]",
		getArgumentCompletions: (prefix) => ["vertical", "horizontal"]
			.filter((value) => value.startsWith(prefix.toLowerCase()))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const direction = parseDirection(args);
			if (!direction) {
				ctx.ui.notify("Usage: /offshoot [vertical|horizontal] (aliases: right, down, v, h)", "error");
				return;
			}
			await launch(direction, ctx, true);
		},
	});

	pi.registerShortcut(RIGHT_SHORTCUT, {
		description: "Fork session into a right-hand Herdr pane",
		handler: (ctx) => launch("right", ctx, false),
	});
	pi.registerShortcut(DOWN_SHORTCUT, {
		description: "Fork session into a lower Herdr pane",
		handler: (ctx) => launch("down", ctx, false),
	});
}
