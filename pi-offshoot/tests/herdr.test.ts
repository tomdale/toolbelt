import { describe, expect, it, vi } from "vitest";
import { HerdrClient } from "../src/herdr.ts";

function result(stdout: string, code = 0) {
	return { stdout, stderr: "", code, killed: false };
}

describe("Herdr client", () => {
	it("targets an explicit parent pane and starts Pi against the independent session file", async () => {
		const execute = vi.fn(async (_command: string, args: string[]) => {
			if (args[0] === "pane" && args[1] === "get") {
				return result(JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } }));
			}
			if (args[0] === "pane" && args[1] === "split") {
				return result(JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }));
			}
			return result(JSON.stringify({ result: { agent: { pane_id: "w1:p2" } } }));
		});
		const client = new HerdrClient(execute as any);
		await client.requirePane("w1:p1");
		const pane = await client.splitPane({ parentPaneId: "w1:p1", direction: "down", cwd: "/checkout", focus: true });
		await client.startPi({ name: "offshoot-test", paneId: pane.paneId, sessionFile: "/sessions/child.jsonl" });

		expect(execute.mock.calls.map((call) => call[1])).toEqual([
			["pane", "get", "w1:p1"],
			["pane", "split", "--pane", "w1:p1", "--direction", "down", "--ratio", "0.5", "--cwd", "/checkout", "--focus"],
			["agent", "start", "offshoot-test", "--kind", "pi", "--pane", "w1:p2", "--timeout", "30000", "--", "--session", "/sessions/child.jsonl"],
		]);
	});

	it("retries only the transient fresh-pane busy response", async () => {
		let attempts = 0;
		const client = new HerdrClient(async () => {
			attempts += 1;
			return attempts === 1
				? { stdout: "", stderr: JSON.stringify({ error: { code: "agent_pane_busy" } }), code: 1, killed: false }
				: result(JSON.stringify({ result: { agent: { pane_id: "w1:p2" } } }));
		});
		await client.startPi({ name: "offshoot-test", paneId: "w1:p2", sessionFile: "/sessions/child.jsonl" });
		expect(attempts).toBe(2);
	});

	it("rejects a successful start response that does not confirm the requested pane", async () => {
		const client = new HerdrClient(async () => result(JSON.stringify({ result: { agent: { pane_id: "w1:p9" } } })) as any);
		await expect(client.startPi({ name: "offshoot-test", paneId: "w1:p2", sessionFile: "/sessions/child.jsonl" }))
			.rejects.toThrow(/did not confirm the offshoot pane identity/);
	});

	it("rejects malformed split responses instead of guessing pane identity", async () => {
		const client = new HerdrClient(async () => result(JSON.stringify({ result: { pane: {} } })) as any);
		await expect(client.splitPane({ parentPaneId: "w1:p1", direction: "right", cwd: "/checkout", focus: true }))
			.rejects.toThrow(/did not return a pane ID/);
	});
});
