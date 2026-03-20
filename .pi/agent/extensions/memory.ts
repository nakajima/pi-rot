import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

type MemorySource = "explicit" | "candidate";

interface MemoryItem {
	id: number;
	text: string;
	source: MemorySource;
	createdAt: string;
	updatedAt: string;
}

interface MemoryStore {
	version: 1;
	nextId: number;
	memories: MemoryItem[];
}

interface MemoryActionContext {
	hasUI: boolean;
	ui: ExtensionCommandContext["ui"];
}

const STORE_PATH = join(homedir(), ".pi", "agent", "global-memories.json");
const MEMORY_WARNING_BYTES = 4 * 1024;
const AUTO_MEMORY_PATTERNS = [
	/^\s*we always want\b/i,
	/^\s*we prefer\b/i,
	/^\s*please always\b/i,
	/^\s*always use\b/i,
	/^\s*never use\b/i,
	/^\s*(?:do not|don't) use\b/i,
	/^\s*default to\b/i,
	/^\s*by default\b/i,
];
const NEGATION_PATTERN = /\b(?:never|no|not|don't|do not|avoid|without|ban|forbid)\b/i;
const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"as",
	"at",
	"be",
	"by",
	"default",
	"do",
	"don't",
	"for",
	"from",
	"in",
	"into",
	"is",
	"it",
	"its",
	"of",
	"on",
	"or",
	"please",
	"that",
	"the",
	"their",
	"them",
	"then",
	"these",
	"this",
	"to",
	"use",
	"want",
	"we",
	"with",
]);

function emptyStore(): MemoryStore {
	return {
		version: 1,
		nextId: 1,
		memories: [],
	};
}

function canonicalizeMemoryText(text: string): string {
	return text.replace(/\s+/g, " ").trim().replace(/^['"`]+|['"`]+$/g, "");
}

function normalizeForComparison(text: string): string {
	return canonicalizeMemoryText(text)
		.toLowerCase()
		.replace(/[.!?]+$/g, "")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function stripPreferenceLead(text: string): string {
	return normalizeForComparison(text).replace(
		/^(?:we always want|we prefer|please always|always use|never use|do not use|dont use|default to|by default)\s+/,
		"",
	);
}

function tokenize(text: string): Set<string> {
	return new Set(
		stripPreferenceLead(text)
			.split(/\s+/)
			.filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
	);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;

	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) intersection += 1;
	}
	const union = new Set([...a, ...b]).size;
	return union === 0 ? 0 : intersection / union;
}

function memoryPolarity(text: string): "positive" | "negative" {
	return NEGATION_PATTERN.test(text) ? "negative" : "positive";
}

function findConflict(memories: MemoryItem[], candidateText: string): { duplicate?: MemoryItem; conflict?: MemoryItem } {
	const candidateNormalized = normalizeForComparison(candidateText);
	const candidateTokens = tokenize(candidateText);
	const candidatePolarity = memoryPolarity(candidateText);

	for (const memory of memories) {
		const existingNormalized = normalizeForComparison(memory.text);
		if (existingNormalized === candidateNormalized) {
			return { duplicate: memory };
		}

		const existingTokens = tokenize(memory.text);
		const similarity = jaccardSimilarity(candidateTokens, existingTokens);
		const sharedTokens = [...candidateTokens].filter((token) => existingTokens.has(token)).length;
		const polarityChanged = memoryPolarity(memory.text) !== candidatePolarity;

		if (polarityChanged && similarity >= 0.5 && sharedTokens >= 2) {
			return { conflict: memory };
		}
	}

	return {};
}

function buildMemoryPromptBlock(memories: MemoryItem[]): string {
	const lines = memories.map((memory) => `- ${memory.text}`);
	return [
		"Saved global user preferences (apply these unless the user explicitly overrides them in this conversation):",
		...lines,
	].join("\n");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	return `${(bytes / 1024).toFixed(1)}KB`;
}

function splitIntoCandidateSegments(text: string): string[] {
	return text
		.split(/\n+|(?<=[.!?])\s+/)
		.map((segment) => canonicalizeMemoryText(segment))
		.filter((segment) => segment.length > 0 && segment.length <= 240);
}

function extractMemoryCandidates(text: string): string[] {
	const candidates = new Set<string>();

	for (const segment of splitIntoCandidateSegments(text)) {
		if (AUTO_MEMORY_PATTERNS.some((pattern) => pattern.test(segment))) {
			candidates.add(segment);
		}
	}

	return [...candidates];
}

async function loadStore(): Promise<MemoryStore> {
	try {
		const raw = await readFile(STORE_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<MemoryStore> | undefined;
		const memories = Array.isArray(parsed?.memories)
			? parsed.memories
					.filter((memory): memory is MemoryItem => {
						return !!memory && typeof memory.id === "number" && typeof memory.text === "string";
					})
					.map((memory) => ({
						id: memory.id,
						text: canonicalizeMemoryText(memory.text),
						source: memory.source === "candidate" ? "candidate" : "explicit",
						createdAt: typeof memory.createdAt === "string" ? memory.createdAt : new Date().toISOString(),
						updatedAt: typeof memory.updatedAt === "string" ? memory.updatedAt : new Date().toISOString(),
					}))
			: [];
		const maxId = memories.reduce((highest, memory) => Math.max(highest, memory.id), 0);

		return {
			version: 1,
			nextId: Math.max(typeof parsed?.nextId === "number" ? parsed.nextId : 1, maxId + 1),
			memories,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") {
			return emptyStore();
		}
		throw error;
	}
}

async function saveStore(store: MemoryStore): Promise<void> {
	await mkdir(dirname(STORE_PATH), { recursive: true });
	const tempPath = `${STORE_PATH}.${process.pid}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
	await rename(tempPath, STORE_PATH);
}

async function withStore<T>(fn: (store: MemoryStore) => Promise<T>): Promise<T> {
	const store = await loadStore();
	const result = await fn(store);
	return result;
}

async function saveMemory(
	text: string,
	source: MemorySource,
	ctx: MemoryActionContext,
): Promise<{ status: "saved" | "duplicate" | "cancelled"; memory?: MemoryItem }> {
	const cleanedText = canonicalizeMemoryText(text);
	if (!cleanedText) {
		ctx.ui.notify("Memory text cannot be empty", "warning");
		return { status: "cancelled" };
	}

	return withStore(async (store) => {
		const { duplicate, conflict } = findConflict(store.memories, cleanedText);
		if (duplicate) {
			ctx.ui.notify(`Memory already exists as #${duplicate.id}`, "info");
			return { status: "duplicate", memory: duplicate };
		}

		if (conflict) {
			if (!ctx.hasUI) {
				return { status: "cancelled" };
			}
			const replace = await ctx.ui.confirm(
				"Replace conflicting memory?",
				`Existing #${conflict.id}: ${conflict.text}\n\nNew: ${cleanedText}`,
			);
			if (!replace) {
				ctx.ui.notify("Memory not saved", "info");
				return { status: "cancelled" };
			}
			store.memories = store.memories.filter((memory) => memory.id !== conflict.id);
		}

		const now = new Date().toISOString();
		const memory: MemoryItem = {
			id: store.nextId++,
			text: cleanedText,
			source,
			createdAt: now,
			updatedAt: now,
		};
		store.memories.push(memory);
		await saveStore(store);
		ctx.ui.notify(`Saved memory #${memory.id}`, "info");
		return { status: "saved", memory };
	});
}

async function deleteMemory(
	query: string,
	ctx: ExtensionCommandContext,
): Promise<{ status: "deleted" | "cancelled" | "not-found"; memory?: MemoryItem }> {
	const cleanedQuery = canonicalizeMemoryText(query);
	if (!cleanedQuery) {
		ctx.ui.notify("Usage: /forget <id|text>", "warning");
		return { status: "cancelled" };
	}

	return withStore(async (store) => {
		const byId = /^#?(\d+)$/.exec(cleanedQuery);
		const matches = byId
			? store.memories.filter((memory) => memory.id === Number(byId[1]))
			: store.memories.filter((memory) => normalizeForComparison(memory.text).includes(normalizeForComparison(cleanedQuery)));

		if (matches.length === 0) {
			ctx.ui.notify("No matching memory found", "warning");
			return { status: "not-found" };
		}

		if (matches.length > 1) {
			const ids = matches.map((memory) => `#${memory.id}`).join(", ");
			ctx.ui.notify(`Multiple matches found (${ids}). Use /forget <id>.`, "warning");
			return { status: "cancelled" };
		}

		const target = matches[0];
		if (ctx.hasUI) {
			const confirmed = await ctx.ui.confirm("Forget memory?", `#${target.id}: ${target.text}`);
			if (!confirmed) {
				return { status: "cancelled" };
			}
		}

		store.memories = store.memories.filter((memory) => memory.id !== target.id);
		await saveStore(store);
		ctx.ui.notify(`Forgot memory #${target.id}`, "info");
		return { status: "deleted", memory: target };
	});
}

class MemoryListComponent {
	private readonly memories: MemoryItem[];
	private readonly theme: Theme;
	private readonly onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(memories: MemoryItem[], theme: Theme, onClose: () => void) {
		this.memories = memories;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const lines: string[] = [];
		lines.push("");
		const title = th.fg("accent", " Global Memories ");
		const header = th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 20)));
		lines.push(truncateToWidth(header, width));
		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("muted", `${this.memories.length} memory item(s)`)}`, width));
		lines.push("");

		if (this.memories.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No saved memories yet. Use /remember <text>.")}`, width));
		} else {
			for (const memory of this.memories) {
				const id = th.fg("accent", `#${memory.id}`);
				const source = th.fg("dim", `[${memory.source}]`);
				lines.push(truncateToWidth(`  ${id} ${source} ${th.fg("text", memory.text)}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", `Store: ${STORE_PATH}`)}`, width));
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Enter or Escape to close")}`, width));
		lines.push("");

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}
}

export default function memoryExtension(pi: ExtensionAPI) {
	let warnedAboutLargeMemoryBlock = false;

	pi.registerCommand("remember", {
		description: "Save a global memory preference",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /remember <memory>", "warning");
				return;
			}
			await saveMemory(text, "explicit", ctx);
		},
	});

	pi.registerCommand("forget", {
		description: "Delete a saved global memory by id or text",
		handler: async (args, ctx) => {
			await deleteMemory(args, ctx);
		},
	});

	pi.registerCommand("memories", {
		description: "Show saved global memories",
		handler: async (_args, ctx) => {
			const store = await loadStore();
			const memories = [...store.memories].sort((a, b) => a.id - b.id);

			if (!ctx.hasUI) {
				ctx.ui.notify(`${memories.length} memory item(s) saved`, "info");
				return;
			}

			await ctx.ui.custom((_tui, theme, _kb, done) => {
				return new MemoryListComponent(memories, theme, () => done(undefined));
			});
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" };
		}

		const text = event.text.trim();
		if (!text || text.startsWith("/") || !ctx.hasUI) {
			return { action: "continue" };
		}

		const candidates = extractMemoryCandidates(text);
		for (const candidate of candidates) {
			const confirmed = await ctx.ui.confirm("Save as global memory?", candidate);
			if (confirmed) {
				await saveMemory(candidate, "candidate", ctx);
			}
		}

		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const store = await loadStore();
		if (store.memories.length === 0) {
			warnedAboutLargeMemoryBlock = false;
			return;
		}

		const promptBlock = buildMemoryPromptBlock(store.memories);
		const size = Buffer.byteLength(promptBlock, "utf8");
		if (size > MEMORY_WARNING_BYTES) {
			if (!warnedAboutLargeMemoryBlock && ctx.hasUI) {
				ctx.ui.notify(
					`Global memory block is large (${formatBytes(size)}). Consider pruning with /memories or /forget.`,
					"warning",
				);
			}
			warnedAboutLargeMemoryBlock = true;
		} else {
			warnedAboutLargeMemoryBlock = false;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${promptBlock}`,
		};
	});
}
