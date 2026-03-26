import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { consumeReloadRequest, ensureReloadRequestsDir, REGISTRY_DIR, type ActiveSessionRecord } from "./reload-coordinator";

type SessionBranchEntry = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number] & {
	type: string;
	timestamp?: unknown;
	message?: {
		role?: string;
		content?: unknown;
		timestamp?: unknown;
	};
};

type MessageContentPart = {
	type?: string;
	text?: string;
};

const HEARTBEAT_MS = 15_000;
const RELOAD_POLL_MS = 2_000;
const STALE_GRACE_MS = 5 * 60_000;
const LAST_MESSAGE_MAX_CHARS = 280;

function detectMode(argv: string[]): ActiveSessionRecord["mode"] {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-p" || arg === "--print") return "print";
		if (arg === "--mode") {
			const next = argv[i + 1];
			if (next === "rpc" || next === "json") return next;
		}
		if (arg === "--mode=rpc") return "rpc";
		if (arg === "--mode=json") return "json";
	}
	return process.stdout.isTTY ? "interactive" : "unknown";
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function extractTextParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as MessageContentPart;
		if (block.type === "text" && typeof block.text === "string") {
			const text = block.text.trim();
			if (text) parts.push(text);
		}
	}
	return parts;
}

function normalizeSnippet(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function coerceTimestamp(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed : undefined;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return new Date(value).toISOString();
	}
	return undefined;
}

type LastMessageSnapshot = {
	text: string;
	at?: string;
	role: "user" | "assistant";
};

function deriveLastMessageFromBranch(ctx: ExtensionContext): LastMessageSnapshot | undefined {
	const branch = ctx.sessionManager.getBranch() as SessionBranchEntry[];
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = normalizeSnippet(extractTextParts(entry.message.content).join("\n"), LAST_MESSAGE_MAX_CHARS);
		if (!text) continue;
		return {
			text,
			at: coerceTimestamp(entry.timestamp) ?? coerceTimestamp(entry.message.timestamp),
			role,
		};
	}
	return undefined;
}

async function ensureRegistryDir(): Promise<void> {
	await mkdir(REGISTRY_DIR, { recursive: true });
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tempPath, path);
}

export default function activeSessionRegistryExtension(pi: ExtensionAPI) {
	const pid = process.pid;
	const startedAt = new Date().toISOString();
	const mode = detectMode(process.argv);
	const instanceFile = join(REGISTRY_DIR, `${pid}.json`);
	const messagesFile = join(REGISTRY_DIR, `${pid}-messages.json`);
	let heartbeat: NodeJS.Timeout | undefined;
	let reloadPoll: NodeJS.Timeout | undefined;
	let latestContext: ExtensionContext | undefined;
	let lastKnownModel: ActiveSessionRecord["model"];
	let latestLastMessage: string | undefined;
	let latestLastMessageAt: string | undefined;
	let latestLastMessageRole: ActiveSessionRecord["lastMessageRole"];
	let selfReloadQueued = false;
	let publishQueue: Promise<void> = Promise.resolve();

	function buildRecord(ctx: ExtensionContext): ActiveSessionRecord {
		return {
			pid,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionName: pi.getSessionName() ?? undefined,
			model: ctx.model
				? { provider: ctx.model.provider, id: ctx.model.id }
				: lastKnownModel,
			startedAt,
			lastSeenAt: new Date().toISOString(),
			mode,
			lastMessage: latestLastMessage,
			lastMessageAt: latestLastMessageAt,
			lastMessageRole: latestLastMessageRole,
		};
	}

	async function publish(ctx: ExtensionContext): Promise<void> {
		const record = buildRecord(ctx);
		publishQueue = publishQueue
			.catch(() => undefined)
			.then(async () => {
				await ensureRegistryDir();
				await writeJsonAtomic(instanceFile, record);
			});
		return publishQueue;
	}

	async function cleanupStaleEntries(): Promise<void> {
		await ensureRegistryDir();
		const files = await readdir(REGISTRY_DIR).catch(() => [] as string[]);
		const now = Date.now();
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const fullPath = join(REGISTRY_DIR, file);
			const baseName = file.endsWith("-messages.json") ? file.slice(0, -"-messages.json".length) : file.slice(0, -5);
			const otherPid = Number.parseInt(baseName, 10);
			if (!Number.isFinite(otherPid) || otherPid === pid) continue;
			if (isProcessAlive(otherPid)) continue;
			try {
				const info = await stat(fullPath);
				if (now - info.mtimeMs < STALE_GRACE_MS) continue;
				await rm(fullPath, { force: true });
			} catch {
				// Ignore races or permission issues.
			}
		}
	}

	async function removeInstanceFile(): Promise<void> {
		if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
		if (reloadPoll) { clearInterval(reloadPoll); reloadPoll = undefined; }
		await publishQueue.catch(() => undefined);
		await rm(instanceFile, { force: true }).catch(() => undefined);
		await rm(messagesFile, { force: true }).catch(() => undefined);
	}

	async function checkForQueuedReload(ctx: ExtensionContext): Promise<void> {
		if (selfReloadQueued || mode !== "interactive") return;
		const request = await consumeReloadRequest(pid);
		if (!request) return;
		selfReloadQueued = true;
		if (ctx.hasUI) {
			const source = request.requestedByPid ? ` from pid ${request.requestedByPid}` : "";
			ctx.ui.notify(`Queued /reload${source}.`, "info");
		}
		pi.sendUserMessage("/reload", { deliverAs: "followUp" });
	}

	function startHeartbeat(ctx: ExtensionContext): void {
		latestContext = ctx;
		if (!heartbeat) {
			heartbeat = setInterval(() => {
				if (latestContext) void publish(latestContext);
			}, HEARTBEAT_MS);
		}
		if (!reloadPoll) {
			reloadPoll = setInterval(() => {
				if (latestContext) void checkForQueuedReload(latestContext);
			}, RELOAD_POLL_MS);
		}
	}

	async function writeMessages(ctx: ExtensionContext): Promise<void> {
		const branch = ctx.sessionManager.getBranch() as SessionBranchEntry[];
		const messages: unknown[] = [];
		for (const entry of branch) {
			if (entry.type !== "message" || !entry.message) continue;
			messages.push(entry.message);
		}
		await ensureRegistryDir();
		await writeJsonAtomic(messagesFile, messages);
	}

	function updateLastMessage(ctx: ExtensionContext): void {
		latestContext = ctx;
		const lastMessage = deriveLastMessageFromBranch(ctx);
		latestLastMessage = lastMessage?.text;
		latestLastMessageAt = lastMessage?.at;
		latestLastMessageRole = lastMessage?.role;
	}

	pi.registerCommand("active-sessions-path", {
		description: "Show the directory where the active pi session registry is written",
		handler: async (_args, ctx) => {
			await ensureRegistryDir();
			ctx.ui.notify(`Active pi session registry: ${REGISTRY_DIR}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestContext = ctx;
		lastKnownModel = ctx.model
			? { provider: ctx.model.provider, id: ctx.model.id }
			: undefined;
		await cleanupStaleEntries();
		await ensureReloadRequestsDir();
		updateLastMessage(ctx);
		await publish(ctx);
		startHeartbeat(ctx);
		await checkForQueuedReload(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		latestContext = ctx;
		updateLastMessage(ctx);
		await publish(ctx);
		await checkForQueuedReload(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		latestContext = ctx;
		updateLastMessage(ctx);
		await publish(ctx);
		await checkForQueuedReload(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		latestContext = ctx;
		lastKnownModel = { provider: event.model.provider, id: event.model.id };
		await publish(ctx);
		await checkForQueuedReload(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		latestContext = ctx;
		updateLastMessage(ctx);
		await publish(ctx);
		await writeMessages(ctx);
		await checkForQueuedReload(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestContext = ctx;
		updateLastMessage(ctx);
		await publish(ctx);
		await writeMessages(ctx);
		await checkForQueuedReload(ctx);
	});

	pi.on("session_shutdown", async () => {
		await removeInstanceFile();
	});
}
