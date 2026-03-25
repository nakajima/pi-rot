import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { complete } from "@mariozechner/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

interface ActiveSessionRecord {
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
}

type SessionEntry = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number];

type MessageContentPart = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

const REGISTRY_DIR = join(getAgentDir(), "runtime", "instances");
const HEARTBEAT_MS = 15_000;
const STALE_GRACE_MS = 5 * 60_000;
const SUMMARY_MAX_CHARS = 16_000;
const SUMMARY_MAX_MESSAGES = 24;

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
	if (typeof content === "string") {
		return [content];
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const textParts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as MessageContentPart;
		if (block.type === "text" && typeof block.text === "string") {
			const text = block.text.trim();
			if (text) textParts.push(text);
		}
	}
	return textParts;
}

function extractToolCallLines(content: unknown): string[] {
	if (!Array.isArray(content)) {
		return [];
	}

	const lines: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as MessageContentPart;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		const args = block.arguments ?? {};
		const argsPreview = JSON.stringify(args);
		lines.push(
			argsPreview && argsPreview !== "{}"
				? `Tool call: ${block.name} ${argsPreview}`
				: `Tool call: ${block.name}`,
		);
	}
	return lines;
}

function buildConversationSnapshot(entries: SessionEntry[]): string {
	const messages = entries.filter((entry) => entry.type === "message").slice(-SUMMARY_MAX_MESSAGES);
	const sections: string[] = [];

	for (const entry of messages) {
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;

		const textParts = extractTextParts(entry.message.content);
		const lines: string[] = [];
		if (textParts.length > 0) {
			const label = role === "toolResult" ? "Tool result" : role === "user" ? "User" : "Assistant";
			lines.push(`${label}: ${textParts.join("\n")}`);
		}

		if (role === "assistant") {
			lines.push(...extractToolCallLines(entry.message.content));
		}

		if (lines.length > 0) {
			sections.push(lines.join("\n"));
		}
	}

	const snapshot = sections.join("\n\n");
	if (snapshot.length <= SUMMARY_MAX_CHARS) return snapshot;
	return snapshot.slice(snapshot.length - SUMMARY_MAX_CHARS);
}

function truncateSummary(text: string, maxLength = 140): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function sanitizeInline(text: string): string {
	return text.replace(/\s+/g, " ").replace(/^['"“”‘’]+|['"“”‘’]+$/g, "").trim();
}

function buildSummaryPrompt(ctx: ExtensionContext, sessionName?: string): string {
	const branch = ctx.sessionManager.getBranch();
	const conversation = buildConversationSnapshot(branch);
	const sessionFile = ctx.sessionManager.getSessionFile() ?? "ephemeral";

	return [
		"Summarize the work currently in progress in this coding session.",
		"Return only a single plain-text sentence, max 18 words.",
		"Focus on the current implementation task or investigation.",
		"Mention specific files, features, bugs, or refactors if they are clearly identifiable.",
		"Do not use bullets, markdown, quotes, prefixes, or hedging commentary.",
		"If the latest work is ambiguous, infer the most likely active task from the recent conversation and tool usage.",
		`Working directory: ${ctx.cwd}`,
		`Session file: ${sessionFile}`,
		`Session name: ${sessionName ?? "(none)"}`,
		"",
		"<conversation>",
		conversation || "No conversation content yet.",
		"</conversation>",
	].join("\n");
}

function summarizeAssistantWork(content: unknown): string | undefined {
	const text = sanitizeInline(extractTextParts(content).join(" "));
	if (!text) return undefined;

	const match = text.match(/(?:I(?:'m| am)?|We(?:'re| are)?|Now|Next|Working on|Implemented|Updating|Fixing|Refactoring)\b[^.?!]{0,140}[.?!]?/i);
	return truncateSummary(sanitizeInline(match ? match[0] : text));
}

function buildHeuristicWorkSummary(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message");
	const recent = branch.slice(-SUMMARY_MAX_MESSAGES);
	const conversationSnapshot = buildConversationSnapshot(recent);

	for (let i = recent.length - 1; i >= 0; i--) {
		const entry = recent[i];
		if (entry.message.role === "assistant") {
			const assistantSummary = summarizeAssistantWork(entry.message.content);
			if (assistantSummary) return assistantSummary;

			const toolCalls = extractToolCallLines(entry.message.content);
			if (toolCalls.length > 0) {
				return truncateSummary(`Using tools for ${sanitizeInline(toolCalls[toolCalls.length - 1].replace(/^Tool call:\s*/i, ""))}`);
			}
		}
	}

	for (let i = recent.length - 1; i >= 0; i--) {
		const entry = recent[i];
		if (entry.message.role === "user") {
			const userText = sanitizeInline(extractTextParts(entry.message.content).join(" "));
			if (userText) return truncateSummary(`Working on: ${userText}`);
		}
	}

	if (conversationSnapshot) {
		return truncateSummary(sanitizeInline(conversationSnapshot));
	}

	return undefined;
}

function extractSummaryText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((part): part is { type: "text"; text: string } => {
			return !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string";
		})
		.map((part) => part.text)
		.join(" ");
	const sanitized = truncateSummary(sanitizeInline(text));
	return sanitized || undefined;
}

async function ensureRegistryDir(): Promise<void> {
	await mkdir(REGISTRY_DIR, { recursive: true });
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const tempPath = `${path}.${process.pid}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tempPath, path);
}

export default function activeSessionRegistryExtension(pi: ExtensionAPI) {
	const pid = process.pid;
	const startedAt = new Date().toISOString();
	const mode = detectMode(process.argv);
	const instanceFile = join(REGISTRY_DIR, `${pid}.json`);
	let heartbeat: NodeJS.Timeout | undefined;
	let latestContext: ExtensionContext | undefined;
	let lastKnownModel: ActiveSessionRecord["model"];
	let latestWorkSummary: string | undefined;
	let latestWorkSummaryUpdatedAt: string | undefined;
	let summaryRunInFlight = false;
	let summaryRefreshRequested = false;
	let summaryGeneration = 0;
	let lastSummarizedLeafId: string | undefined;

	function buildRecord(ctx: ExtensionContext): ActiveSessionRecord {
		return {
			pid,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionName: pi.getSessionName() ?? undefined,
			model: ctx.model
				? {
					provider: ctx.model.provider,
					id: ctx.model.id,
				}
				: lastKnownModel,
			startedAt,
			lastSeenAt: new Date().toISOString(),
			mode,
			workSummary: latestWorkSummary,
			workSummaryUpdatedAt: latestWorkSummaryUpdatedAt,
		};
	}

	async function publish(ctx: ExtensionContext): Promise<void> {
		await ensureRegistryDir();
		await writeJsonAtomic(instanceFile, buildRecord(ctx));
	}

	async function cleanupStaleEntries(): Promise<void> {
		await ensureRegistryDir();
		const files = await readdir(REGISTRY_DIR).catch(() => [] as string[]);
		const now = Date.now();

		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const fullPath = join(REGISTRY_DIR, file);
			const pidPart = file.slice(0, -5);
			const otherPid = Number.parseInt(pidPart, 10);
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
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = undefined;
		}
		await rm(instanceFile, { force: true }).catch(() => undefined);
	}

	function startHeartbeat(ctx: ExtensionContext): void {
		latestContext = ctx;
		if (heartbeat) return;
		heartbeat = setInterval(() => {
			if (latestContext) {
				void publish(latestContext);
			}
		}, HEARTBEAT_MS);
	}

	async function refreshWorkSummary(ctx: ExtensionContext): Promise<void> {
		latestContext = ctx;
		summaryRefreshRequested = true;
		if (summaryRunInFlight) return;

		summaryRunInFlight = true;
		try {
			while (summaryRefreshRequested) {
				summaryRefreshRequested = false;
				const currentCtx = latestContext;
				if (!currentCtx) continue;

				const leafId = currentCtx.sessionManager.getLeafId() ?? undefined;
				if (leafId && leafId === lastSummarizedLeafId) continue;

				const generation = ++summaryGeneration;
				let summary = buildHeuristicWorkSummary(currentCtx);

				if (currentCtx.model) {
					try {
						const apiKey = await currentCtx.modelRegistry.getApiKey(currentCtx.model);
						if (apiKey) {
							const response = await complete(
								currentCtx.model,
								{
									messages: [
										{
											role: "user",
											content: [{ type: "text", text: buildSummaryPrompt(currentCtx, pi.getSessionName() ?? undefined) }],
											timestamp: Date.now(),
										},
									],
								},
								{ apiKey, maxTokens: 80 },
							);
							summary = extractSummaryText(response.content) ?? summary;
						}
					} catch {
						// Fall back to heuristic summary on provider/model failures.
					}
				}

				if (!summary || generation !== summaryGeneration) continue;

				latestWorkSummary = summary;
				latestWorkSummaryUpdatedAt = new Date().toISOString();
				lastSummarizedLeafId = leafId;
				await publish(currentCtx);
			}
		} finally {
			summaryRunInFlight = false;
		}
	}

	function requestWorkSummaryRefresh(ctx: ExtensionContext): void {
		void refreshWorkSummary(ctx);
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
			? {
				provider: ctx.model.provider,
				id: ctx.model.id,
			}
			: undefined;
			lastSummarizedLeafId = undefined;
		await cleanupStaleEntries();
		await publish(ctx);
		startHeartbeat(ctx);
		requestWorkSummaryRefresh(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		latestContext = ctx;
		lastSummarizedLeafId = undefined;
		await publish(ctx);
		requestWorkSummaryRefresh(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		latestContext = ctx;
		lastSummarizedLeafId = undefined;
		await publish(ctx);
		requestWorkSummaryRefresh(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		latestContext = ctx;
		lastKnownModel = {
			provider: event.model.provider,
			id: event.model.id,
		};
		await publish(ctx);
		requestWorkSummaryRefresh(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		latestContext = ctx;
		await publish(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestContext = ctx;
		requestWorkSummaryRefresh(ctx);
	});

	pi.on("session_shutdown", async () => {
		await removeInstanceFile();
	});
}
