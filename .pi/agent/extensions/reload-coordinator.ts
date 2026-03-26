import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface ActiveSessionRecord {
	pid: number;
	cwd: string;
	sessionFile: string | null;
	sessionId: string;
	sessionName?: string;
	model?: {
		provider: string;
		id: string;
	};
	startedAt: string;
	lastSeenAt: string;
	mode: "interactive" | "rpc" | "json" | "print" | "unknown";
	workSummary?: string;
	workSummaryUpdatedAt?: string;
	lastMessage?: string;
	lastMessageAt?: string;
	lastMessageRole?: "user" | "assistant";
}

interface ReloadRequest {
	targetPid: number;
	requestedByPid?: number;
	requestedAt: string;
	reason?: string;
}

const RUNTIME_DIR = join(getAgentDir(), "runtime");
export const REGISTRY_DIR = join(RUNTIME_DIR, "instances");
export const RELOAD_REQUESTS_DIR = join(RUNTIME_DIR, "reload-requests");

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function isActiveSessionRecord(value: unknown): value is ActiveSessionRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<ActiveSessionRecord>;
	return (
		typeof record.pid === "number" &&
		Number.isFinite(record.pid) &&
		typeof record.cwd === "string" &&
		typeof record.sessionId === "string" &&
		typeof record.startedAt === "string" &&
		typeof record.lastSeenAt === "string" &&
		(record.mode === "interactive" || record.mode === "rpc" || record.mode === "json" || record.mode === "print" || record.mode === "unknown") &&
		(record.workSummary === undefined || typeof record.workSummary === "string") &&
		(record.workSummaryUpdatedAt === undefined || typeof record.workSummaryUpdatedAt === "string") &&
		(record.lastMessage === undefined || typeof record.lastMessage === "string") &&
		(record.lastMessageAt === undefined || typeof record.lastMessageAt === "string") &&
		(record.lastMessageRole === undefined || record.lastMessageRole === "user" || record.lastMessageRole === "assistant")
	);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tempPath, path);
}

export async function readRegistryEntries(): Promise<ActiveSessionRecord[]> {
	const files = await readdir(REGISTRY_DIR).catch(() => [] as string[]);
	const entries: ActiveSessionRecord[] = [];

	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const path = join(REGISTRY_DIR, file);
		try {
			const raw = await readFile(path, "utf8");
			const parsed = JSON.parse(raw) as unknown;
			if (!isActiveSessionRecord(parsed)) continue;
			if (!isProcessAlive(parsed.pid)) continue;
			entries.push(parsed);
		} catch {
			// Ignore malformed or concurrently rewritten registry entries.
		}
	}

	return entries.sort((a, b) => a.pid - b.pid);
}

export async function ensureReloadRequestsDir(): Promise<void> {
	await mkdir(RELOAD_REQUESTS_DIR, { recursive: true });
}

function reloadRequestPath(targetPid: number): string {
	return join(RELOAD_REQUESTS_DIR, `${targetPid}.json`);
}

export async function requestReload(targetPid: number, options?: { requestedByPid?: number; reason?: string }): Promise<void> {
	await ensureReloadRequestsDir();
	const request: ReloadRequest = {
		targetPid,
		requestedByPid: options?.requestedByPid,
		requestedAt: new Date().toISOString(),
		reason: options?.reason,
	};
	await writeJsonAtomic(reloadRequestPath(targetPid), request);
}

export async function requestReloadForOtherInteractiveSessions(currentPid: number, options?: {
	reason?: string;
}): Promise<{ requested: number; interactiveCount: number; skipped: string[] }> {
	const sessions = await readRegistryEntries();
	const interactiveSessions = sessions.filter((session) => session.mode === "interactive");
	const otherInteractiveSessions = interactiveSessions.filter((session) => session.pid !== currentPid);
	const skipped: string[] = [];
	let requested = 0;

	for (const session of otherInteractiveSessions) {
		try {
			await requestReload(session.pid, {
				requestedByPid: currentPid,
				reason: options?.reason,
			});
			requested += 1;
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to write reload request";
			skipped.push(`${session.pid}: ${message}`);
		}
	}

	return { requested, interactiveCount: interactiveSessions.length, skipped };
}

export async function consumeReloadRequest(targetPid: number): Promise<ReloadRequest | undefined> {
	const path = reloadRequestPath(targetPid);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return undefined;
	}

	try {
		const parsed = JSON.parse(raw) as Partial<ReloadRequest>;
		if (parsed.targetPid !== targetPid) return undefined;
		await rm(path, { force: true }).catch(() => undefined);
		return {
			targetPid,
			requestedAt: typeof parsed.requestedAt === "string" ? parsed.requestedAt : new Date().toISOString(),
			requestedByPid: typeof parsed.requestedByPid === "number" ? parsed.requestedByPid : undefined,
			reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
		};
	} catch {
		await rm(path, { force: true }).catch(() => undefined);
		return undefined;
	}
}

export default function reloadCoordinatorExtension(_pi: ExtensionAPI) {
	// Shared helper module for other extensions. Intentionally no-op.
}
