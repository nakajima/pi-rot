import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	truncateLine,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PYTHON_PARSER_PATH = join(EXTENSION_DIR, "html_extract.py");
const CACHE_ROOT = join(homedir(), ".pi", "agent", "cache", "web-docs");
const SEARCH_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const PAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const HTTP_USER_AGENT = "pirot-web-docs/0.1 (+https://pi.dev)";
const SEARCH_RESULT_LIMIT = 8;
const SEARCH_FETCH_LIMIT = 12;
const SEARCH_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 25_000;
const MAX_MANIFEST_FILES = 24;
const MAX_SCANNED_DIRS = 200;
const MAX_REPO_SIGNALS = 80;
const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"target",
	"coverage",
	".next",
	".turbo",
	".idea",
	".vscode",
	"tmp",
	"temp",
	"out",
]);

export interface RepoSignal {
	name: string;
	version?: string;
	ecosystem: "node" | "rust" | "go" | "python" | "unknown";
	manifestPath: string;
	manifestType: string;
	source: "dependency" | "project";
}

export interface RepoContext {
	signals: RepoSignal[];
	manifestPaths: string[];
	languages: string[];
	preferredSignal?: RepoSignal;
}

export interface SearchResultItem {
	id: string;
	title: string;
	url: string;
	host: string;
	snippet: string;
	sourceKind: string;
	score: number;
	reasons: string[];
	searchQuery: string;
	provenance: SearchResultProvenance[];
}

interface SearchProviderResult {
	title: string;
	url: string;
	snippet: string;
}

interface CachedSearchResult {
	provider: string;
	query: string;
	createdAt: string;
	results: SearchProviderResult[];
}

interface ParsedSection {
	heading: string;
	level: number;
	id?: string;
	content: string;
	codeBlocks: string[];
}

export interface ParsedPage {
	sourceUrl: string;
	finalUrl: string;
	title: string;
	description: string;
	markdown: string;
	text: string;
	sections: ParsedSection[];
	contentType: string;
	fetchedAt: string;
	cacheJsonPath: string;
	cacheMarkdownPath: string;
	cacheTextPath: string;
	parser: "python-html" | "regex-html" | "text";
	status: number;
}

interface CachedParsedPage {
	sourceUrl: string;
	finalUrl: string;
	title: string;
	description: string;
	markdown: string;
	text: string;
	sections: ParsedSection[];
	contentType: string;
	fetchedAt: string;
	parser: "python-html" | "regex-html" | "text";
	status: number;
}

interface PythonParsedPage {
	title?: string;
	description?: string;
	markdown?: string;
	text?: string;
	sections?: Array<{
		heading?: string;
		level?: number;
		id?: string;
		content?: string;
		codeBlocks?: string[];
	}>;
}

interface FetchOutput {
	text: string;
	details: Record<string, unknown>;
}

export interface FetchUrlInput {
	url: string;
	format?: string;
	selector?: string;
}

export interface DocsLookupInput {
	query: string;
	package?: string;
	version?: string;
	language?: string;
	preferredDomains?: string[];
	allowedDomains?: string[];
	blockedDomains?: string[];
}

export interface DocsReadSectionInput {
	docIdOrUrl: string;
	heading?: string;
}

export type SearchPlanIntent =
	| "broad"
	| "official-docs"
	| "reference"
	| "language-context"
	| "troubleshooting"
	| "tutorial"
	| "domain-focus";

export interface SearchPlan {
	id: string;
	label: string;
	intent: SearchPlanIntent;
	query: string;
	preferredDomains: string[];
	allowedDomains: string[];
	blockedDomains: string[];
	derivedFrom?: string[];
}

export interface SearchResultProvenance {
	planId: string;
	label: string;
	intent: SearchPlanIntent;
	query: string;
	provider: string;
	rank: number;
}

interface SearchProvider {
	name: string;
	search(query: string, signal?: AbortSignal): Promise<SearchProviderResult[]>;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function normalizeMultilineWhitespace(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/\u00a0/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function truncateText(value: string, maxLength: number): string {
	const normalized = normalizeWhitespace(value);
	return normalized.length > maxLength ? `${normalized.slice(0, Math.max(1, maxLength - 3))}...` : normalized;
}

function cleanToolUrl(url: string): string {
	const trimmed = url.trim();
	return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

export function normalizeFetchFormat(format?: string): "markdown" | "text" | "outline" {
	const normalized = (format ?? "markdown").trim().toLowerCase();
	if (normalized === "text" || normalized === "outline") return normalized;
	return "markdown";
}

function canonicalizeUrl(url: string): string {
	const parsed = new URL(cleanToolUrl(url));
	parsed.hash = "";
	if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
		parsed.port = "";
	}
	if (parsed.pathname.endsWith("/") && parsed.pathname !== "/") {
		parsed.pathname = parsed.pathname.replace(/\/+$/, "");
	}
	return parsed.toString();
}

function normalizeDomain(value: string | undefined): string | undefined {
	const trimmed = normalizeWhitespace(value ?? "");
	if (!trimmed) return undefined;
	try {
		const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
		return parsed.hostname.toLowerCase().replace(/^\.+|\.+$/g, "");
	} catch {
		return trimmed.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\.+|\.+$/g, "") || undefined;
	}
}

function normalizeDomains(values: string[] | undefined): string[] {
	return uniqueStrings((values ?? []).map((value) => normalizeDomain(value) ?? "")).filter(Boolean);
}

function hostFromUrl(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

function domainMatches(host: string, domain: string): boolean {
	const normalizedHost = host.toLowerCase();
	const normalizedDomain = domain.toLowerCase();
	return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function isBlockedDomain(host: string, blockedDomains: string[]): boolean {
	return blockedDomains.some((domain) => domainMatches(host, domain));
}

function isAllowedDomain(host: string, allowedDomains: string[]): boolean {
	if (allowedDomains.length === 0) return true;
	return allowedDomains.some((domain) => domainMatches(host, domain));
}

function sectionToken(value: string | undefined): string {
	return normalizeWhitespace(value ?? "")
		.toLowerCase()
		.replace(/^#/, "")
		.replace(/&[a-z0-9#]+;/g, " ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&#(\d+);/g, (_match, number) => String.fromCodePoint(Number(number)))
		.replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ");
}

function stripTags(value: string): string {
	return normalizeWhitespace(decodeHtmlEntities(value.replace(/<[^>]+>/g, " ")));
}

function tokenize(value: string): string[] {
	return [...new Set((value.toLowerCase().match(/[a-z0-9][a-z0-9._/-]*/g) ?? []).filter((token) => token.length >= 2))];
}

function tokensWithoutVersionNoise(value: string): string[] {
	return tokenize(value).filter((token) => !/^v?\d+(?:\.\d+){0,3}$/.test(token));
}

function overlapScore(target: string, tokens: string[], weight: number): number {
	if (tokens.length === 0) return 0;
	const lower = target.toLowerCase();
	let score = 0;
	for (const token of tokens) {
		if (lower.includes(token)) score += weight;
	}
	return score;
}

function basenameWithoutScope(name: string): string {
	const trimmed = name.trim();
	if (trimmed.startsWith("@")) {
		const parts = trimmed.split("/");
		return parts[parts.length - 1] ?? trimmed;
	}
	return trimmed;
}

function extractMajorVersion(version?: string): string | undefined {
	if (!version) return undefined;
	const match = version.match(/(\d{1,3})(?:\.\d+){0,2}/);
	return match ? match[1] : undefined;
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const normalized = value.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

async function readJsonIfFresh<T>(path: string, maxAgeMs: number): Promise<T | undefined> {
	try {
		const fileStat = await stat(path);
		if (Date.now() - fileStat.mtimeMs > maxAgeMs) return undefined;
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

async function writeTextAtomically(path: string, content: string): Promise<void> {
	await ensureDir(dirname(path));
	await withFileMutationQueue(path, async () => {
		await writeFile(path, content, "utf8");
	});
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
	await writeTextAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

function cacheBasePath(kind: "search" | "page", key: string): string {
	const hash = sha256(key);
	return join(CACHE_ROOT, kind, hash);
}

function pageJsonPath(url: string): string {
	return `${cacheBasePath("page", canonicalizeUrl(url))}.json`;
}

function pageMarkdownPath(url: string): string {
	return `${cacheBasePath("page", canonicalizeUrl(url))}.md`;
}

function pageTextPath(url: string): string {
	return `${cacheBasePath("page", canonicalizeUrl(url))}.txt`;
}

function searchJsonPath(provider: string, query: string): string {
	return `${cacheBasePath("search", `${provider}\n${query}`)}.json`;
}

function looksLikeHtml(contentType: string, url: string): boolean {
	const normalizedType = contentType.toLowerCase();
	if (normalizedType.includes("text/html") || normalizedType.includes("application/xhtml+xml")) return true;
	const extension = extname(new URL(url).pathname).toLowerCase();
	return extension === ".html" || extension === ".htm" || extension === "";
}

function looksLikeMarkdown(contentType: string, url: string): boolean {
	const normalizedType = contentType.toLowerCase();
	if (normalizedType.includes("text/markdown") || normalizedType.includes("text/plain")) return true;
	const extension = extname(new URL(url).pathname).toLowerCase();
	return extension === ".md" || extension === ".mdx" || extension === ".markdown" || extension === ".txt";
}

function toAbsoluteUrl(baseUrl: string, href: string): string | undefined {
	try {
		return new URL(href, baseUrl).toString();
	} catch {
		return undefined;
	}
}

function rewriteGithubBlobUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "github.com") return url;
		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length < 5 || parts[2] !== "blob") return url;
		const owner = parts[0]!;
		const repo = parts[1]!;
		const branch = parts[3]!;
		const remainder = parts.slice(4).join("/");
		const extension = extname(remainder).toLowerCase();
		if (![".md", ".mdx", ".markdown", ".txt", ".rst"].includes(extension)) return url;
		return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${remainder}`;
	} catch {
		return url;
	}
}

function plainTextPage(url: string, text: string, contentType: string, status: number): CachedParsedPage {
	const normalized = normalizeMultilineWhitespace(text);
	return {
		sourceUrl: url,
		finalUrl: url,
		title: truncateText(normalized.split(/\n+/)[0] ?? url, 120) || url,
		description: "",
		markdown: normalized,
		text: normalized,
		sections: [],
		contentType,
		fetchedAt: new Date().toISOString(),
		parser: "text",
		status,
	};
}

function renderSectionsToMarkdown(title: string, description: string, sections: ParsedSection[]): string {
	const lines: string[] = [];
	if (title) lines.push(`# ${title}`, "");
	if (description) lines.push(description, "");
	for (const section of sections) {
		if (section.level > 0 && section.heading) {
			lines.push(`${"#".repeat(Math.max(2, Math.min(6, section.level + 1)))} ${section.heading}`, "");
		}
		if (section.content) {
			lines.push(section.content.trim(), "");
		}
	}
	return normalizeMultilineWhitespace(lines.join("\n"));
}

function extractTitleFromHtml(html: string, fallbackUrl: string): string {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!titleMatch) return fallbackUrl;
	return truncateText(stripTags(titleMatch[1] ?? fallbackUrl), 160) || fallbackUrl;
}

function extractDescriptionFromHtml(html: string): string {
	const metaMatch = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i);
	return metaMatch ? truncateText(decodeHtmlEntities(metaMatch[1] ?? ""), 240) : "";
}

function parseHtmlWithRegex(html: string, finalUrl: string): PythonParsedPage {
	const sanitized = html
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");

	const headingRegex = /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi;
	const headings: Array<{ level: number; heading: string; id?: string; index: number; length: number }> = [];
	let headingMatch: RegExpExecArray | null = null;
	while ((headingMatch = headingRegex.exec(sanitized)) !== null) {
		const level = Number(headingMatch[1] ?? 0);
		const attrs = headingMatch[2] ?? "";
		const rawHeading = stripTags(headingMatch[3] ?? "");
		if (!rawHeading) continue;
		const idMatch = attrs.match(/\sid=["']([^"']+)["']/i);
		headings.push({
			level,
			heading: rawHeading,
			id: idMatch?.[1],
			index: headingMatch.index,
			length: headingMatch[0].length,
		});
	}

	const sections: ParsedSection[] = [];
	if (headings.length === 0) {
		const text = normalizeMultilineWhitespace(stripTags(sanitized));
		if (text) {
			sections.push({ heading: "Page", level: 1, content: text, codeBlocks: [] });
		}
	} else {
		for (let i = 0; i < headings.length; i++) {
			const current = headings[i]!;
			const start = current.index + current.length;
			const end = headings[i + 1]?.index ?? sanitized.length;
			const slice = sanitized.slice(start, end);
			const codeBlocks = [...slice.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map((match) => normalizeMultilineWhitespace(stripTags(match[1] ?? ""))).filter(Boolean);
			const content = normalizeMultilineWhitespace(
				slice
					.replace(/<pre[^>]*>[\s\S]*?<\/pre>/gi, "\n")
					.replace(/<code[^>]*>[\s\S]*?<\/code>/gi, " ")
					.replace(/<li[^>]*>/gi, "\n- ")
					.replace(/<br\s*\/?>/gi, "\n")
					.replace(/<\/(p|div|section|article|ul|ol|table|tr|blockquote)>/gi, "\n\n")
					.replace(/<[^>]+>/g, " "),
			);
			const parts: string[] = [];
			if (content) parts.push(content);
			for (const block of codeBlocks.slice(0, 4)) {
				parts.push(`\`\`\`\n${block}\n\`\`\``);
			}
			sections.push({
				heading: current.heading,
				level: current.level,
				id: current.id,
				content: normalizeMultilineWhitespace(parts.join("\n\n")),
				codeBlocks,
			});
		}
	}

	const title = extractTitleFromHtml(html, finalUrl);
	const description = extractDescriptionFromHtml(html);
	return {
		title,
		description,
		sections,
		markdown: renderSectionsToMarkdown(title, description, sections),
		text: normalizeMultilineWhitespace(stripTags(sanitized)),
	};
}

async function runPythonHtmlParser(html: string, finalUrl: string, signal?: AbortSignal): Promise<PythonParsedPage | undefined> {
	return new Promise((resolveResult) => {
		const proc = spawn("python3", [PYTHON_PARSER_PATH, "--url", finalUrl], {
			stdio: ["pipe", "pipe", "pipe"],
			signal,
		});

		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (data: Buffer) => {
			stdout += data.toString("utf8");
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString("utf8");
		});
		proc.on("error", () => resolveResult(undefined));
		proc.on("close", (code) => {
			if (code !== 0) {
				resolveResult(undefined);
				return;
			}
			try {
				resolveResult(JSON.parse(stdout) as PythonParsedPage);
			} catch {
				if (stderr.trim()) {
					resolveResult(undefined);
					return;
				}
				resolveResult(undefined);
			}
		});
		proc.stdin.end(html);
	});
}

function normalizeParsedSections(input: PythonParsedPage["sections"]): ParsedSection[] {
	const sections = Array.isArray(input) ? input : [];
	return sections
		.map((section) => ({
			heading: truncateText(normalizeWhitespace(section?.heading ?? ""), 200),
			level: typeof section?.level === "number" && Number.isFinite(section.level) ? Math.max(0, Math.min(6, Math.floor(section.level))) : 0,
			id: section?.id ? truncateText(section.id, 160) : undefined,
			content: normalizeMultilineWhitespace(section?.content ?? ""),
			codeBlocks: Array.isArray(section?.codeBlocks)
				? section.codeBlocks.map((block) => normalizeMultilineWhitespace(block)).filter((block) => block.length > 0).slice(0, 8)
				: [],
		}))
		.filter((section) => section.heading || section.content || section.codeBlocks.length > 0);
}

async function parseFetchedHtml(html: string, finalUrl: string, signal?: AbortSignal): Promise<Omit<CachedParsedPage, "sourceUrl" | "finalUrl" | "contentType" | "fetchedAt" | "status">> {
	const pythonParsed = await runPythonHtmlParser(html, finalUrl, signal);
	const normalizedPythonSections = normalizeParsedSections(pythonParsed?.sections);
	if (pythonParsed && (normalizedPythonSections.length > 0 || pythonParsed.markdown || pythonParsed.text)) {
		const title = truncateText(normalizeWhitespace(pythonParsed.title ?? extractTitleFromHtml(html, finalUrl)), 200) || finalUrl;
		const description = truncateText(normalizeWhitespace(pythonParsed.description ?? extractDescriptionFromHtml(html)), 240);
		const markdown = normalizeMultilineWhitespace(
			pythonParsed.markdown && pythonParsed.markdown.trim().length > 0
				? pythonParsed.markdown
				: renderSectionsToMarkdown(title, description, normalizedPythonSections),
		);
		const text = normalizeMultilineWhitespace(
			pythonParsed.text && pythonParsed.text.trim().length > 0
				? pythonParsed.text
				: normalizedPythonSections.map((section) => [section.heading, section.content].filter(Boolean).join("\n")).join("\n\n"),
		);
		return {
			title,
			description,
			markdown,
			text,
			sections: normalizedPythonSections,
			parser: "python-html",
		};
	}

	const fallback = parseHtmlWithRegex(html, finalUrl);
	return {
		title: truncateText(normalizeWhitespace(fallback.title ?? finalUrl), 200) || finalUrl,
		description: truncateText(normalizeWhitespace(fallback.description ?? ""), 240),
		markdown: normalizeMultilineWhitespace(fallback.markdown ?? ""),
		text: normalizeMultilineWhitespace(fallback.text ?? ""),
		sections: normalizeParsedSections(fallback.sections),
		parser: "regex-html",
	};
}

async function fetchWithTimeout(url: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const combined = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	const abort = () => combined.abort();
	controller.signal.addEventListener("abort", abort);
	if (signal) signal.addEventListener("abort", abort);
	if (controller.signal.aborted || signal?.aborted) combined.abort();

	try {
		return await fetch(url, {
			redirect: "follow",
			headers: {
				"User-Agent": HTTP_USER_AGENT,
				Accept: "text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,*/*;q=0.5",
			},
			signal: combined.signal,
		});
	} finally {
		clearTimeout(timeout);
		controller.signal.removeEventListener("abort", abort);
		if (signal) signal.removeEventListener("abort", abort);
	}
}

export async function fetchPage(url: string, signal?: AbortSignal): Promise<ParsedPage> {
	const normalizedSourceUrl = rewriteGithubBlobUrl(canonicalizeUrl(url));
	const jsonPath = pageJsonPath(normalizedSourceUrl);
	const cached = await readJsonIfFresh<CachedParsedPage>(jsonPath, PAGE_CACHE_TTL_MS);
	if (cached) {
		return {
			...cached,
			cacheJsonPath: jsonPath,
			cacheMarkdownPath: pageMarkdownPath(normalizedSourceUrl),
			cacheTextPath: pageTextPath(normalizedSourceUrl),
		};
	}

	const response = await fetchWithTimeout(normalizedSourceUrl, signal, PAGE_TIMEOUT_MS);
	const finalUrl = rewriteGithubBlobUrl(response.url || normalizedSourceUrl);
	const contentType = response.headers.get("content-type") ?? "";
	const rawText = await response.text();

	let parsed: CachedParsedPage;
	if (looksLikeHtml(contentType, finalUrl)) {
		const htmlParsed = await parseFetchedHtml(rawText, finalUrl, signal);
		parsed = {
			sourceUrl: normalizedSourceUrl,
			finalUrl,
			contentType,
			fetchedAt: new Date().toISOString(),
			status: response.status,
			...htmlParsed,
		};
	} else if (looksLikeMarkdown(contentType, finalUrl)) {
		parsed = {
			...plainTextPage(finalUrl, rawText, contentType, response.status),
			sourceUrl: normalizedSourceUrl,
			finalUrl,
		};
	} else {
		const normalized = normalizeMultilineWhitespace(rawText);
		parsed = {
			sourceUrl: normalizedSourceUrl,
			finalUrl,
			title: extractTitleFromHtml(rawText, finalUrl),
			description: extractDescriptionFromHtml(rawText),
			markdown: normalized,
			text: normalized,
			sections: [],
			contentType,
			fetchedAt: new Date().toISOString(),
			parser: "text",
			status: response.status,
		};
	}

	const markdownPath = pageMarkdownPath(normalizedSourceUrl);
	const textPath = pageTextPath(normalizedSourceUrl);
	await Promise.all([
		writeJsonAtomically(jsonPath, parsed),
		writeTextAtomically(markdownPath, parsed.markdown),
		writeTextAtomically(textPath, parsed.text),
	]);

	return {
		...parsed,
		cacheJsonPath: jsonPath,
		cacheMarkdownPath: markdownPath,
		cacheTextPath: textPath,
	};
}

function buildOutline(page: ParsedPage): string {
	const lines: string[] = [];
	if (page.title) lines.push(`# ${page.title}`, "");
	lines.push(`URL: ${page.finalUrl}`);
	if (page.description) lines.push(`Description: ${page.description}`);
	lines.push("");
	if (page.sections.length === 0) {
		lines.push("No headings were extracted for this page.");
		return lines.join("\n");
	}
	lines.push("Headings:");
	for (const section of page.sections.slice(0, 80)) {
		const indent = "  ".repeat(Math.max(0, section.level - 1));
		const suffix = section.id ? ` (#${section.id})` : "";
		lines.push(`${indent}- ${section.heading || "Untitled section"}${suffix}`);
	}
	return lines.join("\n");
}

function formatSelectedSection(page: ParsedPage, section: ParsedSection, headingSource: string): string {
	const lines: string[] = [];
	if (page.title) lines.push(`# ${page.title}`, "");
	lines.push(`URL: ${page.finalUrl}`);
	lines.push(`Section: ${section.heading || "Untitled section"}`);
	lines.push(`Matched by: ${headingSource}`);
	if (page.description) lines.push(`Description: ${page.description}`);
	lines.push("");
	if (section.content) {
		lines.push(section.content);
	} else if (section.codeBlocks.length > 0) {
		for (const codeBlock of section.codeBlocks) {
			lines.push(`\`\`\`\n${codeBlock}\n\`\`\``, "");
		}
	} else {
		lines.push("This section was found, but it had very little extracted body content.");
	}
	return normalizeMultilineWhitespace(lines.join("\n"));
}

function formatPage(page: ParsedPage, format: "markdown" | "text" | "outline"): string {
	if (format === "outline") return buildOutline(page);
	if (format === "text") {
		const lines: string[] = [];
		if (page.title) lines.push(page.title, "");
		lines.push(`URL: ${page.finalUrl}`);
		if (page.description) lines.push(`Description: ${page.description}`);
		lines.push("");
		lines.push(page.text || page.markdown || "No readable text extracted.");
		return normalizeMultilineWhitespace(lines.join("\n"));
	}
	const lines: string[] = [];
	if (page.title) lines.push(`# ${page.title}`, "");
	lines.push(`URL: ${page.finalUrl}`);
	if (page.description) lines.push(`Description: ${page.description}`);
	lines.push("");
	lines.push(page.markdown || page.text || "No readable content extracted.");
	return normalizeMultilineWhitespace(lines.join("\n"));
}

function scoreSection(section: ParsedSection, selector: string): number {
	const normalizedSelector = sectionToken(selector);
	if (!normalizedSelector) return 0;
	const headingToken = sectionToken(section.heading);
	const idToken = sectionToken(section.id);
	let score = 0;
	if (headingToken === normalizedSelector) score += 100;
	if (idToken === normalizedSelector) score += 120;
	if (headingToken.includes(normalizedSelector) || normalizedSelector.includes(headingToken)) score += 45;
	if (idToken.includes(normalizedSelector) || normalizedSelector.includes(idToken)) score += 45;
	const selectorTerms = tokensWithoutVersionNoise(normalizedSelector.replace(/-/g, " "));
	if (selectorTerms.length > 0) {
		score += overlapScore(`${section.heading} ${section.content.slice(0, 400)}`, selectorTerms, 8);
	}
	return score;
}

function selectSection(page: ParsedPage, selector?: string): { section?: ParsedSection; reason?: string } {
	const fragmentSelector = (() => {
		try {
			const url = new URL(page.finalUrl);
			return url.hash ? url.hash.slice(1) : undefined;
		} catch {
			return undefined;
		}
	})();
	const effectiveSelector = normalizeWhitespace(selector ?? fragmentSelector ?? "");
	if (!effectiveSelector || page.sections.length === 0) return {};

	let best: { section: ParsedSection; score: number } | undefined;
	for (const section of page.sections) {
		const score = scoreSection(section, effectiveSelector);
		if (score <= 0) continue;
		if (!best || score > best.score) best = { section, score };
	}
	if (!best) return {};
	const normalizedSelector = sectionToken(effectiveSelector);
	const matchedBy = sectionToken(best.section.id) === normalizedSelector ? `section id #${best.section.id}` : `heading match ${JSON.stringify(best.section.heading)}`;
	return { section: best.section, reason: matchedBy };
}

function formatTruncationNotice(
	text: string,
	fullPath: string,
): { text: string; truncated: boolean } {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return { text: truncation.content, truncated: false };
	const notice = `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full extracted content saved to: ${fullPath}]`;
	return { text: `${truncation.content}${notice}`, truncated: true };
}

async function buildFetchOutput(page: ParsedPage, format: "markdown" | "text" | "outline", selector?: string): Promise<FetchOutput> {
	const selected = selectSection(page, selector);
	const text = selected.section ? formatSelectedSection(page, selected.section, selected.reason ?? "selector") : formatPage(page, format);
	const fullPath = format === "text" ? page.cacheTextPath : page.cacheMarkdownPath;
	const truncated = formatTruncationNotice(text, fullPath);
	return {
		text: truncated.text,
		details: {
			url: page.finalUrl,
			title: page.title,
			description: page.description,
			format,
			selector: selector?.trim() || undefined,
			consultedSource: {
				title: page.title,
				url: page.finalUrl,
				host: hostFromUrl(page.finalUrl),
			},
			citation: selected.section
				? {
					title: page.title,
					url: page.finalUrl,
					fragmentUrl: selected.section.id ? `${page.finalUrl}#${selected.section.id}` : page.finalUrl,
					sectionHeading: selected.section.heading,
					sectionId: selected.section.id,
				}
				: undefined,
			selectedSection: selected.section
				? {
					heading: selected.section.heading,
					id: selected.section.id,
					reason: selected.reason,
				}
				: undefined,
			sectionCount: page.sections.length,
			contentType: page.contentType,
			parser: page.parser,
			status: page.status,
			cacheJsonPath: page.cacheJsonPath,
			cacheMarkdownPath: page.cacheMarkdownPath,
			cacheTextPath: page.cacheTextPath,
			truncated: truncated.truncated,
		},
	};
}

export async function fetchUrl(input: FetchUrlInput, signal?: AbortSignal): Promise<FetchOutput> {
	const normalizedUrl = cleanToolUrl(input.url);
	if (!/^https?:\/\//i.test(normalizedUrl)) {
		throw new Error(`fetch_url only supports http(s) URLs: ${input.url}`);
	}
	const format = normalizeFetchFormat(input.format);
	const page = await fetchPage(normalizedUrl, signal);
	return buildFetchOutput(page, format, input.selector);
}

async function listManifestFiles(root: string): Promise<string[]> {
	const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
	const found: string[] = [];
	let scanned = 0;

	while (queue.length > 0 && found.length < MAX_MANIFEST_FILES && scanned < MAX_SCANNED_DIRS) {
		const current = queue.shift();
		if (!current) break;
		scanned += 1;

		let entries;
		try {
			entries = await readdir(current.dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const entryPath = join(current.dir, entry.name);
			if (entry.isDirectory()) {
				if (current.depth >= 2 || SKIP_DIRS.has(entry.name)) continue;
				queue.push({ dir: entryPath, depth: current.depth + 1 });
				continue;
			}
			if (["package.json", "Cargo.toml", "go.mod", "pyproject.toml"].includes(entry.name)) {
				found.push(entryPath);
				if (found.length >= MAX_MANIFEST_FILES) break;
			}
		}
	}

	return found;
}

function parseNodeSignals(raw: string, manifestPath: string): RepoSignal[] {
	try {
		const parsed = JSON.parse(raw) as {
			name?: string;
			version?: string;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
		};
		const signals: RepoSignal[] = [];
		if (typeof parsed.name === "string") {
			signals.push({
				name: parsed.name,
				version: parsed.version,
				ecosystem: "node",
				manifestPath,
				manifestType: "package.json",
				source: "project",
			});
		}
		for (const section of [parsed.dependencies, parsed.peerDependencies, parsed.optionalDependencies, parsed.devDependencies]) {
			for (const [name, version] of Object.entries(section ?? {})) {
				signals.push({
					name,
					version,
					ecosystem: "node",
					manifestPath,
					manifestType: "package.json",
					source: "dependency",
				});
			}
		}
		return signals;
	} catch {
		return [];
	}
}

function parseCargoSignals(raw: string, manifestPath: string): RepoSignal[] {
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	const signals: RepoSignal[] = [];
	let currentSection = "";
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const sectionMatch = trimmed.match(/^\[(.+)]$/);
		if (sectionMatch) {
			currentSection = sectionMatch[1] ?? "";
			continue;
		}
		if (currentSection === "package") {
			const nameMatch = trimmed.match(/^name\s*=\s*"([^"]+)"/);
			if (nameMatch) {
				signals.push({
					name: nameMatch[1]!,
					ecosystem: "rust",
					manifestPath,
					manifestType: "Cargo.toml",
					source: "project",
				});
			}
			const versionMatch = trimmed.match(/^version\s*=\s*"([^"]+)"/);
			if (versionMatch && signals.length > 0) {
				signals[signals.length - 1]!.version = versionMatch[1]!;
			}
			continue;
		}
		if (!/(^dependencies$|^workspace\.dependencies$|^dev-dependencies$|^build-dependencies$)/.test(currentSection)) continue;
		const depMatch = trimmed.match(/^([A-Za-z0-9_\-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)"[^}]*\})/);
		if (!depMatch) continue;
		signals.push({
			name: depMatch[1]!,
			version: depMatch[2] ?? depMatch[3],
			ecosystem: "rust",
			manifestPath,
			manifestType: "Cargo.toml",
			source: "dependency",
		});
	}
	return signals;
}

function parseGoSignals(raw: string, manifestPath: string): RepoSignal[] {
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	const signals: RepoSignal[] = [];
	let inRequireBlock = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("//")) continue;
		if (trimmed.startsWith("module ")) {
			signals.push({
				name: trimmed.slice("module ".length).trim(),
				ecosystem: "go",
				manifestPath,
				manifestType: "go.mod",
				source: "project",
			});
			continue;
		}
		if (trimmed === "require (") {
			inRequireBlock = true;
			continue;
		}
		if (inRequireBlock && trimmed === ")") {
			inRequireBlock = false;
			continue;
		}
		const requireLine = inRequireBlock ? trimmed : trimmed.startsWith("require ") ? trimmed.slice("require ".length).trim() : "";
		if (!requireLine) continue;
		const match = requireLine.match(/^([^\s]+)\s+([^\s]+)/);
		if (!match) continue;
		signals.push({
			name: match[1]!,
			version: match[2]!,
			ecosystem: "go",
			manifestPath,
			manifestType: "go.mod",
			source: "dependency",
		});
	}
	return signals;
}

function parsePyprojectSignals(raw: string, manifestPath: string): RepoSignal[] {
	const signals: RepoSignal[] = [];
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	let currentSection = "";
	let inProjectDependencies = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const sectionMatch = trimmed.match(/^\[(.+)]$/);
		if (sectionMatch) {
			currentSection = sectionMatch[1] ?? "";
			inProjectDependencies = false;
			continue;
		}
		if (currentSection === "project") {
			const nameMatch = trimmed.match(/^name\s*=\s*["']([^"']+)["']/);
			if (nameMatch) {
				signals.push({
					name: nameMatch[1]!,
					ecosystem: "python",
					manifestPath,
					manifestType: "pyproject.toml",
					source: "project",
				});
			}
			const versionMatch = trimmed.match(/^version\s*=\s*["']([^"']+)["']/);
			if (versionMatch && signals.length > 0) {
				signals[signals.length - 1]!.version = versionMatch[1]!;
			}
			if (trimmed.startsWith("dependencies = [")) {
				inProjectDependencies = true;
				continue;
			}
			if (inProjectDependencies) {
				if (trimmed.startsWith("]")) {
					inProjectDependencies = false;
					continue;
				}
				const depMatch = trimmed.match(/["']([^"'<>!=~\s\[]+)(?:\[[^\]]+\])?(?:[<>=!~].*)?["']/);
				if (depMatch) {
					signals.push({
						name: depMatch[1]!,
						ecosystem: "python",
						manifestPath,
						manifestType: "pyproject.toml",
						source: "dependency",
					});
				}
			}
		}
		if (currentSection === "tool.poetry.dependencies") {
			const depMatch = trimmed.match(/^([A-Za-z0-9_.\-]+)\s*=\s*(?:["']([^"']+)["']|\{[^}]*version\s*=\s*["']([^"']+)["'][^}]*\})/);
			if (!depMatch) continue;
			if (depMatch[1] === "python") continue;
			signals.push({
				name: depMatch[1]!,
				version: depMatch[2] ?? depMatch[3],
				ecosystem: "python",
				manifestPath,
				manifestType: "pyproject.toml",
				source: "dependency",
			});
		}
	}
	return signals;
}

async function deriveRepoContext(cwd: string, query: string, explicitPackage?: string): Promise<RepoContext> {
	const manifests = await listManifestFiles(cwd);
	const collected: RepoSignal[] = [];
	for (const manifest of manifests) {
		let raw: string;
		try {
			raw = await readFile(manifest, "utf8");
		} catch {
			continue;
		}
		const name = basename(manifest);
		if (name === "package.json") collected.push(...parseNodeSignals(raw, manifest));
		else if (name === "Cargo.toml") collected.push(...parseCargoSignals(raw, manifest));
		else if (name === "go.mod") collected.push(...parseGoSignals(raw, manifest));
		else if (name === "pyproject.toml") collected.push(...parsePyprojectSignals(raw, manifest));
	}

	const deduped = new Map<string, RepoSignal>();
	for (const signal of collected) {
		const key = `${signal.manifestPath}|${signal.name}|${signal.source}`.toLowerCase();
		if (!deduped.has(key)) deduped.set(key, signal);
	}
	const signals = [...deduped.values()].slice(0, MAX_REPO_SIGNALS);
	const languages = uniqueStrings(signals.map((signal) => signal.ecosystem));
	const manifestPaths = uniqueStrings(manifests.map((manifest) => relative(cwd, manifest).replace(/\\/g, "/")));

	const queryTokens = tokensWithoutVersionNoise(`${explicitPackage ?? ""} ${query}`);
	let preferredSignal: RepoSignal | undefined;
	let preferredScore = 0;
	for (const signal of signals) {
		let score = 0;
		const nameTokens = tokensWithoutVersionNoise(`${signal.name} ${basenameWithoutScope(signal.name)}`);
		for (const token of nameTokens) {
			if (queryTokens.includes(token)) score += 4;
		}
		if (explicitPackage && signal.name.toLowerCase() === explicitPackage.toLowerCase()) score += 50;
		if (signal.source === "dependency") score += 1;
		if (score > preferredScore) {
			preferredScore = score;
			preferredSignal = signal;
		}
	}

	return {
		signals,
		manifestPaths,
		languages,
		preferredSignal: preferredScore > 0 ? preferredSignal : undefined,
	};
}

interface SearchPlanExecution {
	plan: SearchPlan;
	provider: string;
	rawResultCount: number;
	filteredResultCount: number;
	droppedBlockedCount: number;
	droppedNotAllowedCount: number;
	results: SearchProviderResult[];
}

function looksLikeTroubleshootingQuery(query: string): boolean {
	const normalized = query.toLowerCase();
	return (
		/(error|exception|stack\s*trace|stacktrace|failing|fails|failure|bug|issue|not working|broken|crash|undefined|null|404|500|cannot|can't|unable)/.test(normalized) ||
		/`[^`]+`/.test(query)
	);
}

function buildBaseLookupHints(input: DocsLookupInput, repo: RepoContext): {
	query: string;
	packageHint?: string;
	versionHint?: string;
	languageHint?: string;
	preferredDomains: string[];
	allowedDomains: string[];
	blockedDomains: string[];
} {
	return {
		query: normalizeWhitespace(input.query),
		packageHint: input.package?.trim() || repo.preferredSignal?.name,
		versionHint: input.version?.trim() || repo.preferredSignal?.version,
		languageHint: input.language?.trim() || repo.languages[0],
		preferredDomains: normalizeDomains(input.preferredDomains),
		allowedDomains: normalizeDomains(input.allowedDomains),
		blockedDomains: normalizeDomains(input.blockedDomains),
	};
}

function buildSearchPlans(input: DocsLookupInput, repo: RepoContext): SearchPlan[] {
	const hints = buildBaseLookupHints(input, repo);
	const plans: SearchPlan[] = [];
	const seen = new Set<string>();

	const addPlan = (intent: SearchPlanIntent, label: string, rawQuery: string, options?: { preferredDomains?: string[]; allowedDomains?: string[]; derivedFrom?: string[] }) => {
		const query = normalizeWhitespace(rawQuery);
		if (!query) return;
		const preferredDomains = normalizeDomains(options?.preferredDomains ?? hints.preferredDomains);
		const allowedDomains = normalizeDomains(options?.allowedDomains ?? hints.allowedDomains);
		const blockedDomains = normalizeDomains(hints.blockedDomains);
		const key = `${intent}|${query}|${preferredDomains.join(",")}|${allowedDomains.join(",")}|${blockedDomains.join(",")}`;
		if (seen.has(key)) return;
		seen.add(key);
		plans.push({
			id: `plan_${sha256(key).slice(0, 10)}`,
			label,
			intent,
			query,
			preferredDomains,
			allowedDomains,
			blockedDomains,
			derivedFrom: options?.derivedFrom,
		});
	};

	addPlan("broad", "Broad docs search", [hints.packageHint, hints.versionHint, hints.query].filter(Boolean).join(" "));
	addPlan("official-docs", "Official docs search", [hints.packageHint, hints.versionHint, "official docs", hints.query].filter(Boolean).join(" "));
	if (hints.packageHint) {
		addPlan("reference", "API/reference search", [hints.packageHint, hints.versionHint, "API reference", hints.query].filter(Boolean).join(" "));
	}
	if (hints.languageHint) {
		addPlan("language-context", "Language-aware search", [hints.languageHint, hints.packageHint, hints.query].filter(Boolean).join(" "));
	}
	if (looksLikeTroubleshootingQuery(hints.query)) {
		addPlan("troubleshooting", "Troubleshooting search", [hints.packageHint, hints.versionHint, hints.query, "error docs"].filter(Boolean).join(" "));
	} else {
		addPlan("tutorial", "Guide/tutorial search", [hints.packageHint, hints.versionHint, hints.query, "guide"].filter(Boolean).join(" "));
	}

	const explicitDomainPlans = uniqueStrings([...(hints.preferredDomains ?? []), ...(hints.allowedDomains ?? [])]).slice(0, 4);
	for (const domain of explicitDomainPlans) {
		addPlan(
			"domain-focus",
			`Focused search on ${domain}`,
			`${[hints.packageHint, hints.versionHint, hints.query].filter(Boolean).join(" ")} site:${domain}`,
			{ preferredDomains: [domain], allowedDomains: [domain], derivedFrom: ["user-domain-controls"] },
		);
	}

	return plans;
}

function deriveCandidateDomains(results: SearchResultItem[], input: DocsLookupInput, repo: RepoContext): string[] {
	const hints = buildBaseLookupHints(input, repo);
	if (hints.allowedDomains.length > 0 || hints.preferredDomains.length > 0) return [];
	const explicitPackage = hints.packageHint;
	const packageTokens = explicitPackage ? tokensWithoutVersionNoise(`${explicitPackage} ${basenameWithoutScope(explicitPackage)}`) : [];
	const scores = new Map<string, number>();

	for (const [index, result] of results.slice(0, 12).entries()) {
		if (!result.host || isBlockedDomain(result.host, hints.blockedDomains)) continue;
		let score = Math.max(0, 12 - index * 2);
		if (result.sourceKind === "documentation") score += 18;
		else if (result.sourceKind === "repository-docs") score += 14;
		else if (result.sourceKind === "article") score += 3;
		else if (result.sourceKind === "community") score -= 6;
		score += overlapScore(`${result.url} ${result.title} ${result.snippet}`, packageTokens, 5);
		if (/docs|developer|reference|api|learn|manual/.test(`${result.host} ${result.url}`.toLowerCase())) score += 8;
		score += new Set(result.provenance.map((item) => item.intent)).size * 2;
		scores.set(result.host, (scores.get(result.host) ?? 0) + score);
	}

	return [...scores.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([domain]) => domain)
		.slice(0, 3);
}

function buildFollowupDomainPlans(candidateDomains: string[], input: DocsLookupInput, repo: RepoContext): SearchPlan[] {
	if (candidateDomains.length === 0) return [];
	const hints = buildBaseLookupHints(input, repo);
	return candidateDomains.map((domain) => ({
		id: `plan_${sha256(`domain-focus|${domain}|${hints.query}`).slice(0, 10)}`,
		label: `Focused docs search on ${domain}`,
		intent: "domain-focus" as const,
		query: normalizeWhitespace(`${[hints.packageHint, hints.versionHint, hints.query].filter(Boolean).join(" ")} site:${domain}`),
		preferredDomains: [domain],
		allowedDomains: [domain],
		blockedDomains: hints.blockedDomains,
		derivedFrom: ["candidate-domain"],
	}));
}

async function executeSearchPlan(plan: SearchPlan, signal?: AbortSignal): Promise<SearchPlanExecution> {
	const { provider, results: rawResults } = await searchWithCache(plan.query, signal);
	let droppedBlockedCount = 0;
	let droppedNotAllowedCount = 0;
	const filtered = rawResults.filter((result) => {
		const host = hostFromUrl(result.url);
		if (!host) return false;
		if (isBlockedDomain(host, plan.blockedDomains)) {
			droppedBlockedCount += 1;
			return false;
		}
		if (!isAllowedDomain(host, plan.allowedDomains)) {
			droppedNotAllowedCount += 1;
			return false;
		}
		if (plan.intent === "domain-focus" && plan.preferredDomains.length > 0 && !plan.preferredDomains.some((domain) => domainMatches(host, domain))) {
			droppedNotAllowedCount += 1;
			return false;
		}
		return true;
	});
	return {
		plan,
		provider,
		rawResultCount: rawResults.length,
		filteredResultCount: filtered.length,
		droppedBlockedCount,
		droppedNotAllowedCount,
		results: filtered.slice(0, SEARCH_FETCH_LIMIT),
	};
}

function classifySource(url: string, title: string): string {
	let parsed: URL | undefined;
	try {
		parsed = new URL(url);
	} catch {
		return "web";
	}
	const host = parsed.hostname.toLowerCase();
	const path = parsed.pathname.toLowerCase();
	const combined = `${host} ${path} ${title.toLowerCase()}`;
	if (/issues|discussions|forum|forums|community|question|questions|stackoverflow/.test(combined)) return "community";
	if (host === "github.com" && /(\/docs\/|readme|wiki|blob\/.*\.(md|mdx|markdown|rst)$)/.test(path)) return "repository-docs";
	if (/docs|documentation|developer|reference|manual|guide|learn|api/.test(combined)) return "documentation";
	if (/blog|article|tutorial/.test(combined)) return "article";
	return "web";
}

function rankResult(
	result: SearchProviderResult,
	input: DocsLookupInput,
	repo: RepoContext,
	plan: SearchPlan,
	provider: string,
	rank: number,
	cwd: string,
): SearchResultItem {
	const normalizedUrl = canonicalizeUrl(result.url);
	const host = hostFromUrl(normalizedUrl);
	const queryTokens = tokensWithoutVersionNoise(`${plan.query} ${input.query}`);
	const title = normalizeWhitespace(result.title);
	const snippet = normalizeWhitespace(result.snippet);
	const titleAndSnippet = `${title} ${snippet}`;
	const explicitPackage = input.package?.trim() || repo.preferredSignal?.name;
	const explicitVersion = input.version?.trim() || repo.preferredSignal?.version;
	const packageTokens = explicitPackage ? tokensWithoutVersionNoise(`${explicitPackage} ${basenameWithoutScope(explicitPackage)}`) : [];

	let score = Math.max(0, 12 - rank);
	const reasons: string[] = [];
	const sourceKind = classifySource(normalizedUrl, title);

	const titleScore = overlapScore(title, queryTokens, 7);
	if (titleScore > 0) {
		score += titleScore;
		reasons.push("title/query overlap");
	}
	const snippetScore = overlapScore(snippet, queryTokens, 3);
	if (snippetScore > 0) {
		score += snippetScore;
		reasons.push("snippet/query overlap");
	}
	const urlScore = overlapScore(normalizedUrl, queryTokens, 2);
	if (urlScore > 0) {
		score += urlScore;
		reasons.push("url/query overlap");
	}
	if (packageTokens.length > 0) {
		const packageScore = overlapScore(`${normalizedUrl} ${titleAndSnippet}`, packageTokens, 8);
		if (packageScore > 0) {
			score += packageScore;
			reasons.push(`package match: ${explicitPackage}`);
		}
	}
	const versionMajor = extractMajorVersion(explicitVersion);
	if (versionMajor && new RegExp(`(^|[^0-9])${versionMajor}(?:[^0-9]|$)`).test(`${titleAndSnippet} ${normalizedUrl}`)) {
		score += 8;
		reasons.push(`version hint: ${versionMajor}`);
	}
	if (sourceKind === "documentation") {
		score += 14;
		reasons.push("documentation-style source");
	} else if (sourceKind === "repository-docs") {
		score += 10;
		reasons.push("repository docs source");
	} else if (sourceKind === "community") {
		score -= 4;
		reasons.push("community fallback source");
	} else if (sourceKind === "article") {
		score += 3;
		reasons.push("article/tutorial source");
	}
	if (plan.intent === "official-docs" && sourceKind === "documentation") {
		score += 8;
		reasons.push("matches official docs intent");
	}
	if (plan.intent === "reference" && /api|reference|sdk|method|class/.test(`${titleAndSnippet} ${normalizedUrl}`.toLowerCase())) {
		score += 6;
		reasons.push("matches reference intent");
	}
	if (plan.intent === "troubleshooting" && /error|troubleshoot|issue|faq|fix/.test(`${titleAndSnippet} ${normalizedUrl}`.toLowerCase())) {
		score += 4;
		reasons.push("matches troubleshooting intent");
	}
	if (plan.intent === "tutorial" && /guide|tutorial|getting started|how to/.test(`${titleAndSnippet} ${normalizedUrl}`.toLowerCase())) {
		score += 4;
		reasons.push("matches guide intent");
	}
	if (plan.preferredDomains.some((domain) => domainMatches(host, domain))) {
		score += 18;
		reasons.push(`preferred domain: ${host}`);
	} else if (plan.allowedDomains.some((domain) => domainMatches(host, domain))) {
		score += 8;
		reasons.push(`allowed domain: ${host}`);
	}
	if (repo.preferredSignal && explicitPackage && repo.preferredSignal.name.toLowerCase() === explicitPackage.toLowerCase()) {
		score += 4;
		reasons.push(`repo hint from ${relative(cwd, repo.preferredSignal.manifestPath).replace(/\\/g, "/")}`);
	}

	return {
		id: `doc_${sha256(normalizedUrl).slice(0, 8)}`,
		title: title || normalizedUrl,
		url: normalizedUrl,
		host,
		snippet,
		sourceKind,
		score,
		reasons: uniqueStrings(reasons).slice(0, 6),
		searchQuery: plan.query,
		provenance: [
			{
				planId: plan.id,
				label: plan.label,
				intent: plan.intent,
				query: plan.query,
				provider,
				rank,
			},
		],
	};
}

function mergeProvenance(items: SearchResultProvenance[]): SearchResultProvenance[] {
	const merged = new Map<string, SearchResultProvenance>();
	for (const item of items) {
		const existing = merged.get(item.planId);
		if (!existing || item.rank < existing.rank) {
			merged.set(item.planId, item);
		}
	}
	return [...merged.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

function dedupeRankedResults(results: SearchResultItem[]): SearchResultItem[] {
	const deduped = new Map<string, SearchResultItem>();
	for (const result of results) {
		const existing = deduped.get(result.url);
		if (!existing) {
			deduped.set(result.url, { ...result, provenance: [...result.provenance] });
			continue;
		}

		const mergedScoreBase = Math.max(existing.score, result.score);
		const mergedProvenance = mergeProvenance([...existing.provenance, ...result.provenance]);
		const mergedReasons = uniqueStrings([...existing.reasons, ...result.reasons]).slice(0, 8);
		const stronger = result.score > existing.score ? result : existing;
		deduped.set(result.url, {
			...stronger,
			score: mergedScoreBase,
			reasons: mergedReasons,
			provenance: mergedProvenance,
			searchQuery: stronger.searchQuery,
		});
	}
	return [...deduped.values()]
		.map((result) => {
			const planCount = result.provenance.length;
			const intentCount = new Set(result.provenance.map((item) => item.intent)).size;
			return {
				...result,
				score: result.score + Math.min(10, Math.max(0, planCount - 1) * 2 + Math.max(0, intentCount - 1)),
			};
		})
		.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
}

function unwrapDuckDuckGoUrl(href: string): string {
	const decoded = decodeHtmlEntities(href);
	try {
		const parsed = new URL(decoded, "https://duckduckgo.com");
		const target = parsed.searchParams.get("uddg") ?? parsed.searchParams.get("rut");
		if (target) return decodeURIComponent(target);
		if (decoded.startsWith("//")) return `https:${decoded}`;
		if (/^https?:\/\//i.test(decoded)) return decoded;
		return parsed.toString();
	} catch {
		return decoded;
	}
}

function parseDuckDuckGoResults(html: string): SearchProviderResult[] {
	const results: SearchProviderResult[] = [];
	const blockRegex = /<div[^>]+class="[^"]*result(?:__body)?[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>|<div[^>]+class="[^"]*web-result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
	const blocks = [...html.matchAll(blockRegex)].map((match) => match[1] ?? match[2] ?? "");
	const candidates = blocks.length > 0 ? blocks : [html];

	for (const block of candidates) {
		const titleMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
		if (!titleMatch) continue;
		const snippetMatch = block.match(/<(?:a|div)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
		const url = unwrapDuckDuckGoUrl(titleMatch[1]!);
		if (!/^https?:\/\//i.test(url)) continue;
		results.push({
			title: stripTags(titleMatch[2] ?? url),
			url,
			snippet: snippetMatch ? stripTags(snippetMatch[1] ?? "") : "",
		});
		if (results.length >= SEARCH_FETCH_LIMIT) break;
	}

	return results;
}

async function searchDuckDuckGo(query: string, signal?: AbortSignal): Promise<SearchProviderResult[]> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const response = await fetchWithTimeout(url, signal, SEARCH_TIMEOUT_MS);
	if (!response.ok) {
		throw new Error(`DuckDuckGo search failed: ${response.status}`);
	}
	const html = await response.text();
	return parseDuckDuckGoResults(html);
}

async function searchBrave(query: string, signal?: AbortSignal): Promise<SearchProviderResult[]> {
	const apiKey = process.env.BRAVE_SEARCH_API_KEY;
	if (!apiKey) throw new Error("BRAVE_SEARCH_API_KEY is not set");
	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${SEARCH_FETCH_LIMIT}`;
	const controller = new AbortController();
	const combined = new AbortController();
	const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
	const abort = () => combined.abort();
	controller.signal.addEventListener("abort", abort);
	if (signal) signal.addEventListener("abort", abort);
	if (controller.signal.aborted || signal?.aborted) combined.abort();
	try {
		const response = await fetch(url, {
			headers: {
				Accept: "application/json",
				"User-Agent": HTTP_USER_AGENT,
				"X-Subscription-Token": apiKey,
			},
			signal: combined.signal,
		});
		if (!response.ok) {
			throw new Error(`Brave search failed: ${response.status}`);
		}
		const payload = (await response.json()) as {
			web?: {
				results?: Array<{ title?: string; url?: string; description?: string }>;
			};
		};
		return (payload.web?.results ?? [])
			.filter((result) => typeof result?.url === "string" && typeof result?.title === "string")
			.map((result) => ({
				title: normalizeWhitespace(result.title ?? ""),
				url: result.url!,
				snippet: normalizeWhitespace(result.description ?? ""),
			}))
			.slice(0, SEARCH_FETCH_LIMIT);
	} finally {
		clearTimeout(timeout);
		controller.signal.removeEventListener("abort", abort);
		if (signal) signal.removeEventListener("abort", abort);
	}
}

function getSearchProvider(): SearchProvider {
	if (process.env.BRAVE_SEARCH_API_KEY) {
		return {
			name: "brave",
			search: async (query, signal) => searchBrave(query, signal),
		};
	}
	return {
		name: "duckduckgo",
		search: async (query, signal) => searchDuckDuckGo(query, signal),
	};
}

async function searchWithCache(query: string, signal?: AbortSignal): Promise<{ provider: string; results: SearchProviderResult[] }> {
	const provider = getSearchProvider();
	const cachePath = searchJsonPath(provider.name, query);
	const cached = await readJsonIfFresh<CachedSearchResult>(cachePath, SEARCH_CACHE_TTL_MS);
	if (cached?.provider === provider.name) {
		return { provider: cached.provider, results: cached.results };
	}
	const results = await provider.search(query, signal);
	await writeJsonAtomically(cachePath, {
		provider: provider.name,
		query,
		createdAt: new Date().toISOString(),
		results,
	} satisfies CachedSearchResult);
	return { provider: provider.name, results };
}

function summarizeRepoHints(repo: RepoContext): string[] {
	const preferred = repo.preferredSignal
		? [`${repo.preferredSignal.name}${repo.preferredSignal.version ? `@${repo.preferredSignal.version}` : ""}`]
		: [];
	const extra = repo.signals
		.filter((signal) => signal.source === "dependency")
		.slice(0, 5)
		.map((signal) => `${signal.name}${signal.version ? `@${signal.version}` : ""}`);
	return uniqueStrings([...preferred, ...extra]);
}

function summarizeSurfacedBy(result: SearchResultItem): string {
	return uniqueStrings(result.provenance.map((item) => item.label)).slice(0, 4).join("; ");
}

function serializePlanExecution(execution: SearchPlanExecution): Record<string, unknown> {
	return {
		plan: execution.plan,
		provider: execution.provider,
		rawResultCount: execution.rawResultCount,
		filteredResultCount: execution.filteredResultCount,
		droppedBlockedCount: execution.droppedBlockedCount,
		droppedNotAllowedCount: execution.droppedNotAllowedCount,
		topResults: execution.results.slice(0, 5).map((result) => ({
			title: result.title,
			url: canonicalizeUrl(result.url),
			host: hostFromUrl(result.url),
		})),
	};
}

function restoreSearchResultItem(value: unknown): SearchResultItem | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Partial<SearchResultItem>;
	if (typeof input.url !== "string") return undefined;
	const url = canonicalizeUrl(input.url);
	const title = typeof input.title === "string" && input.title.trim().length > 0 ? input.title : url;
	const provenance = Array.isArray(input.provenance)
		? input.provenance
				.filter((item): item is SearchResultProvenance => !!item && typeof item === "object")
				.map((item) => ({
					planId: typeof item.planId === "string" ? item.planId : `legacy_${sha256(`${url}|${item.query ?? ""}`).slice(0, 8)}`,
					label: typeof item.label === "string" ? item.label : "Legacy result",
					intent:
						item.intent === "broad" ||
						item.intent === "official-docs" ||
						item.intent === "reference" ||
						item.intent === "language-context" ||
						item.intent === "troubleshooting" ||
						item.intent === "tutorial" ||
						item.intent === "domain-focus"
							? item.intent
							: "broad",
					query: typeof item.query === "string" ? item.query : typeof input.searchQuery === "string" ? input.searchQuery : "",
					provider: typeof item.provider === "string" ? item.provider : "unknown",
					rank: typeof item.rank === "number" && Number.isFinite(item.rank) ? item.rank : 1,
				}))
		: [];

	return {
		id: typeof input.id === "string" ? input.id : `doc_${sha256(url).slice(0, 8)}`,
		title,
		url,
		host: typeof input.host === "string" && input.host ? input.host : hostFromUrl(url),
		snippet: typeof input.snippet === "string" ? input.snippet : "",
		sourceKind: typeof input.sourceKind === "string" ? input.sourceKind : classifySource(url, title),
		score: typeof input.score === "number" && Number.isFinite(input.score) ? input.score : 0,
		reasons: Array.isArray(input.reasons)
			? input.reasons.filter((reason): reason is string => typeof reason === "string").slice(0, 8)
			: [],
		searchQuery: typeof input.searchQuery === "string" ? input.searchQuery : provenance[0]?.query ?? "",
		provenance,
	};
}

export async function docsLookup(input: DocsLookupInput, cwd: string, signal?: AbortSignal): Promise<{ text: string; details: Record<string, unknown>; results: SearchResultItem[] }> {
	const query = normalizeWhitespace(input.query);
	if (!query) throw new Error("docs_lookup query cannot be empty");

	const repo = await deriveRepoContext(cwd, query, input.package);
	const hints = buildBaseLookupHints(input, repo);
	const initialPlans = buildSearchPlans(input, repo);
	const initialExecutions = await Promise.all(initialPlans.map((plan) => executeSearchPlan(plan, signal)));
	const initialRanked = dedupeRankedResults(
		initialExecutions.flatMap((execution) =>
			execution.results.map((result, index) => rankResult(result, input, repo, execution.plan, execution.provider, index + 1, cwd)),
		),
		);
	const candidateDomains = deriveCandidateDomains(initialRanked, input, repo);
	const followupPlans = buildFollowupDomainPlans(candidateDomains, input, repo);
	const followupExecutions = await Promise.all(followupPlans.map((plan) => executeSearchPlan(plan, signal)));
	const allExecutions = [...initialExecutions, ...followupExecutions];
	const providers = uniqueStrings(allExecutions.map((execution) => execution.provider));
	const ranked = dedupeRankedResults(
		allExecutions.flatMap((execution) =>
			execution.results.map((result, index) => rankResult(result, input, repo, execution.plan, execution.provider, index + 1, cwd)),
		),
	).slice(0, SEARCH_RESULT_LIMIT);

	const repoHints = summarizeRepoHints(repo);
	const consultedUrls = uniqueStrings(allExecutions.flatMap((execution) => execution.results.map((result) => canonicalizeUrl(result.url))));
	const consultedDomains = uniqueStrings(allExecutions.flatMap((execution) => execution.results.map((result) => hostFromUrl(result.url))));
	const lines: string[] = [];
	lines.push(`# Docs lookup`, "");
	lines.push(`Query: ${query}`);
	if (input.package) lines.push(`Explicit package: ${input.package}`);
	if (input.version) lines.push(`Explicit version: ${input.version}`);
	if (input.language) lines.push(`Explicit language: ${input.language}`);
	lines.push(`Search provider${providers.length === 1 ? "" : "s"}: ${providers.join(", ")}`);
	if (hints.preferredDomains.length > 0) lines.push(`Preferred domains: ${hints.preferredDomains.join(", ")}`);
	if (hints.allowedDomains.length > 0) lines.push(`Allowed domains: ${hints.allowedDomains.join(", ")}`);
	if (hints.blockedDomains.length > 0) lines.push(`Blocked domains: ${hints.blockedDomains.join(", ")}`);
	if (repoHints.length > 0) lines.push(`Repo hints: ${repoHints.join(", ")}`);
	if (repo.manifestPaths.length > 0) lines.push(`Repo manifests: ${repo.manifestPaths.join(", ")}`);
	lines.push("");
	lines.push(`Planned retrieval (${allExecutions.length} plan${allExecutions.length === 1 ? "" : "s"}):`);
	for (const execution of allExecutions) {
		const controls: string[] = [];
		if (execution.plan.preferredDomains.length > 0) controls.push(`preferred=${execution.plan.preferredDomains.join(",")}`);
		if (execution.plan.allowedDomains.length > 0) controls.push(`allowed=${execution.plan.allowedDomains.join(",")}`);
		if (execution.plan.blockedDomains.length > 0) controls.push(`blocked=${execution.plan.blockedDomains.join(",")}`);
		lines.push(
			`- [${execution.plan.id}] ${execution.plan.label} (${execution.plan.intent}) — ${execution.plan.query} [kept ${execution.filteredResultCount}/${execution.rawResultCount}${controls.length > 0 ? `; ${controls.join("; ")}` : ""}]`,
		);
	}
	if (candidateDomains.length > 0) {
		lines.push("");
		lines.push(`Focused follow-up domains: ${candidateDomains.join(", ")}`);
	}
	lines.push("");
	lines.push(`Consulted sources: ${consultedUrls.length} URL${consultedUrls.length === 1 ? "" : "s"} across ${consultedDomains.length} domain${consultedDomains.length === 1 ? "" : "s"}.`);
	lines.push("");

	if (ranked.length === 0) {
		lines.push("No matching docs or research results found.");
	} else {
		for (const [index, result] of ranked.entries()) {
			lines.push(`${index + 1}. [${result.id}] ${truncateLine(result.title, 220)}`);
			lines.push(`   URL: ${result.url}`);
			lines.push(`   Domain: ${result.host}`);
			lines.push(`   Source: ${result.sourceKind}`);
			if (result.provenance.length > 0) lines.push(`   Surfaced by: ${summarizeSurfacedBy(result)}`);
			if (result.reasons.length > 0) lines.push(`   Why: ${result.reasons.join("; ")}`);
			if (result.snippet) lines.push(`   Snippet: ${truncateText(result.snippet, 280)}`);
			lines.push("");
		}
	}

	const text = normalizeMultilineWhitespace(lines.join("\n"));
	return {
		text,
		results: ranked,
		details: {
			query,
			providers,
			results: ranked,
			queryPlans: allExecutions.map((execution) => execution.plan),
			planExecutions: allExecutions.map((execution) => serializePlanExecution(execution)),
			consultedUrls,
			consultedDomains,
			sourceControls: {
				preferredDomains: hints.preferredDomains,
				allowedDomains: hints.allowedDomains,
				blockedDomains: hints.blockedDomains,
			},
			candidateDomains,
			repoHints,
			repoManifestPaths: repo.manifestPaths,
			preferredSignal: repo.preferredSignal,
		},
	};
}

export function restoreLookupResultsFromBranch(branch: unknown[]): Map<string, SearchResultItem> {
	const restored = new Map<string, SearchResultItem>();
	for (const entry of branch) {
		const messageEntry = entry as {
			type?: string;
			message?: {
				role?: string;
				toolName?: string;
				details?: {
					results?: unknown[];
				};
			};
		};
		if (messageEntry.type !== "message") continue;
		if (messageEntry.message?.role !== "toolResult") continue;
		if (messageEntry.message.toolName !== "docs_lookup") continue;
		for (const rawResult of messageEntry.message.details?.results ?? []) {
			const restoredResult = restoreSearchResultItem(rawResult);
			if (!restoredResult) continue;
			restored.set(restoredResult.id, restoredResult);
		}
	}
	return restored;
}

export async function docsReadSection(
	input: DocsReadSectionInput,
	recentLookupResults: Map<string, SearchResultItem>,
	signal?: AbortSignal,
): Promise<FetchOutput> {
	const identifier = normalizeWhitespace(input.docIdOrUrl);
	if (!identifier) throw new Error("docs_read_section requires a doc id or URL");
	const lookupResult = /^https?:\/\//i.test(identifier) ? undefined : recentLookupResults.get(identifier);
	const resolvedUrl = /^https?:\/\//i.test(identifier) ? identifier : lookupResult?.url;
	if (!resolvedUrl) {
		throw new Error(`Unknown doc id: ${identifier}. Pass a URL or use an id returned by docs_lookup in this session.`);
	}
	const page = await fetchPage(resolvedUrl, signal);
	const selected = selectSection(page, input.heading);
	const fullPath = page.cacheMarkdownPath;

	if (!selected.section) {
		const lines: string[] = [];
		if (page.title) lines.push(`# ${page.title}`, "");
		lines.push(`URL: ${page.finalUrl}`);
		if (input.heading) lines.push(`Requested heading: ${input.heading}`);
		lines.push("No close section match was found.", "");
		if (page.sections.length > 0) {
			lines.push("Available headings:");
			for (const section of page.sections.slice(0, 40)) {
				const indent = "  ".repeat(Math.max(0, section.level - 1));
				const suffix = section.id ? ` (#${section.id})` : "";
				lines.push(`${indent}- ${section.heading}${suffix}`);
			}
		} else {
			lines.push("This page did not yield structured headings. Use fetch_url for the full extracted content.");
		}
		const output = formatTruncationNotice(lines.join("\n"), fullPath);
		return {
			text: output.text,
			details: {
				identifier,
				resolvedUrl: page.finalUrl,
				heading: input.heading,
				matched: false,
				sectionCount: page.sections.length,
				source: lookupResult
					? {
						docId: lookupResult.id,
						title: lookupResult.title,
						url: lookupResult.url,
						host: lookupResult.host,
						sourceKind: lookupResult.sourceKind,
						reasons: lookupResult.reasons,
						provenance: lookupResult.provenance,
					}
					: {
						title: page.title,
						url: page.finalUrl,
						host: hostFromUrl(page.finalUrl),
					},
				consultedSource: {
					title: lookupResult?.title ?? page.title,
					url: page.finalUrl,
					host: hostFromUrl(page.finalUrl),
					sourceKind: lookupResult?.sourceKind,
				},
				cacheMarkdownPath: page.cacheMarkdownPath,
				cacheTextPath: page.cacheTextPath,
				cacheJsonPath: page.cacheJsonPath,
				truncated: output.truncated,
			},
		};
	}

	const text = formatSelectedSection(page, selected.section, selected.reason ?? (input.heading ? `heading ${JSON.stringify(input.heading)}` : "section selection"));
	const output = formatTruncationNotice(text, fullPath);
	const fragmentUrl = selected.section.id ? `${page.finalUrl}#${selected.section.id}` : page.finalUrl;
	return {
		text: output.text,
		details: {
			identifier,
			resolvedUrl: page.finalUrl,
			heading: input.heading,
			matched: true,
			source: lookupResult
				? {
					docId: lookupResult.id,
					title: lookupResult.title,
					url: lookupResult.url,
					host: lookupResult.host,
					sourceKind: lookupResult.sourceKind,
					reasons: lookupResult.reasons,
					provenance: lookupResult.provenance,
				}
				: {
					title: page.title,
					url: page.finalUrl,
					host: hostFromUrl(page.finalUrl),
				},
			consultedSource: {
				title: lookupResult?.title ?? page.title,
				url: page.finalUrl,
				host: hostFromUrl(page.finalUrl),
				sourceKind: lookupResult?.sourceKind,
			},
			citation: {
				title: lookupResult?.title ?? page.title,
				url: page.finalUrl,
				fragmentUrl,
				sectionHeading: selected.section.heading,
				sectionId: selected.section.id,
			},
			selectedSection: {
				heading: selected.section.heading,
				id: selected.section.id,
				reason: selected.reason,
			},
			sectionCount: page.sections.length,
			cacheMarkdownPath: page.cacheMarkdownPath,
			cacheTextPath: page.cacheTextPath,
			cacheJsonPath: page.cacheJsonPath,
			truncated: output.truncated,
		},
	};
}
