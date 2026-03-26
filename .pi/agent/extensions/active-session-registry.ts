import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

interface StoredWorkTitleState {
	title: string;
	topicKey: string;
	updatedAt: string;
}

interface BaseWorkTitle {
	title: string;
	topicKey: string;
	tokens: string[];
	source: "sessionName" | "request" | "stored";
	updatedAt?: string;
}

interface RequestWorkTitle extends BaseWorkTitle {
	source: "request";
	kind: "task" | "inquiry";
}

type DerivedWorkTitle = BaseWorkTitle | RequestWorkTitle;

type SessionEntry = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number];

type SessionBranchEntry = SessionEntry & {
	type: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		content?: unknown;
	};
};

type MessageContentPart = {
	type?: string;
	text?: string;
};

const REGISTRY_DIR = join(getAgentDir(), "runtime", "instances");
const STATE_ENTRY = "active-session-registry-work-title-v2";
const HEARTBEAT_MS = 15_000;
const STALE_GRACE_MS = 5 * 60_000;
const REQUEST_MAX_CHARS = 220;
const TITLE_MAX_CHARS = 88;
const SAME_TOPIC_OVERLAP = 0.3;

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"another",
	"are",
	"as",
	"at",
	"be",
	"been",
	"being",
	"but",
	"by",
	"can",
	"codebase",
	"could",
	"did",
	"do",
	"does",
	"done",
	"for",
	"from",
	"had",
	"has",
	"have",
	"how",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"just",
	"lets",
	"let",
	"maybe",
	"me",
	"more",
	"my",
	"now",
	"of",
	"ok",
	"okay",
	"on",
	"or",
	"our",
	"out",
	"please",
	"pls",
	"really",
	"repo",
	"same",
	"should",
	"so",
	"some",
	"something",
	"still",
	"sure",
	"that",
	"the",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"thing",
	"this",
	"those",
	"to",
	"up",
	"us",
	"use",
	"very",
	"want",
	"was",
	"we",
	"were",
	"what",
	"when",
	"where",
	"which",
	"who",
	"why",
	"with",
	"without",
	"would",
	"you",
	"your",
]);

const ACTION_WORDS = new Set([
	"add",
	"build",
	"change",
	"check",
	"clean",
	"commit",
	"continue",
	"create",
	"debug",
	"do",
	"edit",
	"explain",
	"explore",
	"fix",
	"implement",
	"investigate",
	"make",
	"pull",
	"push",
	"refactor",
	"reload",
	"remove",
	"rename",
	"review",
	"rewrite",
	"ship",
	"summarize",
	"sync",
	"test",
	"trace",
	"understand",
	"update",
	"work",
	"write",
]);

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

function stripMarkdownArtifacts(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^\s{0,3}[-*+]\s+/gm, "")
		.replace(/^\s{0,3}\d+\.\s+/gm, "")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^>\s+/gm, "");
}

function sanitizeInline(text: string): string {
	return text.replace(/\s+/g, " ").replace(/^['"“”‘’]+|['"“”‘’]+$/g, "").trim();
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizeSnippet(text: string, maxLength: number): string {
	const normalized = sanitizeInline(stripMarkdownArtifacts(text));
	if (!normalized) return "";
	return truncate(normalized, maxLength);
}

function firstSentence(text: string): string {
	const match = text.match(/^(.+?)(?:[.?!](?:\s|$)|$)/);
	return match ? match[1].trim() : text.trim();
}

function capitalizeFirst(text: string): string {
	if (!text) return text;
	return text[0].toUpperCase() + text.slice(1);
}

function stripLeadingPreamble(text: string): string {
	return text
		.replace(/^(?:ok(?:ay)?|please|pls|hey|well|so|alright|all right)\s+/i, "")
		.replace(/^(?:can|could|would)\s+you\s+(?:please\s+)?/i, "")
		.replace(/^(?:can|could|would)\s+we\s+(?:please\s+)?/i, "")
		.replace(/^(?:let'?s|lets)\s+/i, "")
		.trim();
}

function isProceduralRequest(text: string): boolean {
	return /^(?:ok(?:ay)?|yes|yeah|yep|sure|thanks?|thank you|looks good|sounds good|go ahead|continue|proceed|reload|commit(?: and push)?|push|start implementing based on the agreed summary and implementation plan|you need more information before you can continue)(?:[.! ]+.*)?$/i.test(
		text,
	);
}

function isReferentialFollowup(text: string): boolean {
	const normalized = stripLeadingPreamble(text).toLowerCase();
	return /^(?:clean(?: up)?|fix|rename|update|implement|review|refactor|rewrite|remove|make|do|check|take)\s+(?:it|that|this|them)\b/.test(
		normalized,
	);
}

function stemToken(token: string): string {
	if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
	if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
	if (token.endsWith("s") && token.length > 3 && !token.endsWith("ss")) return token.slice(0, -1);
	return token;
}

function extractTopicTokens(text: string): string[] {
	const normalized = text.toLowerCase().replace(/[`'"“”‘’]/g, " ").replace(/[\/_.-]+/g, " ");
	const rawTokens = normalized.match(/[a-z0-9]+/g) ?? [];
	const tokens: string[] = [];
	const seen = new Set<string>();

	for (const raw of rawTokens) {
		const token = stemToken(raw);
		if (token.length < 2) continue;
		if (STOP_WORDS.has(token)) continue;
		if (ACTION_WORDS.has(token)) continue;
		if (seen.has(token)) continue;
		tokens.push(token);
		seen.add(token);
	}

	return tokens;
}

function hasStrongTopicSignal(text: string, tokens: string[]): boolean {
	if (tokens.length >= 2) return true;
	if (/[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/.test(text)) return true;
	if (/\/[A-Za-z0-9._-]+/.test(text)) return true;
	return false;
}

function normalizeTitle(text: string): string {
	let title = firstSentence(normalizeSnippet(text, TITLE_MAX_CHARS));
	title = title.replace(/^the\s+/i, "");
	title = title.replace(/\bin this (?:repo|codebase)\b/gi, "");
	title = title.replace(/\bfor this (?:repo|codebase)\b/gi, "");
	title = sanitizeInline(title).replace(/[.?!:;,]+$/g, "").trim();
	title = truncate(title, TITLE_MAX_CHARS);
	return capitalizeFirst(title);
}

function isValidWorkTitle(text: string): boolean {
	const title = normalizeTitle(text);
	if (!title || title.length < 6) return false;
	if (/[\n\r{}\[\]<>"`]/.test(title)) return false;
	if (/\/Users\/|runtime\/instances|agent\/sessions|\.jsonl\b/i.test(title)) return false;
	if (isProceduralRequest(title) || isReferentialFollowup(title)) return false;
	return extractTopicTokens(title).length >= 2;
}

function topicKeyFromTokens(tokens: string[]): string {
	return tokens.join(" ");
}

function topicOverlap(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	const aSet = new Set(a);
	let shared = 0;
	for (const token of b) {
		if (aSet.has(token)) shared += 1;
	}
	return shared / Math.min(a.length, b.length);
}

function classifyRequestKind(text: string): "task" | "inquiry" | "generic" {
	if (!text) return "generic";
	if (isProceduralRequest(text) || isReferentialFollowup(text)) return "generic";
	if (/^(?:what|why|where|when|how|who|which)\b/i.test(text)) return "inquiry";
	if (/^(?:do|did|does|is|are|was|were|have|has)\b/i.test(text)) return "inquiry";
	return "task";
}

function titleFromRequestText(text: string, kind: "task" | "inquiry"): string {
	let title = stripLeadingPreamble(firstSentence(text));

	if (kind === "task") {
		const rewrites: Array<[RegExp, string]> = [
			[/^(?:can|could|would)\s+(?:we|you)\s+add\s+/i, "Add "],
			[/^(?:can|could|would)\s+(?:we|you)\s+remove\s+/i, "Remove "],
			[/^(?:can|could|would)\s+(?:we|you)\s+rename\s+/i, "Rename "],
			[/^(?:can|could|would)\s+(?:we|you)\s+fix\s+/i, "Fix "],
			[/^(?:can|could|would)\s+(?:we|you)\s+update\s+/i, "Update "],
			[/^(?:can|could|would)\s+(?:we|you)\s+implement\s+/i, "Implement "],
			[/^(?:can|could|would)\s+(?:we|you)\s+review\s+/i, "Review "],
			[/^(?:can|could|would)\s+(?:we|you)\s+refactor\s+/i, "Refactor "],
			[/^(?:can|could|would)\s+(?:we|you)\s+/i, ""],
		];
		for (const [pattern, replacement] of rewrites) {
			if (pattern.test(title)) {
				title = title.replace(pattern, replacement);
				break;
			}
		}
	} else {
		const rewrites: Array<[RegExp, string]> = [
			[/^what(?:'s| is) the status of\s+/i, "Status of "],
			[/^why do we have\s+/i, ""],
			[/^why (?:is|are) there\s+/i, ""],
			[/^why (?:is|are)\s+/i, ""],
			[/^how (?:do|does|did)\s+/i, "How "],
			[/^where (?:is|are)\s+/i, "Where "],
		];
		for (const [pattern, replacement] of rewrites) {
			if (pattern.test(title)) {
				title = title.replace(pattern, replacement);
				break;
			}
		}
	}

	return normalizeTitle(title);
}

function deriveTitleFromRequest(rawText: string): RequestWorkTitle | undefined {
	const requestText = normalizeSnippet(rawText, REQUEST_MAX_CHARS);
	if (!requestText) return undefined;

	const sentence = stripLeadingPreamble(firstSentence(requestText));
	if (/\bconvo mode\b|\bagreed summary and implementation plan\b|\[CONVO_COMPLETE\]/i.test(sentence)) {
		return undefined;
	}
	const kind = classifyRequestKind(sentence);
	if (kind === "generic") return undefined;

	const requestTokens = extractTopicTokens(sentence);
	if (!hasStrongTopicSignal(sentence, requestTokens)) return undefined;

	const title = titleFromRequestText(sentence, kind);
	if (!isValidWorkTitle(title)) return undefined;

	const titleTokens = extractTopicTokens(title);
	const tokens = titleTokens.length > 0 ? titleTokens : requestTokens;
	return {
		title,
		topicKey: topicKeyFromTokens(tokens),
		tokens,
		source: "request",
		kind,
	};
}

function deriveTitleFromSessionName(sessionName?: string | null): DerivedWorkTitle | undefined {
	if (!sessionName) return undefined;
	const title = normalizeTitle(sessionName);
	if (!isValidWorkTitle(title)) return undefined;
	const tokens = extractTopicTokens(title);
	return {
		title,
		topicKey: topicKeyFromTokens(tokens),
		tokens,
		source: "sessionName",
	};
}

function readStoredWorkTitleState(data: unknown): StoredWorkTitleState | undefined {
	if (!data || typeof data !== "object") return undefined;
	const entry = data as { title?: unknown; topicKey?: unknown; updatedAt?: unknown };
	if (typeof entry.title !== "string" || typeof entry.topicKey !== "string") return undefined;
	return {
		title: entry.title,
		topicKey: entry.topicKey,
		updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString(),
	};
}

function deriveTitleFromStoredState(data: unknown): DerivedWorkTitle | undefined {
	const stored = readStoredWorkTitleState(data);
	if (!stored) return undefined;
	const title = normalizeTitle(stored.title);
	if (!isValidWorkTitle(title)) return undefined;
	const tokens = extractTopicTokens(title);
	return {
		title,
		topicKey: stored.topicKey,
		tokens,
		source: "stored",
		updatedAt: stored.updatedAt,
	};
}

function shouldReplaceWorkTitle(current: DerivedWorkTitle | undefined, next: RequestWorkTitle): boolean {
	if (!current) return true;
	if (current.topicKey === next.topicKey) return false;
	if (topicOverlap(current.tokens, next.tokens) >= SAME_TOPIC_OVERLAP) return false;
	if (next.kind === "inquiry" && next.tokens.length < 3) return false;
	return true;
}

function deriveWorkTitleFromBranch(ctx: ExtensionContext, sessionName?: string | null): DerivedWorkTitle | undefined {
	const namedTitle = deriveTitleFromSessionName(sessionName);
	const branch = ctx.sessionManager.getBranch() as SessionBranchEntry[];
	let current: DerivedWorkTitle | undefined;

	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
			const stored = deriveTitleFromStoredState(entry.data);
			if (stored) current = stored;
			continue;
		}

		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const requestText = extractTextParts(entry.message.content).join("\n");
		const candidate = deriveTitleFromRequest(requestText);
		if (!candidate) continue;
		if (shouldReplaceWorkTitle(current, candidate)) current = candidate;
	}

	return namedTitle ?? current;
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
	let heartbeat: NodeJS.Timeout | undefined;
	let latestContext: ExtensionContext | undefined;
	let lastKnownModel: ActiveSessionRecord["model"];
	let latestWorkSummary: string | undefined;
	let latestWorkSummaryUpdatedAt: string | undefined;
	let latestWorkTopicKey: string | undefined;
	let publishQueue: Promise<void> = Promise.resolve();

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
		await publishQueue.catch(() => undefined);
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

	async function updateWorkTitle(ctx: ExtensionContext, options?: { persist?: boolean }): Promise<void> {
		latestContext = ctx;
		const derived = deriveWorkTitleFromBranch(ctx, pi.getSessionName() ?? undefined);
		const nextTitle = derived?.title;
		const nextTopicKey = derived?.topicKey;
		const changed = nextTitle !== latestWorkSummary || nextTopicKey !== latestWorkTopicKey;
		if (!changed) return;

		latestWorkSummary = nextTitle;
		latestWorkTopicKey = nextTopicKey;
		latestWorkSummaryUpdatedAt = nextTitle ? new Date().toISOString() : undefined;

		if (options?.persist && derived?.source === "request" && nextTitle && nextTopicKey) {
			pi.appendEntry(STATE_ENTRY, {
				title: nextTitle,
				topicKey: nextTopicKey,
				updatedAt: latestWorkSummaryUpdatedAt,
			});
		}
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
		await cleanupStaleEntries();
		await updateWorkTitle(ctx);
		await publish(ctx);
		startHeartbeat(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		latestContext = ctx;
		await updateWorkTitle(ctx);
		await publish(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		latestContext = ctx;
		await updateWorkTitle(ctx);
		await publish(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		latestContext = ctx;
		lastKnownModel = {
			provider: event.model.provider,
			id: event.model.id,
		};
		await publish(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		latestContext = ctx;
		await publish(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestContext = ctx;
		await updateWorkTitle(ctx, { persist: true });
		await publish(ctx);
	});

	pi.on("session_shutdown", async () => {
		await removeInstanceFile();
	});
}
