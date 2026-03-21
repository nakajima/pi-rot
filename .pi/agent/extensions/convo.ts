import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Editor, type EditorTheme, Text, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

interface ConvoAnswer {
	id: string;
	question: string;
	options: string[];
	selectedIndex: number;
	selectedLabel: string;
	note: string;
	progressCurrent: number;
	progressTotal: number;
}

type ConvoConfidence = "low" | "medium" | "high";
type ConvoFirstStep = "plan" | "summary" | "menu" | "missing";

interface ConvoPreflight {
	displaySeed: string;
	summary: string;
	confidence: ConvoConfidence;
	firstStep: ConvoFirstStep;
}

interface ConvoState {
	active: boolean;
	seed: string;
	useExistingContext?: boolean;
	startedAt?: number;
	answers: ConvoAnswer[];
	progressCurrent?: number;
	progressTotal?: number;
	questionnaireRetryCount?: number;
	preflight?: ConvoPreflight;
}

interface ConvoBatchResultDetails {
	cancelled: boolean;
	exited: boolean;
	answers: ConvoAnswer[];
	current?: ConvoAnswer;
}

const STATE_ENTRY = "convo-state";
const STATUS_ID = "convo-mode";
const WIDGET_ID = "convo-mode";
const COMPLETE_MARKER = "[CONVO_COMPLETE]";
const FALLBACK_OPTION = "None of these / something else";
const SESSION_CONTEXT_SEED = "Use the existing session context so far.";
const MAX_DISPLAY_SEED = 90;
const MAX_RECENT_SNIPPETS = 4;
const MAX_SCANNED_FILES = 240;
const MAX_SCAN_DEPTH = 4;
const MAX_RELEVANT_FILES = 4;
const SUMMARY_HEADINGS = ["goal", "requirements", "constraints", "assumptions", "implementation plan", "open questions"] as const;
const RESOLVED_OPEN_QUESTIONS = ["none", "n/a", "na", "no open questions", "no unresolved questions", "none at this time"];
const PROJECT_KEY_FILES = [
	"readme.md",
	"package.json",
	"tsconfig.json",
	"cargo.toml",
	"pyproject.toml",
	"go.mod",
	"makefile",
	"justfile",
	"deno.json",
	"biome.json",
	"eslint.config.js",
	"eslint.config.mjs",
	"vite.config.ts",
	"next.config.js",
	"src/index.ts",
	"src/main.ts",
	".pi/agent/extensions/convo.ts",
];
const SCAN_SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".turbo",
	"target",
	"out",
	"tmp",
	"temp",
]);
const SCAN_SKIP_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg",
	".pdf",
	".zip",
	".gz",
	".tar",
	".mp4",
	".mov",
	".mp3",
	".wav",
	".woff",
	".woff2",
	".ttf",
	".ico",
	".lock",
]);

const IMPLEMENTATION_INTENT = [
	/\bgo ahead\b/i,
	/\bstart coding\b/i,
	/\bwrite the code\b/i,
	/\bship it\b/i,
	/\blet'?s do it\b/i,
	/^(can|could|would|will)\s+you\s+.*\b(implement|build|code|write)\b/i,
];

const CLARIFICATION_REQUEST_PHRASES = [
	"i need a few more details",
	"i need a few more specifics",
	"i need more details",
	"i need more information",
	"i need a bit more information",
	"i need a little more information",
	"i need a few more pieces of information",
	"i have a few questions",
	"i have a couple of questions",
	"a few quick questions",
	"a couple of quick questions",
	"before i can proceed",
	"before i can implement",
	"to make the project concrete",
	"to make this project concrete",
	"to make this concrete",
] as const;

const ConvoQuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable identifier for this question within the batch." })),
	question: Type.String({ description: "The clarification question to ask the user." }),
	options: Type.Array(Type.String({ description: "A selectable answer option." }), {
		description: "Three to five concrete answer choices. Include only concrete options; the extension adds a 'None of these / something else' fallback if needed.",
	}),
});

const ConvoQuestionnaireParams = Type.Object({
	questions: Type.Array(ConvoQuestionSchema, {
		description: "A batch of clarification questions to ask in one local questionnaire pass.",
	}),
	progressCurrent: Type.Optional(Type.Integer({ description: "Current step number for the first question in this batch, e.g. 3 for question 3/N." })),
	progressTotal: Type.Optional(Type.Integer({ description: "Estimated total number of questions across the whole discovery flow, e.g. N for question 3/N." })),
});

class ConvoEditor extends CustomEditor {
	isConvoActive: () => boolean = () => false;
	onExitConvo: () => void = () => {};

	override handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c") && this.isConvoActive()) {
			this.onExitConvo();
			return;
		}
		super.handleInput(data);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.isConvoActive() || lines.length === 0) return lines;

		const label = " CONVO ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function normalizeProgressValue(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(1, Math.floor(value));
}

function normalizeOptions(options: string[]): string[] {
	const cleaned = options
		.map((option) => option.trim())
		.filter((option, index, arr) => option.length > 0 && arr.indexOf(option) === index);

	if (
		!cleaned.some((option) => {
			const normalized = option.toLowerCase();
			return (
				normalized === "other" ||
				normalized.startsWith("other ") ||
				normalized.includes("not sure") ||
				normalized.includes("more detail") ||
				normalized.includes("none of these")
			);
		})
	) {
		cleaned.push(FALLBACK_OPTION);
	}

	return cleaned.length > 0 ? cleaned : [FALLBACK_OPTION];
}

function sanitizeAnswer(input: ConvoAnswer): ConvoAnswer {
	const options = normalizeOptions(input.options);
	const selectedIndex = clamp(input.selectedIndex, 0, Math.max(0, options.length - 1));
	return {
		...input,
		question: input.question.trim(),
		options,
		selectedIndex,
		selectedLabel: options[selectedIndex] ?? input.selectedLabel.trim(),
		note: input.note,
		progressCurrent: Math.max(1, input.progressCurrent),
		progressTotal: Math.max(Math.max(1, input.progressCurrent), input.progressTotal),
	};
}

function formatAnswerForModel(answer: ConvoAnswer, index: number): string {
	const lines = [
		`${index + 1}. Question: ${answer.question}`,
		`   Options shown: ${answer.options.map((option, optionIndex) => `${optionIndex + 1}. ${option}`).join(" | ")}`,
		`   Selected: ${answer.selectedIndex + 1}. ${answer.selectedLabel}`,
	];
	if (answer.note.trim()) lines.push(`   Additional context: ${answer.note.trim()}`);
	return lines.join("\n");
}

function buildToolContent(answers: ConvoAnswer[]): string {
	const lines = ["Structured answer history:"];
	for (let i = 0; i < answers.length; i++) {
		lines.push(formatAnswerForModel(answers[i]!, i));
	}
	return lines.join("\n");
}

function getMessageText(message: { content?: unknown }): string {
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type?: string; text?: string } => typeof part === "object" && part !== null)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxLength: number): string {
	const normalized = normalizeWhitespace(text);
	return normalized.length > maxLength ? `${normalized.slice(0, Math.max(1, maxLength - 3))}...` : normalized;
}

function isInternalConvoMessage(text: string): boolean {
	const normalized = text.trim();
	return [
		/^\/convo(?:\s+|$)/i,
		/^let'?s work this out together before implementation/i,
		/^keep refining this\.?/i,
		/^start implementing based on the agreed summary and implementation plan\.?/i,
		/^your last summary still listed unresolved open questions/i,
		/^you still need more information\.?/i,
	].some((pattern) => pattern.test(normalized));
}

function getRecentUserMessages(ctx: ExtensionContext, maxMessages = MAX_RECENT_SNIPPETS): string[] {
	const branch = ctx.sessionManager.getBranch();
	const messages: string[] = [];

	for (let i = branch.length - 1; i >= 0 && messages.length < maxMessages; i--) {
		const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = getMessageText(entry.message);
		if (!text || isInternalConvoMessage(text)) continue;
		messages.push(text);
	}

	return messages.reverse();
}

function getRecentConversationSnippets(ctx: ExtensionContext, maxMessages = MAX_RECENT_SNIPPETS): string[] {
	const branch = ctx.sessionManager.getBranch();
	const snippets: string[] = [];

	for (let i = branch.length - 1; i >= 0 && snippets.length < maxMessages; i--) {
		const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = getMessageText(entry.message);
		if (!text || (role === "user" && isInternalConvoMessage(text))) continue;
		snippets.push(`${role}: ${truncateText(text, 160)}`);
	}

	return snippets.reverse();
}

function deriveSessionSeed(ctx: ExtensionContext): string {
	const recentUserMessages = getRecentUserMessages(ctx, 6);
	for (let i = recentUserMessages.length - 1; i >= 0; i--) {
		const candidate = normalizeWhitespace(recentUserMessages[i]!);
		if (!candidate) continue;
		return truncateText(candidate, MAX_DISPLAY_SEED);
	}
	return SESSION_CONTEXT_SEED;
}

function hasMeaningfulSessionContext(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager.getBranch();
	let totalChars = 0;
	let userMessages = 0;

	for (const entry of branch) {
		const messageEntry = entry as { type?: string; message?: { role?: string; content?: unknown } };
		if (messageEntry.type !== "message" || !messageEntry.message) continue;
		const role = messageEntry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = getMessageText(messageEntry.message);
		if (!text || (role === "user" && isInternalConvoMessage(text))) continue;
		totalChars += text.length;
		if (role === "user") userMessages++;
	}

	return userMessages > 0 && totalChars >= 40;
}

function compareProjectEntries(a: string, b: string): number {
	const aIsDir = a.endsWith("/");
	const bIsDir = b.endsWith("/");
	if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
	return a.localeCompare(b);
}

async function getTopLevelProjectEntries(cwd: string): Promise<string[]> {
	try {
		const entries = await readdir(cwd, { withFileTypes: true });
		return entries
			.filter((entry) => entry.name !== ".git")
			.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
			.sort(compareProjectEntries)
			.slice(0, 12);
	} catch {
		return [];
	}
}

function shouldSkipScanPath(name: string, isDirectory: boolean): boolean {
	if (!name || name === "." || name === "..") return true;
	if (isDirectory) return SCAN_SKIP_DIRS.has(name);
	const extension = extname(name).toLowerCase();
	return SCAN_SKIP_EXTENSIONS.has(extension);
}

async function listProjectFiles(root: string, maxFiles = MAX_SCANNED_FILES, maxDepth = MAX_SCAN_DEPTH): Promise<string[]> {
	const files: string[] = [];
	const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

	while (queue.length > 0 && files.length < maxFiles) {
		const next = queue.shift();
		if (!next) break;

		let entries;
		try {
			entries = await readdir(next.dir, { withFileTypes: true });
		} catch {
			continue;
		}

		entries.sort((a, b) => compareProjectEntries(a.isDirectory() ? `${a.name}/` : a.name, b.isDirectory() ? `${b.name}/` : b.name));

		for (const entry of entries) {
			if (shouldSkipScanPath(entry.name, entry.isDirectory())) continue;
			const fullPath = join(next.dir, entry.name);
			if (entry.isDirectory()) {
				if (next.depth < maxDepth) queue.push({ dir: fullPath, depth: next.depth + 1 });
				continue;
			}
			files.push(relative(root, fullPath).replace(/\\/g, "/"));
			if (files.length >= maxFiles) break;
		}
	}

	return files;
}

function extractRequestTokens(text: string): string[] {
	const stopwords = new Set([
		"the",
		"and",
		"for",
		"with",
		"that",
		"this",
		"from",
		"into",
		"about",
		"before",
		"after",
		"there",
		"their",
		"seems",
		"right",
		"needs",
		"need",
		"more",
		"some",
		"like",
		"have",
		"just",
		"work",
		"start",
		"implementation",
		"together",
	]);
	const matches = text.toLowerCase().match(/[a-z0-9._/-]+/g) ?? [];
	return [...new Set(matches.filter((token) => token.length >= 2 && !/^\d+$/.test(token) && !stopwords.has(token)))];
}

function summarizeFilePreview(path: string, content: string): string {
	const filename = basename(path).toLowerCase();
	if (filename === "package.json") {
		try {
			const parsed = JSON.parse(content) as {
				name?: string;
				scripts?: Record<string, string>;
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
			};
			const parts: string[] = [];
			if (parsed.name) parts.push(`name=${parsed.name}`);
			const scripts = Object.keys(parsed.scripts ?? {}).slice(0, 4);
			if (scripts.length > 0) parts.push(`scripts=${scripts.join(", ")}`);
			const deps = Object.keys({ ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) }).slice(0, 4);
			if (deps.length > 0) parts.push(`deps=${deps.join(", ")}`);
			if (parts.length > 0) return truncateText(parts.join("; "), 180);
		} catch {
			// Fall through to generic preview.
		}
	}

	const lines = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.filter((line) => !line.startsWith("//") && !line.startsWith("/*") && !line.startsWith("*") && !/^import\s/.test(line))
		.slice(0, 4)
		.map((line) => line.replace(/^#+\s*/, ""));
	if (lines.length === 0) return "No obvious preview.";
	return truncateText(lines.join(" "), 180);
}

function scoreProjectFile(path: string, requestTokens: string[]): { score: number; reasons: string[] } {
	const lowerPath = path.toLowerCase();
	const filename = basename(lowerPath);
	let score = 0;
	const reasons: string[] = [];

	for (const token of requestTokens) {
		if (!token) continue;
		if (lowerPath === token || lowerPath.endsWith(`/${token}`)) {
			score += 8;
			reasons.push(`explicit path match: ${token}`);
			continue;
		}
		if (filename === token) {
			score += 6;
			reasons.push(`file name match: ${token}`);
			continue;
		}
		if (token.includes("/") && lowerPath.includes(token)) {
			score += 4;
			reasons.push(`path overlap: ${token}`);
			continue;
		}
		if (filename.includes(token) || lowerPath.includes(`/${token}`)) {
			score += 2;
			reasons.push(`name overlap: ${token}`);
		}
	}

	if (PROJECT_KEY_FILES.includes(lowerPath) || PROJECT_KEY_FILES.includes(filename)) {
		score += 2;
		reasons.push("project entrypoint/config");
	}
	if (/convo|extension|prompt|agent|question|plan|readme/.test(lowerPath)) {
		score += 1;
	}

	return { score, reasons: [...new Set(reasons)].slice(0, 3) };
}

function shouldInspectRelevantFiles(requestText: string, topLevelEntries: string[]): boolean {
	const normalized = requestText.toLowerCase();
	const tokens = extractRequestTokens(requestText);
	if (/[a-z0-9_./-]+\.[a-z0-9]+|[a-z0-9_-]+\/[a-z0-9_./-]+/i.test(requestText)) return true;
	if (/\b(file|files|repo|repository|code|component|module|function|class|command|extension|tool|questionnaire|prompt|bug|feature|refactor|implement|fix)\b/i.test(normalized)) {
		return true;
	}
	if (tokens.length >= 6) return true;
	return topLevelEntries.some((entry) => /^(src|app|lib|packages|cmd|services|crates|\.pi)\/?$/i.test(entry.replace(/\/$/, "")));
}

async function getRelevantProjectFiles(
	cwd: string,
	requestText: string,
): Promise<Array<{ path: string; reason: string; preview: string }>> {
	const projectFiles = await listProjectFiles(cwd);
	const requestTokens = extractRequestTokens(requestText);
	const scored = projectFiles
		.map((path) => {
			const score = scoreProjectFile(path, requestTokens);
			return {
				path,
				score: score.score,
				reason: score.reasons.join(", "),
			};
		})
		.filter((file) => file.score > 0)
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

	const selected = scored.length > 0 ? scored.slice(0, MAX_RELEVANT_FILES) : [];
	if (selected.length === 0) {
		for (const keyFile of PROJECT_KEY_FILES) {
			if (selected.length >= MAX_RELEVANT_FILES) break;
			const found = projectFiles.find((file) => file.toLowerCase() === keyFile || basename(file).toLowerCase() === keyFile);
			if (!found || selected.some((entry) => entry.path === found)) continue;
			selected.push({ path: found, score: 1, reason: "project key file" });
		}
	}

	const enriched: Array<{ path: string; reason: string; preview: string }> = [];
	for (const file of selected) {
		try {
			const content = await readFile(join(cwd, file.path), "utf8");
			enriched.push({
				path: file.path,
				reason: file.reason,
				preview: summarizeFilePreview(file.path, content),
			});
		} catch {
			enriched.push({
				path: file.path,
				reason: file.reason,
				preview: "Preview unavailable.",
			});
		}
	}

	return enriched;
}

function getFirstStepDescription(step: ConvoFirstStep): string {
	switch (step) {
		case "plan":
			return "Start with a concrete summary/plan instead of generic questions.";
		case "summary":
			return "Present the inferred understanding, ask for correction, then ask only the top 1-2 missing questions.";
		case "menu":
			return "Offer 2-4 adaptive task directions with a 'None of these / something else' escape hatch, then ask only the top 1-2 missing questions.";
		case "missing":
		default:
			return "Ask only the top 1-2 highest-value missing questions after a brief inferred summary.";
	}
}

function assessConvoPreflight(input: {
	requestText: string;
	recentSnippets: string[];
	relevantFiles: Array<{ path: string; reason: string; preview: string }>;
	topLevelEntries: string[];
}): { confidence: ConvoConfidence; firstStep: ConvoFirstStep; reasons: string[] } {
	const requestText = normalizeWhitespace(input.requestText);
	const lower = requestText.toLowerCase();
	const requestTokens = extractRequestTokens(requestText);
	let specificity = 0;
	let repoMatch = 0;
	let ambiguity = 0;
	const reasons: string[] = [];

	if (requestText.length >= 48 || requestTokens.length >= 8) {
		specificity += 1;
		reasons.push("request has meaningful detail");
	}
	if (/\b(fix|implement|build|refactor|rename|add|remove|update|debug|inspect|wire|extend|change)\b/i.test(requestText)) {
		specificity += 1;
		reasons.push("request implies a concrete action");
	}
	if (/[a-z0-9_./-]+\.[a-z0-9]+|[a-z0-9_-]+\/[a-z0-9_./-]+/i.test(requestText)) {
		specificity += 2;
		reasons.push("request names a specific path or file");
	}
	if (input.recentSnippets.length >= 2) {
		specificity += 1;
		reasons.push("recent chat history adds context");
	}

	if (input.topLevelEntries.length > 0) repoMatch += 1;
	if (input.relevantFiles.length > 0) {
		repoMatch += 1;
		reasons.push(`found ${input.relevantFiles.length} likely relevant file${input.relevantFiles.length === 1 ? "" : "s"}`);
	}
	if (input.relevantFiles.some((file) => /explicit path match|file name match/.test(file.reason))) {
		repoMatch += 1;
		reasons.push("request overlaps with repo file names");
	}

	if (requestText.length < 24) ambiguity += 1;
	if (/\b(something|somehow|stuff|things|maybe|not sure|kind of|sort of|seems dumb)\b/i.test(lower)) {
		ambiguity += 1;
		reasons.push("request still has ambiguity");
	}

	let confidence: ConvoConfidence = "low";
	if (specificity >= 3 && repoMatch >= 2 && ambiguity === 0) confidence = "high";
	else if (specificity + repoMatch >= 3) confidence = "medium";

	let firstStep: ConvoFirstStep = "missing";
	if (confidence === "high") {
		firstStep = "plan";
	} else if (confidence === "medium") {
		firstStep = /\bor\b|\bvs\b|\bbetween\b|\boptions?\b|\bdirections?\b/i.test(lower) ? "menu" : "summary";
	}

	return {
		confidence,
		firstStep,
		reasons: [...new Set(reasons)].slice(0, 5),
	};
}

async function buildConvoPreflight(seed: string, ctx: ExtensionContext, options?: { useExistingContext?: boolean }): Promise<ConvoPreflight> {
	const displaySeed = truncateText(options?.useExistingContext ? deriveSessionSeed(ctx) : seed, MAX_DISPLAY_SEED);
	const recentSnippets = getRecentConversationSnippets(ctx);
	const requestText = normalizeWhitespace([
		seed,
		...getRecentUserMessages(ctx, MAX_RECENT_SNIPPETS),
	]
		.filter((value) => value && !isInternalConvoMessage(value))
		.join("\n"));
	const topLevelEntries = await getTopLevelProjectEntries(ctx.cwd);
	const inspectRelevantFiles = shouldInspectRelevantFiles(requestText || displaySeed, topLevelEntries);
	const relevantFiles = inspectRelevantFiles ? await getRelevantProjectFiles(ctx.cwd, requestText || displaySeed) : [];
	const assessment = assessConvoPreflight({
		requestText: requestText || displaySeed,
		recentSnippets,
		relevantFiles,
		topLevelEntries,
	});

	const lines = [
		"[CONVO PREFLIGHT]",
		`Display seed: ${displaySeed}`,
		`User request summary: ${truncateText(requestText || displaySeed, 220)}`,
		recentSnippets.length > 0 ? `Recent chat history:\n- ${recentSnippets.join("\n- ")}` : "Recent chat history: none",
		topLevelEntries.length > 0 ? `Repo structure: ${topLevelEntries.join(", ")}` : "Repo structure: unavailable",
		relevantFiles.length > 0
			? `Likely relevant files reviewed:\n- ${relevantFiles
					.map((file) => `${file.path} — ${file.reason || "repo signal"}; ${file.preview}`)
					.join("\n- ")}`
			: inspectRelevantFiles
				? "Likely relevant files reviewed: none"
				: "Likely relevant files reviewed: skipped to keep the preflight lightweight",
		`Confidence: ${assessment.confidence}`,
		assessment.reasons.length > 0 ? `Confidence reasons: ${assessment.reasons.join("; ")}` : "Confidence reasons: limited signals",
		`Recommended first interaction: ${getFirstStepDescription(assessment.firstStep)}`,
	].filter(Boolean);

	return {
		displaySeed,
		summary: lines.join("\n"),
		confidence: assessment.confidence,
		firstStep: assessment.firstStep,
	};
}

function getLastAssistantText(messages: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		return message.content
			.filter((part) => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function looksLikeImplementationIntent(text: string): boolean {
	return IMPLEMENTATION_INTENT.some((pattern) => pattern.test(text));
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSummaryHeading(line: string): { heading: (typeof SUMMARY_HEADINGS)[number]; remainder: string } | undefined {
	let normalized = line.trim();
	if (!normalized) return undefined;

	normalized = normalized
		.replace(/^[-*•]\s*/, "")
		.replace(/^#{1,6}\s*/, "")
		.replace(/^\d+[.)]\s*/, "")
		.replace(/\*\*/g, "")
		.replace(/__/g, "")
		.trim();

	for (const heading of SUMMARY_HEADINGS) {
		const pattern = new RegExp(`^${escapeRegExp(heading)}(?:\\s*:)?(?:\\s+(.*))?$`, "i");
		const match = normalized.match(pattern);
		if (!match) continue;
		return {
			heading,
			remainder: (match[1] ?? "").trim(),
		};
	}

	return undefined;
}

function getSummarySectionLines(text: string, targetHeading: (typeof SUMMARY_HEADINGS)[number]): string[] {
	const lines = text.split(/\r?\n/);
	const sectionLines: string[] = [];
	let collecting = false;

	for (const line of lines) {
		const parsed = parseSummaryHeading(line);
		if (parsed) {
			if (collecting && parsed.heading !== targetHeading) break;
			if (parsed.heading === targetHeading) {
				collecting = true;
				if (parsed.remainder) sectionLines.push(parsed.remainder);
				continue;
			}
		}
		if (collecting) sectionLines.push(line);
	}

	return sectionLines;
}

function isResolvedOpenQuestionLine(line: string): boolean {
	const normalized = line
		.toLowerCase()
		.replace(/^[\s\-–—*•\d.()]+/, "")
		.replace(/[.!]+$/, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) return true;
	return RESOLVED_OPEN_QUESTIONS.includes(normalized);
}

function hasUnresolvedOpenQuestions(text: string): boolean {
	const lines = getSummarySectionLines(text, "open questions")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && line !== COMPLETE_MARKER);

	if (lines.length === 0) return false;
	return lines.some((line) => !isResolvedOpenQuestionLine(line));
}

function hasSummaryShape(text: string): boolean {
	const normalized = text.toLowerCase();
	return normalized.includes("implementation plan") && SUMMARY_HEADINGS.filter((heading) => normalized.includes(heading)).length >= 3;
}

function looksComplete(text: string): boolean {
	const hasCompletionSignal = text.includes(COMPLETE_MARKER) || hasSummaryShape(text);
	return hasCompletionSignal && !hasUnresolvedOpenQuestions(text);
}

function looksInsufficientContext(text: string): boolean {
	const normalized = text.toLowerCase();
	return [
		"not enough context",
		"don't have enough context",
		"do not have enough context",
		"need more context to proceed",
		"need an idea to proceed",
		"please provide an idea",
		"give me an idea to work from",
	].some((phrase) => normalized.includes(phrase));
}

function looksLikeClarificationRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	return CLARIFICATION_REQUEST_PHRASES.some((phrase) => normalized.includes(phrase)) || text.includes("?");
}

export default function convoExtension(pi: ExtensionAPI) {
	let state: ConvoState = {
		active: false,
		seed: "",
		useExistingContext: false,
		answers: [],
		questionnaireRetryCount: 0,
		preflight: undefined,
	};
	let usedQuestionnaireThisAgentRun = false;

	function persistState(): void {
		pi.appendEntry(STATE_ENTRY, { ...state });
	}

	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		if (!state.active) {
			ctx.ui.setStatus(STATUS_ID, undefined);
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}

		const seed = truncateText(state.preflight?.displaySeed || state.seed, MAX_DISPLAY_SEED);
		const hasKnownProgress =
			typeof state.progressCurrent === "number" &&
			typeof state.progressTotal === "number" &&
			state.progressCurrent > 0 &&
			state.progressTotal > 0;
		const statusText = hasKnownProgress ? `convo ${state.progressCurrent}/${state.progressTotal}` : "convo";
		ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", statusText));

		const contextLine = state.useExistingContext ? `Context: ${seed}` : `Idea: ${seed}`;
		const lines = [
			ctx.ui.theme.fg(
				"accent",
				hasKnownProgress ? `Convo mode active • ${state.progressCurrent}/${state.progressTotal}` : "Convo mode active",
			),
			ctx.ui.theme.fg("muted", contextLine),
		];
		if (state.preflight) {
			lines.push(
				ctx.ui.theme.fg(
					"dim",
					`Preflight: ${state.preflight.confidence} confidence • ${getFirstStepDescription(state.preflight.firstStep)}`,
				),
			);
		}
		lines.push(ctx.ui.theme.fg("dim", "Ctrl+C exit • ↑↓ / Ctrl+P Ctrl+N navigate • Tab add context"));
		if (state.answers.length > 0) {
			const latest = state.answers[state.answers.length - 1]!;
			lines.push(ctx.ui.theme.fg("dim", `Latest: ${latest.selectedLabel}`));
		}
		ctx.ui.setWidget(WIDGET_ID, lines);
	}

	function restoreState(ctx: ExtensionContext): void {
		state = {
			active: false,
			seed: "",
			useExistingContext: false,
			answers: [],
			questionnaireRetryCount: 0,
			preflight: undefined,
		};

		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as {
				type?: string;
				customType?: string;
				data?: Partial<ConvoState>;
			};
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;

			const restoredAnswers = Array.isArray(entry.data?.answers)
				? entry.data!.answers!
						.filter((answer): answer is ConvoAnswer => typeof answer === "object" && answer !== null)
						.map((answer) => sanitizeAnswer(answer))
				: [];
			const restoredPreflight =
				entry.data?.preflight &&
				typeof entry.data.preflight === "object" &&
				typeof entry.data.preflight.displaySeed === "string" &&
				typeof entry.data.preflight.summary === "string" &&
				(entry.data.preflight.confidence === "low" ||
					entry.data.preflight.confidence === "medium" ||
					entry.data.preflight.confidence === "high") &&
				(entry.data.preflight.firstStep === "plan" ||
					entry.data.preflight.firstStep === "summary" ||
					entry.data.preflight.firstStep === "menu" ||
					entry.data.preflight.firstStep === "missing")
					? {
						displaySeed: entry.data.preflight.displaySeed,
						summary: entry.data.preflight.summary,
						confidence: entry.data.preflight.confidence,
						firstStep: entry.data.preflight.firstStep,
					}
					: undefined;

			state = {
				active: entry.data?.active === true,
				seed: typeof entry.data?.seed === "string" ? entry.data.seed : "",
				useExistingContext: entry.data?.useExistingContext === true,
				startedAt: typeof entry.data?.startedAt === "number" ? entry.data.startedAt : undefined,
				answers: restoredAnswers,
				progressCurrent:
					typeof entry.data?.progressCurrent === "number"
						? Math.max(1, Math.floor(entry.data.progressCurrent))
						: undefined,
				progressTotal:
					typeof entry.data?.progressTotal === "number"
						? Math.max(1, Math.floor(entry.data.progressTotal))
						: undefined,
				questionnaireRetryCount:
					typeof entry.data?.questionnaireRetryCount === "number"
						? Math.max(0, Math.floor(entry.data.questionnaireRetryCount))
						: 0,
				preflight: restoredPreflight,
			};
			break;
		}

		updateUI(ctx);
	}

	function exitConvo(ctx: ExtensionContext, message = "Exited convo mode."): void {
		if (!state.active) return;
		state = { ...state, active: false, questionnaireRetryCount: 0 };
		persistState();
		updateUI(ctx);
		ctx.ui.notify(message, "info");
	}

	function enterConvo(seed: string, ctx: ExtensionContext, options?: { useExistingContext?: boolean; preflight?: ConvoPreflight }): void {
		state = {
			active: true,
			seed,
			useExistingContext: options?.useExistingContext === true,
			startedAt: Date.now(),
			answers: [],
			progressCurrent: undefined,
			progressTotal: undefined,
			questionnaireRetryCount: 0,
			preflight: options?.preflight,
		};
		persistState();
		updateUI(ctx);
		ctx.ui.notify("Convo mode active.", "info");
	}

	function installEditor(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new ConvoEditor(tui, theme, keybindings);
			editor.isConvoActive = () => state.active;
			editor.onExitConvo = () => exitConvo(ctx);
			return editor;
		});
	}

	pi.registerCommand("convo", {
		description: "Start a collaborative requirements conversation",
		handler: async (args, ctx) => {
			const idea = args.trim();
			if (!idea && state.active) {
				ctx.ui.notify(
					state.useExistingContext ? `Convo mode active: ${state.preflight?.displaySeed || state.seed}` : `Convo mode active: ${state.seed}`,
					"info",
				);
				return;
			}

			const usingExistingContext = !idea;
			if (usingExistingContext && !hasMeaningfulSessionContext(ctx)) {
				ctx.ui.notify("Not enough existing context yet. Give /convo an idea first.", "warning");
				return;
			}

			const seed = usingExistingContext ? deriveSessionSeed(ctx) : idea;
			const preflight = await buildConvoPreflight(seed, ctx, { useExistingContext: usingExistingContext });
			enterConvo(seed, ctx, { useExistingContext: usingExistingContext, preflight });
			const prompt = usingExistingContext
				? "Let's work this out together before implementation using the existing session context so far. Use the preflight context you already have. If there still isn't enough context to proceed, say so plainly."
				: `Let's work this out together before implementation.\n\nIdea:\n${idea}\n\nUse the preflight context you already have before asking questions.`;
			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				ctx.ui.notify("Queued convo to start after the current work finishes.", "info");
			}
		},
	});

	pi.registerTool({
		name: "convo_questionnaire",
		label: "Convo Questionnaire",
		description:
			"Ask a batch of interactive multiple-choice clarification questions during /convo mode. Use this instead of plain chat questions. The UI asks one question at a time locally, supports extra context via Tab, and avoids LLM round-trips between questions.",
		promptSnippet: "Ask a local batch of clarification questions during /convo mode.",
		promptGuidelines: [
			"During /convo mode, ask clarifying questions with convo_questionnaire instead of plain text.",
			"Provide a batch of high-value questions so the user can answer locally without waiting between questions.",
			"Prefer the top 1-2 missing questions over a long generic list unless the context is still very unclear.",
			"For each question, provide three to five concrete options, and when showing directions keep them adaptive to the request.",
		],
		parameters: ConvoQuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = params as {
				questions: Array<{ id?: string; question: string; options: string[] }>;
				progressCurrent?: number;
				progressTotal?: number;
			};

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: convo_questionnaire requires interactive mode." }],
					details: { cancelled: true, exited: false, answers: state.answers } satisfies ConvoBatchResultDetails,
				};
			}

			const batch = Array.isArray(input.questions) ? input.questions : [];
			if (batch.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No questions provided." }],
					details: { cancelled: true, exited: false, answers: state.answers } satisfies ConvoBatchResultDetails,
				};
			}

			const history = state.answers.map((answer) => ({ ...answer, options: [...answer.options] }));
			const fallbackProgressCurrent = Math.max(1, history.length + 1);
			const baseProgress = Math.max(
				fallbackProgressCurrent,
				normalizeProgressValue(input.progressCurrent) ?? fallbackProgressCurrent,
			);
			const minimumTotalProgress = baseProgress + batch.length - 1;
			const totalProgress = Math.max(
				minimumTotalProgress,
				normalizeProgressValue(input.progressTotal) ?? Math.max(5, minimumTotalProgress),
			);

			const newPages: ConvoAnswer[] = batch.map((question, index) => {
				const options = normalizeOptions(question.options);
				return {
					id: question.id?.trim() || `convo-${history.length + index + 1}-${Date.now()}-${index}`,
					question: question.question.trim(),
					options,
					selectedIndex: 0,
					selectedLabel: options[0]!,
					note: "",
					progressCurrent: baseProgress + index,
					progressTotal: totalProgress,
				};
			});

			function setActiveBatchProgress(progress?: { current: number; total: number }): void {
				state = {
					...state,
					progressCurrent: progress?.current,
					progressTotal: progress?.total,
				};
				updateUI(ctx);
			}

			setActiveBatchProgress({ current: baseProgress, total: totalProgress });

			const result = await ctx.ui.custom<ConvoBatchResultDetails>((tui, theme, _kb, done) => {
				const pages: ConvoAnswer[] = [...history, ...newPages].map((answer) => ({ ...answer, options: [...answer.options] }));
				const firstNewIndex = history.length;
				let pageIndex = firstNewIndex;
				let activeProgressPageIndex = firstNewIndex;
				let optionIndex = clamp(pages[pageIndex]!.selectedIndex, 0, pages[pageIndex]!.options.length - 1);
				let noteMode = false;
				let cachedLines: string[] | undefined;

				function getDisplayProgress(): { current: number; total: number; reviewingHistory: boolean } {
					const reviewingHistory = pageIndex < firstNewIndex;
					const offset = activeProgressPageIndex - firstNewIndex;
					return {
						current: baseProgress + offset,
						total: totalProgress,
						reviewingHistory,
					};
				}

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (s) => theme.fg("accent", s),
						selectedText: (s) => theme.fg("accent", s),
						description: (s) => theme.fg("muted", s),
						scrollInfo: (s) => theme.fg("dim", s),
						noMatch: (s) => theme.fg("warning", s),
					},
				};
				const editor = new Editor(tui, editorTheme);
				editor.disableSubmit = true;
				editor.onChange = (text) => {
					pages[pageIndex]!.note = text;
					refresh();
				};

				function refresh(): void {
					cachedLines = undefined;
					tui.requestRender();
				}

				function currentPage(): ConvoAnswer {
					return pages[pageIndex]!;
				}

				function syncEditor(): void {
					editor.setText(currentPage().note);
					optionIndex = clamp(currentPage().selectedIndex, 0, currentPage().options.length - 1);
				}

				function saveSelection(): void {
					const page = currentPage();
					page.selectedIndex = optionIndex;
					page.selectedLabel = page.options[optionIndex]!;
					page.note = editor.getText();
				}

				function goToPage(nextIndex: number): void {
					const next = clamp(nextIndex, 0, pages.length - 1);
					if (next === pageIndex) return;
					saveSelection();
					pageIndex = next;
					if (pageIndex >= firstNewIndex) activeProgressPageIndex = pageIndex;
					noteMode = false;
					syncEditor();
					const progress = getDisplayProgress();
					setActiveBatchProgress({ current: progress.current, total: progress.total });
					refresh();
				}

				function nextQuestionOrDone(): void {
					saveSelection();
					if (pageIndex < pages.length - 1) {
						pageIndex += 1;
						if (pageIndex >= firstNewIndex) activeProgressPageIndex = pageIndex;
						noteMode = false;
						syncEditor();
						const progress = getDisplayProgress();
						setActiveBatchProgress({ current: progress.current, total: progress.total });
						refresh();
						return;
					}
					done({
						cancelled: false,
						exited: false,
						current: { ...currentPage() },
						answers: pages.map((page) => ({ ...page })),
					});
				}

				syncEditor();

				return {
					invalidate() {
						cachedLines = undefined;
					},

					handleInput(data: string) {
						if (matchesKey(data, "ctrl+c")) {
							done({ cancelled: true, exited: true, answers: state.answers });
							return;
						}

						if (noteMode) {
							if (matchesKey(data, "escape")) {
								saveSelection();
								noteMode = false;
								refresh();
								return;
							}
							if (matchesKey(data, "enter")) {
								nextQuestionOrDone();
								return;
							}
							editor.handleInput(data);
							currentPage().note = editor.getText();
							refresh();
							return;
						}

						if (matchesKey(data, "left")) {
							goToPage(pageIndex - 1);
							return;
						}
						if (matchesKey(data, "right")) {
							goToPage(pageIndex + 1);
							return;
						}
						if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
							optionIndex = clamp(optionIndex - 1, 0, currentPage().options.length - 1);
							refresh();
							return;
						}
						if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
							optionIndex = clamp(optionIndex + 1, 0, currentPage().options.length - 1);
							refresh();
							return;
						}
						if (matchesKey(data, "tab")) {
							saveSelection();
							noteMode = true;
							syncEditor();
							refresh();
							return;
						}
						if (matchesKey(data, "enter")) {
							nextQuestionOrDone();
						}
					},

					render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const page = currentPage();
						const progress = getDisplayProgress();
						const lines: string[] = [];
						const add = (line: string) => lines.push(truncateToWidth(line, width));

						add(theme.fg("accent", "─".repeat(width)));
						add(theme.fg("accent", ` Question ${progress.current}/${progress.total}`));
						if (pages.length > 1) {
							const reviewLabel = progress.reviewingHistory
								? ` Reviewing earlier answer ${pageIndex + 1}/${pages.length} • ← previous • → next`
								: ` Review ${pageIndex + 1}/${pages.length} • ← previous • → next`;
							add(theme.fg("dim", reviewLabel));
						}
						lines.push("");
						add(theme.fg("text", ` ${page.question}`));
						lines.push("");

						for (let i = 0; i < page.options.length; i++) {
							const isCursor = i === optionIndex;
							const isSaved = i === page.selectedIndex;
							const prefix = isCursor ? theme.fg("accent", "> ") : "  ";
							const bullet = isSaved ? theme.fg("success", "●") : theme.fg("dim", "○");
							const text = `${i + 1}. ${page.options[i]}`;
							add(`${prefix}${bullet} ${isCursor ? theme.fg("accent", text) : theme.fg("text", text)}`);
						}

						lines.push("");
						add(noteMode ? theme.fg("accent", " Additional context") : theme.fg("muted", " Additional context (Tab to edit)"));
						if (noteMode) {
							for (const line of editor.render(Math.max(10, width - 2))) {
								add(` ${line}`);
							}
						} else if (page.note.trim()) {
							for (const line of page.note.split("\n")) {
								add(` ${theme.fg("text", line || " ")}`);
							}
						} else {
							add(theme.fg("dim", "   No extra context"));
						}

						lines.push("");
						add(theme.fg("dim", " ↑↓ or Ctrl+P/Ctrl+N choose • Tab context • Enter next • Esc leave note • Ctrl+C exit"));
						add(theme.fg("accent", "─".repeat(width)));

						cachedLines = lines;
						return lines;
					},
				};
			});

			if (result.exited) {
				exitConvo(ctx, "Exited convo mode.");
				return {
					content: [{ type: "text", text: "User exited convo mode. Stop asking clarification questions." }],
					details: result,
				};
			}

			const answers = result.answers.map((answer) => sanitizeAnswer(answer));
			const current = result.current ? sanitizeAnswer(result.current) : answers[answers.length - 1];
			state = {
				...state,
				answers,
				progressCurrent: undefined,
				progressTotal: undefined,
				questionnaireRetryCount: 0,
			};
			persistState();
			updateUI(ctx);

			return {
				content: [{ type: "text", text: buildToolContent(answers) }],
				details: {
					cancelled: false,
					exited: false,
					answers,
					current,
				} satisfies ConvoBatchResultDetails,
			};
		},

		renderCall(args, theme) {
			const input = args as {
				questions?: Array<{ question?: string }>;
				progressCurrent?: number;
				progressTotal?: number;
			};
			const questions = Array.isArray(input.questions) ? input.questions : [];
			const fallbackProgressCurrent = Math.max(1, state.answers.length + 1);
			const progressCurrent = Math.max(
				fallbackProgressCurrent,
				normalizeProgressValue(input.progressCurrent) ?? fallbackProgressCurrent,
			);
			const progressEnd = progressCurrent + Math.max(0, questions.length - 1);
			const minimumProgressTotal = Math.max(progressCurrent, progressEnd);
			const progressTotal = normalizeProgressValue(input.progressTotal);
			const resolvedProgressTotal = progressTotal ? Math.max(minimumProgressTotal, progressTotal) : undefined;
			const progressLabel = resolvedProgressTotal
				? questions.length > 1
					? `${progressCurrent}-${progressEnd}/${resolvedProgressTotal}`
					: `${progressCurrent}/${resolvedProgressTotal}`
				: "";
			const label = questions.length === 1 ? questions[0]?.question || "Question" : `${questions.length} questions`;
			return new Text(
				theme.fg("toolTitle", theme.bold("convo_questionnaire ")) +
					(progressLabel ? theme.fg("accent", `${progressLabel} `) : "") +
					theme.fg("muted", label),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as ConvoBatchResultDetails | undefined;
			if (!details) return new Text("", 0, 0);
			if (details.exited) return new Text(theme.fg("warning", "Exited convo mode"), 0, 0);
			const current = details.current;
			if (!current) return new Text(theme.fg("warning", "No answers recorded"), 0, 0);
			let text = theme.fg("success", "✓ ") + theme.fg("accent", current.selectedLabel);
			if (current.note.trim()) text += `\n${theme.fg("muted", current.note.trim())}`;
			return new Text(text, 0, 0);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		installEditor(ctx);
		restoreState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		installEditor(ctx);
		restoreState(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		installEditor(ctx);
		restoreState(ctx);
	});

	pi.on("agent_start", async () => {
		usedQuestionnaireThisAgentRun = false;
	});

	pi.on("tool_execution_end", async (event) => {
		if (!state.active || event.isError) return;
		if (event.toolName === "convo_questionnaire") usedQuestionnaireThisAgentRun = true;
	});

	pi.on("input", async (event, ctx) => {
		if (!state.active || event.source === "extension") return { action: "continue" as const };
		if ((state.questionnaireRetryCount ?? 0) !== 0) {
			state = { ...state, questionnaireRetryCount: 0 };
			persistState();
		}
		if (looksLikeImplementationIntent(event.text.trim())) exitConvo(ctx, "Exited convo mode. Moving on from discovery.");
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.active) return;

		const seedContext = state.useExistingContext
			? "Use the existing session context so far. If that context is still insufficient, say so plainly instead of guessing."
			: `Seed idea:\n${state.seed}`;
		const preflightContext = state.preflight?.summary ? `\n\n${state.preflight.summary}` : "";
		const recommendedOpen = state.preflight ? getFirstStepDescription(state.preflight.firstStep) : "Start by presenting your inferred understanding before asking questions.";

		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n[CONVO MODE]\nYou are in collaborative requirements-discovery mode.\n\n${seedContext}${preflightContext}\n\nRules:\n- Work out the idea with the user before implementation.\n- Use the preflight context above before asking questions. Do not ignore it and do not begin with generic discovery questions when the preflight already narrows the task.\n- Ask follow-up questions with the convo_questionnaire tool, not with plain chat text.\n- Use the tool to ask a local batch of high-value questions so the user does not wait on an LLM round-trip between each answer.\n- Each question in the batch should have three to five concrete options.\n- The tool result includes the complete structured answer history; use it instead of re-asking answered questions.\n- Ask as many questions as needed to make the project concrete, but prefer fewer, better batches.\n- Prefer the top 1-2 highest-value missing questions over a long generic list.\n- If you present likely directions, make them adaptive to the request and include a clear 'None of these / something else' escape hatch.\n- Recommended opening move for this convo: ${recommendedOpen}\n- If confidence is high and the request is explicit with strong repo evidence, you may skip questions and move straight to a concrete summary/plan.\n- Periodically summarize your current understanding in plain language.\n- Do not start coding, editing files, or writing implementation output unless the user clearly wants to move beyond discovery.\n- Once the work is clear enough, stop asking questions and produce a concise summary with: Goal, Requirements, Constraints, Assumptions, Implementation plan, and Open questions.\n- Do not finish with unresolved items under Open questions. Either resolve them via reasonable assumptions and document those assumptions, or ask another batch of clarification questions.\n- Only mark the convo complete when Open questions is explicitly None, N/A, or no open questions.\n- When you reach that point, include the exact line ${COMPLETE_MARKER} at the very end of the response.`,
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!state.active) return;
		const text = getLastAssistantText(event.messages as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>);
		if (!text) return;

		if (state.useExistingContext && state.answers.length === 0 && looksInsufficientContext(text)) {
			exitConvo(ctx, "Not enough context for /convo yet. Give it an idea first.");
			return;
		}

		if (hasSummaryShape(text) && hasUnresolvedOpenQuestions(text)) {
			state = { ...state, questionnaireRetryCount: 0 };
			persistState();
			if (ctx.hasUI) ctx.ui.notify("Convo summary still has open questions. Continuing refinement.", "info");
			pi.sendUserMessage(
				"Your last summary still listed unresolved open questions. Convo is not complete until Open questions is None. Ask the next batch of highest-value clarification questions using convo_questionnaire, or resolve the gaps with reasonable assumptions and update the summary.",
				{ deliverAs: "followUp" },
			);
			return;
		}

		if (!usedQuestionnaireThisAgentRun && looksLikeClarificationRequest(text)) {
			const retryCount = state.questionnaireRetryCount ?? 0;
			if (retryCount >= 1) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"Convo still needs clarification, but no questionnaire was produced. Add more context or rerun /convo.",
						"warning",
					);
				}
				return;
			}

			state = { ...state, questionnaireRetryCount: retryCount + 1 };
			persistState();
			if (ctx.hasUI) ctx.ui.notify("Convo needs clarification. Requesting a questionnaire.", "info");
			pi.sendUserMessage(
				"You still need more information. Do not stop with prose or plain chat questions. Call convo_questionnaire now with the next batch of highest-value clarification questions.",
				{ deliverAs: "followUp" },
			);
			return;
		}

		if ((state.questionnaireRetryCount ?? 0) !== 0) {
			state = { ...state, questionnaireRetryCount: 0 };
			persistState();
		}

		if (!looksComplete(text)) return;

		if (!ctx.hasUI) {
			exitConvo(ctx, "Convo mode complete.");
			return;
		}

		const choice = await ctx.ui.select("Convo complete — what next?", [
			"Start implementing",
			"Keep refining",
			"Cancel",
		]);

		if (choice === "Start implementing") {
			exitConvo(ctx, "Exited convo mode. Starting implementation.");
			pi.sendUserMessage("Start implementing based on the agreed summary and implementation plan.");
			return;
		}

		if (choice === "Keep refining") {
			pi.sendUserMessage("Keep refining this. Ask the next batch of highest-value clarification questions using convo_questionnaire.");
			return;
		}

		exitConvo(ctx, "Exited convo mode.");
	});
}
