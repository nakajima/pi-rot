import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

interface MemoryItem {
	text: string;
	inferred: boolean;
}

interface CandidateItem {
	text: string;
	evidenceCount: number;
	evidenceSnippets: string[];
}

interface MemoryStore {
	memories: MemoryItem[];
	candidates: CandidateItem[];
}

interface LoadedStore {
	store: MemoryStore;
	rawFile?: string;
}

type UIContext = Pick<ExtensionContext, "hasUI" | "ui">;
type StoredItem =
	| { kind: "memory"; memory: MemoryItem }
	| { kind: "candidate"; candidate: CandidateItem };

const STORE_PATH = join(homedir(), ".pi", "agent", "memories.md");
const LEGACY_STORE_PATH = join(homedir(), ".pi", "agent", "global-memories.json");
const MEMORY_WARNING_BYTES = 4 * 1024;
const MAX_CANDIDATE_SNIPPETS = 3;
const CANDIDATE_PROMOTION_THRESHOLD = 3;
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
const HIGH_CONFIDENCE_MEMORY_PATTERNS = [
	/^\s*please always\b/i,
	/^\s*always use\b/i,
	/^\s*never use\b/i,
	/^\s*(?:do not|don't) use\b/i,
	/^\s*we always want\b/i,
];
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
		memories: [],
		candidates: [],
	};
}

function canonicalizeMemoryText(text: string): string {
	return text.replace(/\s+/g, " ").trim().replace(/^['"`]+|['"`]+$/g, "");
}

function normalizeForComparison(text: string): string {
	return canonicalizeMemoryText(text)
		.toLowerCase()
		.replace(/\s*\[inferred\]\s*$/i, "")
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

function isHighConfidenceCandidate(text: string): boolean {
	return HIGH_CONFIDENCE_MEMORY_PATTERNS.some((pattern) => pattern.test(text));
}

function buildMemoryPromptBlock(memories: MemoryItem[]): string {
	const lines = memories.map((memory) => `- ${memory.text}`);
	return [
		"Saved global user preferences (apply these unless the user explicitly overrides them in this conversation):",
		...lines,
	].join("\n");
}

function parseHeadingSection(line: string): "memories" | "candidates" | undefined {
	const match = /^\s*#{1,6}\s+(.*?)\s*$/.exec(line);
	if (!match) return undefined;
	const title = normalizeForComparison(match[1] ?? "");
	if (title.includes("candidate")) return "candidates";
	if (title.includes("memory") || title.includes("memories")) return "memories";
	return undefined;
}

function isHeading(line: string): boolean {
	return /^\s*#{1,6}\s+/.test(line);
}

function parseMemoryBullet(text: string): MemoryItem | undefined {
	const inferred = /\s*\[inferred\]\s*$/i.test(text);
	const cleaned = canonicalizeMemoryText(text.replace(/\s*\[inferred\]\s*$/i, ""));
	if (!cleaned) return undefined;
	return { text: cleaned, inferred };
}

function parseCandidateBullet(text: string): CandidateItem | undefined {
	const match = /^(.*?)(?:\s+\[count:\s*(\d+)\])?\s*$/i.exec(text);
	if (!match) return undefined;
	const cleaned = canonicalizeMemoryText(match[1] ?? "");
	if (!cleaned) return undefined;
	const evidenceCount = Math.max(1, Number(match[2] ?? 1));
	return {
		text: cleaned,
		evidenceCount,
		evidenceSnippets: [],
	};
}

function dedupeMemories(memories: MemoryItem[]): MemoryItem[] {
	const deduped: MemoryItem[] = [];
	const indexByKey = new Map<string, number>();

	for (const memory of memories) {
		const cleaned = canonicalizeMemoryText(memory.text);
		if (!cleaned) continue;
		const normalized: MemoryItem = {
			text: cleaned,
			inferred: memory.inferred,
		};
		const key = normalizeForComparison(cleaned);
		const existingIndex = indexByKey.get(key);
		if (existingIndex === undefined) {
			indexByKey.set(key, deduped.length);
			deduped.push(normalized);
			continue;
		}

		const existing = deduped[existingIndex]!;
		if (!normalized.inferred && existing.inferred) {
			deduped[existingIndex] = normalized;
		}
	}

	return deduped;
}

function mergeCandidateSnippets(snippets: string[]): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();

	for (const snippet of snippets) {
		const cleaned = canonicalizeMemoryText(snippet);
		if (!cleaned) continue;
		const key = normalizeForComparison(cleaned);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(cleaned);
		if (merged.length >= MAX_CANDIDATE_SNIPPETS) break;
	}

	return merged;
}

function mergeCandidates(candidates: CandidateItem[], memories: MemoryItem[]): CandidateItem[] {
	const merged: CandidateItem[] = [];
	const indexByKey = new Map<string, number>();
	const memoryKeys = new Set(memories.map((memory) => normalizeForComparison(memory.text)));

	for (const candidate of candidates) {
		const cleaned = canonicalizeMemoryText(candidate.text);
		if (!cleaned) continue;
		const key = normalizeForComparison(cleaned);
		if (memoryKeys.has(key)) continue;

		const normalized: CandidateItem = {
			text: cleaned,
			evidenceCount: Math.max(1, Math.floor(candidate.evidenceCount || 1)),
			evidenceSnippets: mergeCandidateSnippets(candidate.evidenceSnippets),
		};
		const existingIndex = indexByKey.get(key);
		if (existingIndex === undefined) {
			indexByKey.set(key, merged.length);
			merged.push(normalized);
			continue;
		}

		const existing = merged[existingIndex]!;
		existing.evidenceCount += normalized.evidenceCount;
		existing.evidenceSnippets = mergeCandidateSnippets([...existing.evidenceSnippets, ...normalized.evidenceSnippets]);
	}

	return merged;
}

function normalizeStore(store: MemoryStore): MemoryStore {
	const memories = dedupeMemories(store.memories);
	const candidates = mergeCandidates(store.candidates, memories);
	return { memories, candidates };
}

function parseStore(raw: string): MemoryStore {
	const memories: MemoryItem[] = [];
	const candidates: CandidateItem[] = [];
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	let section: "memories" | "candidates" = "memories";
	let currentCandidate: CandidateItem | undefined;

	for (const line of lines) {
		const parsedSection = parseHeadingSection(line);
		if (parsedSection) {
			section = parsedSection;
			currentCandidate = undefined;
			continue;
		}

		const indent = /^\s*/.exec(line)?.[0].length ?? 0;
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("<!--")) {
			currentCandidate = undefined;
			continue;
		}

		if (section === "candidates" && indent >= 2 && /^-\s+/.test(trimmed) && currentCandidate) {
			const snippet = canonicalizeMemoryText(trimmed.replace(/^-\s+/, ""));
			if (snippet) {
				currentCandidate.evidenceSnippets.push(snippet);
			}
			continue;
		}

		if (indent < 2 && /^-\s+/.test(trimmed)) {
			const body = trimmed.replace(/^-\s+/, "");
			if (section === "candidates") {
				const candidate = parseCandidateBullet(body);
				if (candidate) {
					candidates.push(candidate);
					currentCandidate = candidate;
				}
			} else {
				const memory = parseMemoryBullet(body);
				if (memory) memories.push(memory);
				currentCandidate = undefined;
			}
			continue;
		}

		currentCandidate = undefined;
	}

	return normalizeStore({ memories, candidates });
}

function serializeStore(store: MemoryStore): string {
	const normalized = normalizeStore(store);
	const lines: string[] = ["# Memories", ""];

	for (const memory of normalized.memories) {
		lines.push(`- ${memory.text}${memory.inferred ? " [inferred]" : ""}`);
	}

	if (normalized.memories.length === 0) {
		lines.push("<!-- Add one memory per bullet. -->");
	}

	if (normalized.candidates.length > 0) {
		lines.push("", "## Candidate memories", "");
		for (const candidate of normalized.candidates) {
			lines.push(`- ${candidate.text} [count: ${candidate.evidenceCount}]`);
			for (const snippet of candidate.evidenceSnippets) {
				lines.push(`  - ${snippet}`);
			}
			lines.push("");
		}
		while (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}
	}

	return `${lines.join("\n")}\n`;
}

function mergeManagedSections(rawFile: string | undefined, store: MemoryStore): string {
	if (!rawFile) {
		return serializeStore(store);
	}

	const rawLines = rawFile.replace(/\r\n/g, "\n").split("\n");
	const memoriesIndex = rawLines.findIndex((line) => parseHeadingSection(line) === "memories");
	if (memoriesIndex === -1) {
		return serializeStore(store);
	}

	let endIndex = rawLines.length;
	for (let i = memoriesIndex + 1; i < rawLines.length; i++) {
		const line = rawLines[i]!;
		const managedSection = parseHeadingSection(line);
		if (managedSection === "memories" && i !== memoriesIndex) {
			endIndex = i;
			break;
		}
		if (managedSection === "candidates") {
			continue;
		}
		if (isHeading(line)) {
			endIndex = i;
			break;
		}
	}

	const replacement = serializeStore(store).trimEnd().split("\n");
	const merged = [...rawLines.slice(0, memoriesIndex), ...replacement, ...rawLines.slice(endIndex)];
	return `${merged.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

async function writeStoreFile(content: string): Promise<void> {
	await mkdir(dirname(STORE_PATH), { recursive: true });
	const tempPath = `${STORE_PATH}.${process.pid}.tmp`;
	await writeFile(tempPath, content, "utf8");
	await rename(tempPath, STORE_PATH);
}

async function saveStore(store: MemoryStore, rawFile?: string): Promise<void> {
	const normalized = normalizeStore(store);
	await writeStoreFile(mergeManagedSections(rawFile, normalized));
}

async function maybeMigrateLegacyStore(): Promise<LoadedStore | undefined> {
	try {
		const raw = await readFile(LEGACY_STORE_PATH, "utf8");
		const parsed = JSON.parse(raw) as
			| {
				memories?: Array<{ text?: string; source?: string }>;
			  }
			| undefined;
		const store = normalizeStore({
			memories: Array.isArray(parsed?.memories)
				? parsed.memories
						.filter((memory) => typeof memory?.text === "string")
						.map((memory) => ({
							text: canonicalizeMemoryText(memory!.text ?? ""),
							inferred: memory?.source === "candidate",
						}))
				: [],
			candidates: [],
		});
		await saveStore(store);
		return { store, rawFile: serializeStore(store) };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

async function loadStore(): Promise<LoadedStore> {
	try {
		const rawFile = await readFile(STORE_PATH, "utf8");
		return {
			store: parseStore(rawFile),
			rawFile,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") {
			const migrated = await maybeMigrateLegacyStore();
			if (migrated) return migrated;
			return { store: emptyStore() };
		}
		throw error;
	}
}

function findMemoryIndex(store: MemoryStore, text: string): number {
	const key = normalizeForComparison(text);
	return store.memories.findIndex((memory) => normalizeForComparison(memory.text) === key);
}

function findCandidateIndex(store: MemoryStore, text: string): number {
	const key = normalizeForComparison(text);
	return store.candidates.findIndex((candidate) => normalizeForComparison(candidate.text) === key);
}

function addSnippet(candidate: CandidateItem, snippet: string): void {
	candidate.evidenceSnippets = mergeCandidateSnippets([snippet, ...candidate.evidenceSnippets]);
}

function applyCandidatePromotions(store: MemoryStore): MemoryItem[] {
	const promoted: MemoryItem[] = [];
	const remaining: CandidateItem[] = [];

	for (const candidate of store.candidates) {
		if (candidate.evidenceCount >= CANDIDATE_PROMOTION_THRESHOLD) {
			if (findMemoryIndex(store, candidate.text) === -1) {
				const memory: MemoryItem = {
					text: candidate.text,
					inferred: true,
				};
				store.memories.push(memory);
				promoted.push(memory);
			}
			continue;
		}
		remaining.push(candidate);
	}

	store.memories = dedupeMemories(store.memories);
	store.candidates = mergeCandidates(remaining, store.memories);
	return promoted;
}

async function maybePromoteReadyCandidates(ctx?: UIContext): Promise<MemoryStore> {
	const loaded = await loadStore();
	const promoted = applyCandidatePromotions(loaded.store);
	if (promoted.length > 0) {
		await saveStore(loaded.store, loaded.rawFile);
		if (ctx?.hasUI) {
			const label = promoted.length === 1 ? promoted[0]!.text : `${promoted.length} memories`;
			ctx.ui.notify(`Promoted ${label} from candidate evidence`, "info");
		}
	}
	return loaded.store;
}

async function saveMemory(
	text: string,
	options: { inferred: boolean; removeCandidate?: boolean },
	ctx: UIContext,
): Promise<{ status: "saved" | "duplicate" | "updated" | "cancelled"; memory?: MemoryItem }> {
	const cleanedText = canonicalizeMemoryText(text);
	if (!cleanedText) {
		ctx.ui.notify("Memory text cannot be empty", "warning");
		return { status: "cancelled" };
	}

	const loaded = await loadStore();
	const existingIndex = findMemoryIndex(loaded.store, cleanedText);
	if (existingIndex !== -1) {
		const existing = loaded.store.memories[existingIndex]!;
		if (!options.inferred && existing.inferred) {
			loaded.store.memories[existingIndex] = { text: cleanedText, inferred: false };
			if (options.removeCandidate !== false) {
				loaded.store.candidates = loaded.store.candidates.filter(
					(candidate) => normalizeForComparison(candidate.text) !== normalizeForComparison(cleanedText),
				);
			}
			await saveStore(loaded.store, loaded.rawFile);
			ctx.ui.notify(`Updated memory: ${cleanedText}`, "info");
			return { status: "updated", memory: loaded.store.memories[existingIndex] };
		}
		ctx.ui.notify(`Memory already exists: ${existing.text}`, "info");
		return { status: "duplicate", memory: existing };
	}

	const memory: MemoryItem = {
		text: cleanedText,
		inferred: options.inferred,
	};
	loaded.store.memories.push(memory);
	if (options.removeCandidate !== false) {
		loaded.store.candidates = loaded.store.candidates.filter(
			(candidate) => normalizeForComparison(candidate.text) !== normalizeForComparison(cleanedText),
		);
	}
	await saveStore(loaded.store, loaded.rawFile);
	ctx.ui.notify(`Saved memory: ${cleanedText}`, "info");
	return { status: "saved", memory };
}

function scoreFuzzyMatch(query: string, text: string): number {
	const normalizedQuery = normalizeForComparison(query);
	const normalizedText = normalizeForComparison(text);
	if (!normalizedQuery || !normalizedText) return 0;
	if (normalizedQuery === normalizedText) return 100;
	if (normalizedText.includes(normalizedQuery)) return 80;
	if (normalizedQuery.includes(normalizedText)) return 70;

	const queryTokens = tokenize(query);
	const textTokens = tokenize(text);
	if (queryTokens.size === 0 || textTokens.size === 0) return 0;

	const similarity = jaccardSimilarity(queryTokens, textTokens);
	if (similarity >= 0.6) return 60;
	if (similarity >= 0.4) return 45;
	if (similarity >= 0.25) return 30;
	return 0;
}

async function chooseStoredItem(query: string, ctx: ExtensionCommandContext): Promise<StoredItem | undefined> {
	const cleanedQuery = canonicalizeMemoryText(query);
	if (!cleanedQuery) {
		ctx.ui.notify("Usage: /forget <text>", "warning");
		return undefined;
	}

	const loaded = await loadStore();
	const matches = [
		...loaded.store.memories.map((memory) => ({
			item: { kind: "memory", memory } as StoredItem,
			score: scoreFuzzyMatch(cleanedQuery, memory.text),
		})),
		...loaded.store.candidates.map((candidate) => ({
			item: { kind: "candidate", candidate } as StoredItem,
			score: scoreFuzzyMatch(cleanedQuery, candidate.text),
		})),
	]
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, 8);

	if (matches.length === 0) {
		ctx.ui.notify("No matching memory found", "warning");
		return undefined;
	}

	if (matches.length === 1 || !ctx.hasUI) {
		if (matches.length > 1 && !ctx.hasUI) {
			ctx.ui.notify("Multiple matches found. Re-run /forget in interactive mode or edit the markdown file directly.", "warning");
			return undefined;
		}
		return matches[0]!.item;
	}

	const labels = matches.map(({ item }) => {
		if (item.kind === "memory") {
			return `Memory: ${item.memory.text}${item.memory.inferred ? " [inferred]" : ""}`;
		}
		return `Candidate: ${item.candidate.text} [count: ${item.candidate.evidenceCount}]`;
	});
	const choice = await ctx.ui.select("Forget which item?", labels);
	if (!choice) return undefined;
	const index = labels.indexOf(choice);
	return index === -1 ? undefined : matches[index]!.item;
}

async function deleteMemory(query: string, ctx: ExtensionCommandContext): Promise<{ status: "deleted" | "cancelled" | "not-found" }> {
	const target = await chooseStoredItem(query, ctx);
	if (!target) {
		return { status: "not-found" };
	}

	const label =
		target.kind === "memory"
			? `${target.memory.text}${target.memory.inferred ? " [inferred]" : ""}`
			: `${target.candidate.text} [candidate x${target.candidate.evidenceCount}]`;
	if (ctx.hasUI) {
		const confirmed = await ctx.ui.confirm("Forget item?", label);
		if (!confirmed) {
			return { status: "cancelled" };
		}
	}

	const loaded = await loadStore();
	if (target.kind === "memory") {
		loaded.store.memories = loaded.store.memories.filter(
			(memory) => normalizeForComparison(memory.text) !== normalizeForComparison(target.memory.text),
		);
	} else {
		loaded.store.candidates = loaded.store.candidates.filter(
			(candidate) => normalizeForComparison(candidate.text) !== normalizeForComparison(target.candidate.text),
		);
	}
	await saveStore(loaded.store, loaded.rawFile);
	ctx.ui.notify(`Forgot ${target.kind}: ${target.kind === "memory" ? target.memory.text : target.candidate.text}`, "info");
	return { status: "deleted" };
}

async function observeCandidate(text: string, ctx: UIContext): Promise<{ promoted: boolean; shouldPromptInline: boolean }> {
	const cleanedText = canonicalizeMemoryText(text);
	if (!cleanedText) return { promoted: false, shouldPromptInline: false };

	const loaded = await loadStore();
	if (findMemoryIndex(loaded.store, cleanedText) !== -1) {
		return { promoted: false, shouldPromptInline: false };
	}

	const candidateIndex = findCandidateIndex(loaded.store, cleanedText);
	if (candidateIndex === -1) {
		loaded.store.candidates.push({
			text: cleanedText,
			evidenceCount: 1,
			evidenceSnippets: [cleanedText],
		});
	} else {
		const candidate = loaded.store.candidates[candidateIndex]!;
		candidate.evidenceCount += 1;
		addSnippet(candidate, cleanedText);
	}

	const promoted = applyCandidatePromotions(loaded.store);
	await saveStore(loaded.store, loaded.rawFile);
	if (promoted.length > 0 && ctx.hasUI) {
		const label = promoted.length === 1 ? promoted[0]!.text : `${promoted.length} memories`;
		ctx.ui.notify(`Promoted ${label} from candidate evidence`, "info");
	}

	return {
		promoted: promoted.some((memory) => normalizeForComparison(memory.text) === normalizeForComparison(cleanedText)),
		shouldPromptInline: isHighConfidenceCandidate(cleanedText) && promoted.length === 0,
	};
}

class MemoryListComponent {
	private readonly store: MemoryStore;
	private readonly theme: Theme;
	private readonly onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(store: MemoryStore, theme: Theme, onClose: () => void) {
		this.store = store;
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
		const title = th.fg("accent", " Memories ");
		const header = th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 14)));
		lines.push(truncateToWidth(header, width));
		lines.push("");
		lines.push(
			truncateToWidth(
				`  ${th.fg("muted", `${this.store.memories.length} memory item(s) • ${this.store.candidates.length} candidate(s)`)}`,
				width,
			),
		);
		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("accent", "Saved memories")}`, width));
		lines.push("");

		if (this.store.memories.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No saved memories yet. Use /remember <text>.")}`, width));
		} else {
			for (const memory of this.store.memories) {
				lines.push(
					truncateToWidth(
						`  • ${th.fg("text", memory.text)}${memory.inferred ? ` ${th.fg("dim", "[inferred]")}` : ""}`,
						width,
					),
				);
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("accent", "Candidate memories")}`, width));
		lines.push("");
		if (this.store.candidates.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No candidate memories queued.")}`, width));
		} else {
			for (const candidate of this.store.candidates) {
				lines.push(
					truncateToWidth(
						`  • ${th.fg("text", candidate.text)} ${th.fg("dim", `[count: ${candidate.evidenceCount}]`)}`,
						width,
					),
				);
				for (const snippet of candidate.evidenceSnippets) {
					lines.push(truncateToWidth(`      ${th.fg("dim", `- ${snippet}`)}`, width));
				}
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", `Store: ${STORE_PATH}`)}`, width));
		lines.push(truncateToWidth(`  ${th.fg("dim", "Edit the markdown file directly, or use /remember and /forget.")}`, width));
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
	let promptedCandidateKeys = new Set<string>();

	async function resetSessionState(ctx: UIContext): Promise<void> {
		promptedCandidateKeys = new Set<string>();
		await maybePromoteReadyCandidates(ctx);
	}

	pi.registerCommand("remember", {
		description: "Save a global memory preference",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /remember <memory>", "warning");
				return;
			}
			await saveMemory(text, { inferred: false }, ctx);
		},
	});

	pi.registerCommand("forget", {
		description: "Delete a saved memory or candidate by text",
		handler: async (args, ctx) => {
			await deleteMemory(args, ctx);
		},
	});

	pi.registerCommand("memories", {
		description: "Show saved global memories",
		handler: async (_args, ctx) => {
			const loaded = await loadStore();
			const store = normalizeStore(loaded.store);

			if (!ctx.hasUI) {
				ctx.ui.notify(`${store.memories.length} memories and ${store.candidates.length} candidates saved`, "info");
				return;
			}

			await ctx.ui.custom((_tui, theme, _kb, done) => {
				return new MemoryListComponent(store, theme, () => done(undefined));
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await resetSessionState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await resetSessionState(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		await resetSessionState(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" };
		}

		const text = event.text.trim();
		if (!text || text.startsWith("/")) {
			return { action: "continue" };
		}

		const candidates = extractMemoryCandidates(text);
		for (const candidate of candidates) {
			const result = await observeCandidate(candidate, ctx);
			const key = normalizeForComparison(candidate);
			if (!result.shouldPromptInline || result.promoted || !ctx.hasUI || promptedCandidateKeys.has(key)) {
				continue;
			}

			promptedCandidateKeys.add(key);
			const confirmed = await ctx.ui.confirm("Save as global memory?", candidate);
			if (confirmed) {
				await saveMemory(candidate, { inferred: true }, ctx);
			}
		}

		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const store = await maybePromoteReadyCandidates(ctx);
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
