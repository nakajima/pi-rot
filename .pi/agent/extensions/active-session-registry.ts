import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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

interface SessionDigest {
	initialRequest?: string;
	latestRequest?: string;
	latestSubstantiveRequest?: string;
	recentAssistantUpdates: string[];
	touchedFiles: string[];
	recentActions: string[];
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
const SUMMARY_MAX_LENGTH = 120;
const DIGEST_MAX_USER_CHARS = 220;
const DIGEST_MAX_ASSISTANT_CHARS = 220;
const DIGEST_RECENT_MESSAGE_WINDOW = 40;
const DIGEST_MAX_ASSISTANT_UPDATES = 3;
const DIGEST_MAX_TOUCHED_FILES = 6;
const DIGEST_MAX_ACTIONS = 4;

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

function extractToolCalls(content: unknown): Array<{ name: string; arguments: Record<string, unknown> }> {
	if (!Array.isArray(content)) {
		return [];
	}

	const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as MessageContentPart;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		toolCalls.push({ name: block.name, arguments: block.arguments ?? {} });
	}
	return toolCalls;
}

function truncateSummary(text: string, maxLength = SUMMARY_MAX_LENGTH): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function sanitizeInline(text: string): string {
	return text.replace(/\s+/g, " ").replace(/^['"“”‘’]+|['"“”‘’]+$/g, "").trim();
}

function stripMarkdownArtifacts(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^\s{0,3}[-*+]\s+/gm, "")
		.replace(/^\s{0,3}\d+\.\s+/gm, "")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^>\s+/gm, "");
}

function normalizeSnippet(text: string, maxLength: number): string {
	const normalized = sanitizeInline(stripMarkdownArtifacts(text));
	if (!normalized) return "";
	return truncateSummary(normalized, maxLength);
}

function pushUnique(items: string[], seen: Set<string>, value: string | undefined, maxItems: number): void {
	if (!value) return;
	if (seen.has(value)) return;
	items.push(value);
	seen.add(value);
	if (items.length > maxItems) {
		const removed = items.shift();
		if (removed) seen.delete(removed);
	}
}

function toProjectRelativePath(cwd: string, rawPath: string): string | undefined {
	const cleaned = rawPath.replace(/^@/, "").trim();
	if (!cleaned) return undefined;

	const absolute = cleaned.startsWith("/") ? resolve(cleaned) : resolve(cwd, cleaned);
	const rel = relative(cwd, absolute);
	if (!rel || rel === ".") return undefined;
	if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) return undefined;

	const parts = rel.split(/[\\/]+/).filter(Boolean);
	if (parts.length <= 2) return parts.join("/");
	return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function extractTouchedFiles(
	ctx: ExtensionContext,
	toolName: string,
	args: Record<string, unknown>,
): string[] {
	if (toolName !== "read" && toolName !== "edit" && toolName !== "write") {
		return [];
	}

	const pathArg =
		typeof args.path === "string"
			? args.path
			: typeof args.file_path === "string"
				? args.file_path
				: undefined;
	if (!pathArg) return [];

	const projectPath = toProjectRelativePath(ctx.cwd, pathArg);
	return projectPath ? [projectPath] : [];
}

function inferActionLabel(toolName: string, args: Record<string, unknown>, touchedFiles: string[]): string | undefined {
	if (toolName === "edit") return touchedFiles.length > 0 ? "edited project files" : undefined;
	if (toolName === "write") return touchedFiles.length > 0 ? "wrote project files" : undefined;
	if (toolName === "read") return touchedFiles.length > 0 ? "read project files" : undefined;
	if (toolName !== "bash") return undefined;

	const command = typeof args.command === "string" ? args.command : "";
	if (!command) return undefined;
	if (/\bgit\s+(log|show|diff|status)\b/.test(command)) return "checked git history";
	if (/\b(?:rg|grep)\b/.test(command)) return "searched the repo";
	if (/\b(?:ls|find|fd|pwd)\b/.test(command)) return "inspected the repo layout";
	if (/\brm\b/.test(command)) return "cleaned up files";
	return "ran shell commands";
}

function isProceduralRequest(text: string): boolean {
	return /^(?:ok(?:ay)?|thanks?|thank you|looks good|sounds good|go ahead|continue|proceed|reload|commit(?: and push)?|push)(?:[.! ]+.*)?$/i.test(
		text,
	);
}

function isGenericFollowupRequest(text: string): boolean {
	return /^(?:clean it up|fix it|rename it|update it|do it|do that|same thing|make it better)(?:[.! ]+.*)?$/i.test(
		text,
	);
}

function normalizeSummaryCandidate(text: string): string {
	let normalized = normalizeSnippet(text, SUMMARY_MAX_LENGTH);
	normalized = normalized.replace(/^(?:summary|title|work summary|navigation title)\s*:\s*/i, "");
	normalized = normalized.replace(/[\s.?!:;,]+$/g, "").trim();
	return normalized;
}

function isValidSummaryCandidate(text: string): boolean {
	const normalized = normalizeSummaryCandidate(text);
	if (!normalized || normalized.length < 8) return false;
	if (/[\n\r{}\[\]<>"`]/.test(normalized)) return false;
	if (/^(?:user|assistant|tool result|tool call)\b/i.test(normalized)) return false;
	if (/^(?:using tools for|tool call|tool result)\b/i.test(normalized)) return false;
	if (/\/Users\/|runtime\/instances|agent\/sessions|\.jsonl\b/i.test(normalized)) return false;

	const words = normalized.split(/\s+/).filter(Boolean);
	if (words.length < 2) return false;
	if (/^[A-Za-z0-9._/-]+$/.test(normalized)) return false;
	if (/^(?:now|next|done|finished)\b\.?$/i.test(normalized)) return false;

	return true;
}

function buildSessionDigest(ctx: ExtensionContext): SessionDigest {
	const branch = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message");
	let initialRequest: string | undefined;
	let latestRequest: string | undefined;
	let latestSubstantiveRequest: string | undefined;

	for (const entry of branch) {
		if (entry.message.role !== "user") continue;
		const text = normalizeSnippet(extractTextParts(entry.message.content).join("\n"), DIGEST_MAX_USER_CHARS);
		if (!text) continue;
		if (!initialRequest) initialRequest = text;
		latestRequest = text;
		if (!isProceduralRequest(text)) {
			latestSubstantiveRequest = text;
		}
	}

	const recentMessages = branch.slice(-DIGEST_RECENT_MESSAGE_WINDOW);
	const recentAssistantUpdates: string[] = [];
	const recentAssistantUpdatesSeen = new Set<string>();
	const touchedFiles: string[] = [];
	const touchedFilesSeen = new Set<string>();
	const recentActions: string[] = [];
	const recentActionsSeen = new Set<string>();

	for (const entry of recentMessages) {
		if (entry.message.role !== "assistant") continue;

		const assistantText = normalizeSnippet(extractTextParts(entry.message.content).join("\n"), DIGEST_MAX_ASSISTANT_CHARS);
		if (assistantText) {
			pushUnique(
				recentAssistantUpdates,
				recentAssistantUpdatesSeen,
				assistantText,
				DIGEST_MAX_ASSISTANT_UPDATES,
			);
		}

		for (const toolCall of extractToolCalls(entry.message.content)) {
			const files = extractTouchedFiles(ctx, toolCall.name, toolCall.arguments);
			for (const file of files) {
				pushUnique(touchedFiles, touchedFilesSeen, file, DIGEST_MAX_TOUCHED_FILES);
			}

			pushUnique(
				recentActions,
				recentActionsSeen,
				inferActionLabel(toolCall.name, toolCall.arguments, files),
				DIGEST_MAX_ACTIONS,
			);
		}
	}

	return {
		initialRequest,
		latestRequest,
		latestSubstantiveRequest,
		recentAssistantUpdates,
		touchedFiles,
		recentActions,
	};
}

function formatSessionDigest(digest: SessionDigest): string {
	const lines: string[] = [];
	if (digest.initialRequest) lines.push(`Initial goal: ${digest.initialRequest}`);
	if (digest.latestRequest) lines.push(`Latest user request: ${digest.latestRequest}`);
	if (
		digest.latestSubstantiveRequest &&
		digest.latestSubstantiveRequest !== digest.latestRequest
	) {
		lines.push(`Latest substantive request: ${digest.latestSubstantiveRequest}`);
	}
	if (digest.recentAssistantUpdates.length > 0) {
		lines.push("Recent assistant updates:");
		for (const update of digest.recentAssistantUpdates) {
			lines.push(`- ${update}`);
		}
	}
	if (digest.touchedFiles.length > 0) {
		lines.push(`Touched files: ${digest.touchedFiles.join(", ")}`);
	}
	if (digest.recentActions.length > 0) {
		lines.push(`Recent actions: ${digest.recentActions.join(", ")}`);
	}
	return lines.join("\n");
}

function buildSummaryPrompt(ctx: ExtensionContext, digest: SessionDigest, sessionName?: string): string {
	const sessionFile = ctx.sessionManager.getSessionFile() ?? "ephemeral";

	return [
		"Summarize the work currently in progress in this coding session.",
		"Return only a single plain-text sentence, max 18 words.",
		"Focus on the current implementation task or investigation.",
		"The summary will be used as titles in navigation.",
		"Prefer the underlying task/topic over transient actions like commit, push, or reload.",
		"Use the structured digest below, not raw tool syntax.",
		"Do not output JSON, file contents, shell commands, or path fragments.",
		"Do not use bullets, markdown, quotes, prefixes, or hedging commentary.",
		`Working directory: ${ctx.cwd}`,
		`Session file: ${sessionFile}`,
		`Session name: ${sessionName ?? "(none)"}`,
		"",
		"<session-digest>",
		formatSessionDigest(digest) || "No task digest available yet.",
		"</session-digest>",
	].join("\n");
}

function buildFallbackWorkSummary(digest: SessionDigest): string | undefined {
	const files = digest.touchedFiles.slice(-2);
	const latestRequest = digest.latestRequest ? normalizeSummaryCandidate(digest.latestRequest) : undefined;
	const substantiveRequest = digest.latestSubstantiveRequest
		? normalizeSummaryCandidate(digest.latestSubstantiveRequest)
		: undefined;
	const initialRequest = digest.initialRequest ? normalizeSummaryCandidate(digest.initialRequest) : undefined;
	const latestAssistantUpdate = digest.recentAssistantUpdates.at(-1)
		? normalizeSummaryCandidate(digest.recentAssistantUpdates.at(-1) ?? "")
		: undefined;

	const candidates: Array<string | undefined> = [];
	if (latestRequest && isGenericFollowupRequest(latestRequest) && files.length > 0) {
		candidates.push(`${latestRequest} in ${files.join(", ")}`);
	}
	candidates.push(substantiveRequest);
	candidates.push(latestRequest);
	if (files.length > 0) {
		const lead = digest.recentActions.some((action) => action === "edited project files" || action === "wrote project files")
			? "Editing"
			: "Working in";
		candidates.push(`${lead} ${files.join(", ")}`);
	}
	candidates.push(initialRequest);
	candidates.push(latestAssistantUpdate);

	for (const candidate of candidates) {
		if (!candidate) continue;
		const normalized = normalizeSummaryCandidate(candidate);
		if (isValidSummaryCandidate(normalized)) {
			return normalized;
		}
	}

	return undefined;
}

function extractSummaryText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((part): part is { type: "text"; text: string } => {
			return (
				!!part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string"
			);
		})
		.map((part) => part.text)
		.join(" ");
	const normalized = normalizeSummaryCandidate(text);
	return isValidSummaryCandidate(normalized) ? normalized : undefined;
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
				const digest = buildSessionDigest(currentCtx);
				let summary = buildFallbackWorkSummary(digest);

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
											content: [{ type: "text", text: buildSummaryPrompt(currentCtx, digest, pi.getSessionName() ?? undefined) }],
											timestamp: Date.now(),
										},
									],
								},
								{ apiKey, maxTokens: 80 },
							);
							summary = extractSummaryText(response.content) ?? summary;
						}
					} catch {
						// Fall back to deterministic digest-based summary on provider/model failures.
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
