import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureSessionSnapshot, createOffshootSession } from "../src/session.ts";

function assistant(text: string): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function fixture(run: (root: string, sessions: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-offshoot-"));
	const sessions = join(root, "sessions");
	await mkdir(sessions);
	try {
		await run(root, sessions);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("offshoot session", () => {
	it("extracts the selected path without mutating the active manager or parent bytes", async () => {
		await fixture(async (root, sessions) => {
			const live = SessionManager.create(root, sessions, { id: "parent" });
			const first = live.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
			live.appendMessage(assistant("kept answer"));
			live.appendModelChange("kept-provider", "kept-model");
			live.appendThinkingLevelChange("high");
			const selected = live.appendSessionInfo("kept name");
			live.appendLabelChange(first, "kept label");
			live.branch(selected);
			live.appendMessage({ role: "user", content: "excluded sibling", timestamp: Date.now() });
			live.appendMessage(assistant("excluded answer"));

			const parentFile = live.getSessionFile()!;
			const beforeBytes = await readFile(parentFile);
			const before = {
				file: live.getSessionFile(), id: live.getSessionId(), leaf: live.getLeafId(),
			};
			const childInfo = await createOffshootSession({
				parentSessionFile: parentFile,
				sessionDir: sessions,
				cwd: root,
				leafId: selected,
			});

			expect(resolve(childInfo.childSessionFile)).not.toBe(resolve(parentFile));
			expect(childInfo.childSessionId).not.toBe(before.id);
			const child = SessionManager.open(childInfo.childSessionFile, sessions, root);
			expect(child.getHeader()?.parentSession).toBe(parentFile);
			expect(child.getSessionName()).toBe("kept name");
			expect(child.getLabel(first)).toBe("kept label");
			expect(child.getEntries().some((entry) => JSON.stringify(entry).includes("kept-provider"))).toBe(true);
			expect(child.getEntries().some((entry) => JSON.stringify(entry).includes("thinking_level_change"))).toBe(true);
			expect(child.getEntries().some((entry) => JSON.stringify(entry).includes("excluded sibling"))).toBe(false);
			assert.deepEqual(await readFile(parentFile), beforeBytes);
			assert.deepEqual({ file: live.getSessionFile(), id: live.getSessionId(), leaf: live.getLeafId() }, before);
		});
	});

	it("rejects a branch whose terminal conversation message is not a completed assistant response", async () => {
		await fixture(async (root, sessions) => {
			const live = SessionManager.create(root, sessions, { id: "incomplete-parent" });
			live.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
			live.appendMessage(assistant("complete earlier answer"));
			const userLeaf = live.appendMessage({ role: "user", content: "still unanswered", timestamp: Date.now() });
			await expect(createOffshootSession({
				parentSessionFile: live.getSessionFile()!,
				sessionDir: sessions,
				cwd: root,
				leafId: userLeaf,
			})).rejects.toThrow(/does not end in a completed assistant response/);
		});
	});

	it("captures one settled persisted file and leaf", () => {
		expect(captureSessionSnapshot({
			getSessionFile: () => "/sessions/parent.jsonl",
			getSessionDir: () => "/sessions",
			getLeafId: () => "leaf",
		}, "/checkout")).toEqual({
			parentSessionFile: "/sessions/parent.jsonl",
			sessionDir: "/sessions",
			leafId: "leaf",
			cwd: "/checkout",
		});
		expect(() => captureSessionSnapshot({
			getSessionFile: () => undefined,
			getSessionDir: () => "/sessions",
			getLeafId: () => "leaf",
		}, "/checkout")).toThrow(/persisted Pi session/);
	});
});
