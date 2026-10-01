import { setTimeout as delay } from "node:timers/promises";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

export type SplitDirection = "right" | "down";
export type HerdrExecutor = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

export interface HerdrPane {
	paneId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvelope(stdout: string, operation: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(`Herdr ${operation} returned invalid JSON.`);
	}
	if (!isRecord(parsed) || !isRecord(parsed.result)) {
		throw new Error(`Herdr ${operation} returned an unexpected response.`);
	}
	return parsed.result;
}

function paneIdFromEnvelope(output: string): string | undefined {
	try {
		const parsed = JSON.parse(output) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.result) || !isRecord(parsed.result.pane)) return undefined;
		const paneId = parsed.result.pane.pane_id;
		return typeof paneId === "string" && paneId.trim() ? paneId : undefined;
	} catch {
		return undefined;
	}
}

export class HerdrCommandError extends Error {
	readonly paneId?: string;
	readonly herdrCode?: string;
	readonly uncertain: boolean;

	constructor(operation: string, result: ExecResult) {
		const raw = result.stderr.trim() || result.stdout.trim();
		let herdrCode: string | undefined;
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.code === "string") {
				herdrCode = parsed.error.code;
			}
		} catch {
			// Diagnostics are classified without exposing raw output, which may contain paths or prompts.
		}
		const status = result.killed ? "timed out or was cancelled" : `failed with exit code ${result.code}`;
		super(`Herdr ${operation} ${status}${herdrCode ? ` (${herdrCode})` : ""}.`);
		this.name = "HerdrCommandError";
		this.paneId = paneIdFromEnvelope(result.stdout);
		this.herdrCode = herdrCode;
		this.uncertain = result.killed || herdrCode === undefined;
	}
}

export class HerdrClient {
	constructor(private readonly execute: HerdrExecutor) {}

	async requirePane(paneId: string, signal?: AbortSignal): Promise<void> {
		const result = await this.execute("herdr", ["pane", "get", paneId], {
			timeout: 5_000,
			...(signal ? { signal } : {}),
		});
		if (result.code !== 0 || result.killed) throw new HerdrCommandError("pane get", result);
		const envelope = parseEnvelope(result.stdout, "pane get");
		if (!isRecord(envelope.pane) || envelope.pane.pane_id !== paneId) {
			throw new Error("Herdr pane get did not confirm the current pane identity.");
		}
	}

	async splitPane(options: {
		parentPaneId: string;
		direction: SplitDirection;
		cwd: string;
		focus: boolean;
	}, signal?: AbortSignal): Promise<HerdrPane> {
		const args = [
			"pane", "split", "--pane", options.parentPaneId,
			"--direction", options.direction,
			"--ratio", "0.5",
			"--cwd", options.cwd,
			options.focus ? "--focus" : "--no-focus",
		];
		const result = await this.execute("herdr", args, { timeout: 10_000, ...(signal ? { signal } : {}) });
		if (result.code !== 0 || result.killed) throw new HerdrCommandError("pane split", result);
		const envelope = parseEnvelope(result.stdout, "pane split");
		if (!isRecord(envelope.pane) || typeof envelope.pane.pane_id !== "string" || !envelope.pane.pane_id.trim()) {
			throw new Error("Herdr pane split did not return a pane ID.");
		}
		return { paneId: envelope.pane.pane_id };
	}

	async startPi(options: {
		name: string;
		paneId: string;
		sessionFile: string;
	}, signal?: AbortSignal): Promise<void> {
		const args = [
			"agent", "start", options.name,
			"--kind", "pi",
			"--pane", options.paneId,
			"--timeout", "30000",
			"--", "--session", options.sessionFile,
		];
		const delays = [0, 250, 500, 1_000, 1_000] as const;
		for (const [attempt, delayMs] of delays.entries()) {
			signal?.throwIfAborted();
			if (delayMs > 0) await delay(delayMs, undefined, signal ? { signal } : undefined);
			const result = await this.execute("herdr", args, { timeout: 35_000, ...(signal ? { signal } : {}) });
			if (result.code === 0 && !result.killed) {
				const envelope = parseEnvelope(result.stdout, "agent start");
				if (!isRecord(envelope.agent) || envelope.agent.pane_id !== options.paneId) {
					throw new Error("Herdr agent start did not confirm the offshoot pane identity.");
				}
				return;
			}
			const error = new HerdrCommandError("agent start", result);
			if (error.herdrCode !== "agent_pane_busy" || attempt === delays.length - 1) throw error;
		}
	}
}
