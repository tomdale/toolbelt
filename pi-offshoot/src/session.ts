import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface ActiveSessionReference {
	getSessionFile(): string | undefined;
	getSessionDir(): string;
	getLeafId(): string | null;
}

export interface SessionSnapshot {
	parentSessionFile: string;
	sessionDir: string;
	cwd: string;
	leafId: string;
}

export interface OffshootSession {
	parentSessionFile: string;
	parentSessionId: string;
	childSessionFile: string;
	childSessionId: string;
	leafId: string;
}

async function requireFile(path: string, label: string): Promise<void> {
	let details;
	try {
		details = await stat(path);
	} catch (error) {
		throw new Error(`${label} does not exist: ${path}`, { cause: error });
	}
	if (!details.isFile()) throw new Error(`${label} is not a file: ${path}`);
}

export function captureSessionSnapshot(session: ActiveSessionReference, cwd: string): SessionSnapshot {
	const parentSessionFile = session.getSessionFile();
	if (!parentSessionFile) {
		throw new Error("Offshoot requires a persisted Pi session. Start Pi without --no-session and try again.");
	}
	const leafId = session.getLeafId();
	if (!leafId) throw new Error("The current Pi session has no saved conversation to fork.");
	return {
		parentSessionFile,
		sessionDir: session.getSessionDir(),
		cwd,
		leafId,
	};
}

/**
 * Branch through a detached manager so creating the child cannot switch or
 * rewrite the manager owned by the active Pi process.
 */
export async function createOffshootSession(snapshot: SessionSnapshot): Promise<OffshootSession> {
	await requireFile(snapshot.parentSessionFile, "Parent Pi session");
	const detached = SessionManager.open(snapshot.parentSessionFile, snapshot.sessionDir, snapshot.cwd);
	if (!detached.getEntry(snapshot.leafId)) {
		throw new Error(`The selected Pi session leaf is no longer present: ${snapshot.leafId}`);
	}

	const branch = detached.getBranch(snapshot.leafId);
	let terminalMessage: (typeof branch)[number] | undefined;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		if (branch[index]?.type === "message") {
			terminalMessage = branch[index];
			break;
		}
	}
	if (terminalMessage?.type !== "message" || terminalMessage.message.role !== "assistant" ||
		terminalMessage.message.stopReason === "error" || terminalMessage.message.stopReason === "aborted") {
		throw new Error("The active branch does not end in a completed assistant response. Wait for Pi to finish, then try again.");
	}

	const parentSessionId = detached.getSessionId();
	const childSessionFile = detached.createBranchedSession(snapshot.leafId);
	if (!childSessionFile) throw new Error("Pi did not create a persisted offshoot session.");
	if (resolve(childSessionFile) === resolve(snapshot.parentSessionFile)) {
		throw new Error("Pi returned the parent session path instead of a separate offshoot session.");
	}
	await requireFile(childSessionFile, "Offshoot Pi session");

	return {
		parentSessionFile: snapshot.parentSessionFile,
		parentSessionId,
		childSessionFile,
		childSessionId: detached.getSessionId(),
		leafId: snapshot.leafId,
	};
}
