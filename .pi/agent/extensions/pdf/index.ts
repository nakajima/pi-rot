import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const CACHE_ROOT = join(homedir(), ".pi", "agent", "cache", "pdf");
const TEXT_TIMEOUT_MS = 120_000;
const INFO_TIMEOUT_MS = 20_000;
const RENDER_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_RENDERED_PAGES = 5;
const DEFAULT_RENDER_DPI = 150;
const MAX_RENDER_DPI = 300;
const MIN_RENDER_DPI = 72;
const DEFAULT_SEARCH_RESULTS = 20;
const MAX_SEARCH_RESULTS = 100;

const PdfInfoParams = Type.Object({
	path: Type.Optional(Type.String({ description: "Optional local PDF path to inspect. May be prefixed with @." })),
});

const PdfReadParams = Type.Object({
	path: Type.String({ description: "Local PDF path to read. May be prefixed with @." }),
	pages: Type.Optional(Type.String({ description: "Optional page range like 1-3,7. Defaults to all pages." })),
	format: Type.Optional(Type.String({ description: 'Output format: "markdown" (default), "text", or "outline".' })),
	layout: Type.Optional(Type.Boolean({ description: "Preserve physical layout with pdftotext -layout. Defaults to true." })),
	renderPages: Type.Optional(Type.Boolean({ description: `Render selected pages as PNG images for vision-capable models. Renders at most ${MAX_RENDERED_PAGES} pages.` })),
	dpi: Type.Optional(Type.Number({ description: `DPI for rendered page images. Defaults to ${DEFAULT_RENDER_DPI}; clamped to ${MIN_RENDER_DPI}-${MAX_RENDER_DPI}.` })),
});

const PdfSearchParams = Type.Object({
	path: Type.String({ description: "Local PDF path to search. May be prefixed with @." }),
	query: Type.String({ description: "Plain text query to search for in extracted PDF text." }),
	pages: Type.Optional(Type.String({ description: "Optional page range like 1-3,7. Defaults to all pages." })),
	caseSensitive: Type.Optional(Type.Boolean({ description: "Match case exactly. Defaults to false." })),
	contextLines: Type.Optional(Type.Number({ description: "Number of lines around each match. Defaults to 2; clamped to 0-8." })),
	maxResults: Type.Optional(Type.Number({ description: `Maximum number of matches to return. Defaults to ${DEFAULT_SEARCH_RESULTS}; clamped to 1-${MAX_SEARCH_RESULTS}.` })),
	layout: Type.Optional(Type.Boolean({ description: "Preserve physical layout when extracting text. Defaults to true." })),
});

type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

interface CommandResult {
	stdout: string;
	stderr: string;
	code: number | null;
	killed?: boolean;
}

interface ToolStatus {
	command: string;
	available: boolean;
	version?: string;
	error?: string;
}

interface ResolvedPdf {
	inputPath: string;
	absolutePath: string;
	displayPath: string;
	size: number;
	mtimeMs: number;
}

interface ParsedPdfInfo {
	metadata: Record<string, string>;
	pages?: number;
	encrypted?: boolean;
	title?: string;
	author?: string;
	pageSize?: string;
}

interface TextExtraction {
	pages: string[];
	cacheTextPath: string;
	cacheKey: string;
}

interface RenderedPage {
	page: number;
	path: string;
	bytes: number;
}

interface SearchMatch {
	page: number;
	line: number;
	snippet: string;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function cleanToolPath(path: string): string {
	const trimmed = path.trim();
	return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function displayPath(cwd: string, absolutePath: string): string {
	const rel = relative(cwd, absolutePath).replace(/\\/g, "/");
	if (rel && !rel.startsWith("../") && rel !== ".." && !isAbsolute(rel)) return rel;
	return absolutePath;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

async function resolvePdfPath(cwd: string, rawPath: string): Promise<ResolvedPdf> {
	const cleaned = cleanToolPath(rawPath);
	if (!cleaned) throw new Error("PDF path is empty.");
	if (/^https?:\/\//i.test(cleaned)) {
		throw new Error("PDF tools only support local files. Download the PDF first, then pass the local path.");
	}

	const absolutePath = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
	const fileStat = await stat(absolutePath);
	if (!fileStat.isFile()) throw new Error(`Not a file: ${absolutePath}`);
	if (extname(absolutePath).toLowerCase() !== ".pdf") {
		throw new Error(`Expected a .pdf file, got: ${absolutePath}`);
	}

	return {
		inputPath: rawPath,
		absolutePath,
		displayPath: displayPath(cwd, absolutePath),
		size: fileStat.size,
		mtimeMs: fileStat.mtimeMs,
	};
}

function installHelp(): string {
	const common = [
		"Install Poppler, then make sure pdfinfo, pdftotext, and pdftoppm are on PATH.",
		"macOS: brew install poppler",
		"Debian/Ubuntu: sudo apt install poppler-utils",
		"Fedora: sudo dnf install poppler-utils",
		"Arch: sudo pacman -S poppler",
		"Windows (Scoop): scoop install poppler",
		"Windows (Chocolatey): choco install poppler",
	];

	if (process.platform === "darwin") return common.join("\n");
	if (process.platform === "linux") return common.join("\n");
	if (process.platform === "win32") return common.join("\n");
	return common.join("\n");
}

function firstVersionLine(output: string): string | undefined {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => /\bversion\b/i.test(line));
}

async function checkCommand(pi: ExtensionAPI, command: string): Promise<ToolStatus> {
	try {
		const result = await pi.exec(command, ["-v"], { timeout: COMMAND_TIMEOUT_MS }) as CommandResult;
		const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
		const version = firstVersionLine(combined);
		return {
			command,
			available: result.code === 0 || Boolean(version),
			version,
			error: result.code === 0 || version ? undefined : combined || `exit code ${result.code}`,
		};
	} catch (error) {
		return {
			command,
			available: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function checkPoppler(pi: ExtensionAPI): Promise<ToolStatus[]> {
	return Promise.all(["pdfinfo", "pdftotext", "pdftoppm"].map((command) => checkCommand(pi, command)));
}

async function requireCommands(pi: ExtensionAPI, commands: string[]): Promise<void> {
	const statuses = await Promise.all(commands.map((command) => checkCommand(pi, command)));
	const missing = statuses.filter((status) => !status.available);
	if (missing.length === 0) return;
	throw new Error(`Missing Poppler command(s): ${missing.map((status) => status.command).join(", ")}\n\n${installHelp()}`);
}

function formatToolStatus(statuses: ToolStatus[]): string {
	const lines = ["# PDF tooling", ""];
	for (const status of statuses) {
		if (status.available) {
			lines.push(`- ${status.command}: available${status.version ? ` (${status.version})` : ""}`);
		} else {
			lines.push(`- ${status.command}: missing${status.error ? ` (${status.error})` : ""}`);
		}
	}
	if (statuses.some((status) => !status.available)) {
		lines.push("", installHelp());
	}
	return lines.join("\n");
}

function popplerFailure(command: string, result: CommandResult): Error {
	const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
	const encryptedHint = /password|encrypted|permission/i.test(output)
		? "\n\nIf this PDF is encrypted, create a decrypted copy before using these tools. Password parameters are intentionally not supported because tool calls are stored in pi sessions."
		: "";
	return new Error(`${command} failed with exit code ${result.code ?? "unknown"}.${output ? `\n${output}` : ""}${encryptedHint}`);
}

function parsePdfInfoOutput(output: string): ParsedPdfInfo {
	const metadata: Record<string, string> = {};
	for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
		const match = line.match(/^([^:]+):\s*(.*)$/);
		if (!match) continue;
		metadata[match[1]!.trim()] = match[2]!.trim();
	}

	const pagesRaw = metadata.Pages;
	const pages = pagesRaw && /^\d+$/.test(pagesRaw) ? Number(pagesRaw) : undefined;
	const encryptedRaw = metadata.Encrypted?.toLowerCase();
	return {
		metadata,
		pages,
		encrypted: encryptedRaw ? encryptedRaw.startsWith("yes") : undefined,
		title: metadata.Title,
		author: metadata.Author,
		pageSize: metadata["Page size"],
	};
}

async function readPdfInfo(pi: ExtensionAPI, pdf: ResolvedPdf): Promise<ParsedPdfInfo> {
	await requireCommands(pi, ["pdfinfo"]);
	const result = await pi.exec("pdfinfo", [pdf.absolutePath], { timeout: INFO_TIMEOUT_MS }) as CommandResult;
	if (result.code !== 0) throw popplerFailure("pdfinfo", result);
	return parsePdfInfoOutput(result.stdout || result.stderr || "");
}

function cacheKey(pdf: ResolvedPdf, layout: boolean): string {
	return sha256(JSON.stringify({
		path: pdf.absolutePath,
		size: pdf.size,
		mtimeMs: Math.round(pdf.mtimeMs),
		layout,
		tool: "pdftotext",
		version: 1,
	}));
}

function textCachePath(key: string): string {
	return join(CACHE_ROOT, "text", `${key}.txt`);
}

function renderCachePath(key: string, page: number, dpi: number): string {
	return join(CACHE_ROOT, "render", key, `${page}-${dpi}.png`);
}

function splitPages(rawText: string, totalPages: number): string[] {
	const normalized = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const parts = normalized.split("\f");
	if (parts.length > totalPages && parts[parts.length - 1]?.trim() === "") parts.pop();
	while (parts.length < totalPages) parts.push("");
	return parts.slice(0, totalPages).map((page) => page.replace(/[ \t]+$/gm, "").trimEnd());
}

async function extractText(pi: ExtensionAPI, pdf: ResolvedPdf, totalPages: number, layout: boolean): Promise<TextExtraction> {
	await requireCommands(pi, ["pdftotext"]);
	const key = cacheKey(pdf, layout);
	const cacheTextPath = textCachePath(key);

	if (!(await exists(cacheTextPath))) {
		await ensureDir(dirname(cacheTextPath));
		await withFileMutationQueue(cacheTextPath, async () => {
			if (await exists(cacheTextPath)) return;
			const args = [
				...(layout ? ["-layout"] : []),
				"-enc",
				"UTF-8",
				pdf.absolutePath,
				cacheTextPath,
			];
			const result = await pi.exec("pdftotext", args, { timeout: TEXT_TIMEOUT_MS }) as CommandResult;
			if (result.code !== 0) throw popplerFailure("pdftotext", result);
		});
	}

	const raw = await readFile(cacheTextPath, "utf8");
	return {
		pages: splitPages(raw, totalPages),
		cacheTextPath,
		cacheKey: key,
	};
}

function normalizeFormat(format?: string): "markdown" | "text" | "outline" {
	const normalized = (format ?? "markdown").trim().toLowerCase();
	if (normalized === "text" || normalized === "outline") return normalized;
	return "markdown";
}

function parsePageRange(input: string | undefined, totalPages: number): number[] {
	if (!Number.isFinite(totalPages) || totalPages <= 0) throw new Error("PDF page count is unavailable.");
	const trimmed = input?.trim();
	if (!trimmed || trimmed.toLowerCase() === "all") {
		return Array.from({ length: totalPages }, (_value, index) => index + 1);
	}

	const pages: number[] = [];
	const seen = new Set<number>();
	for (const token of trimmed.split(",")) {
		const part = token.trim();
		if (!part) continue;
		const match = part.match(/^(\d+)(?:-(\d+))?$/);
		if (!match) throw new Error(`Invalid page range segment: ${part}`);
		const start = Number(match[1]);
		const end = match[2] ? Number(match[2]) : start;
		if (start < 1 || end < 1 || start > totalPages || end > totalPages || end < start) {
			throw new Error(`Page range ${part} is outside the PDF page count 1-${totalPages}.`);
		}
		for (let page = start; page <= end; page++) {
			if (seen.has(page)) continue;
			seen.add(page);
			pages.push(page);
		}
	}
	if (pages.length === 0) throw new Error("No pages selected.");
	return pages;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.round(value)));
}

function pageHeadline(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => normalizeWhitespace(line))
		.filter(Boolean);
	const first = lines[0] ?? "";
	return first.length > 140 ? `${first.slice(0, 137)}...` : first || "(no extracted text)";
}

function wordCount(text: string): number {
	return text.match(/[\p{L}\p{N}_'-]+/gu)?.length ?? 0;
}

function selectedTextEntries(pageTexts: string[], pages: number[]): Array<{ page: number; text: string }> {
	return pages.map((page) => ({ page, text: pageTexts[page - 1] ?? "" }));
}

function formatOutline(pdf: ResolvedPdf, info: ParsedPdfInfo, entries: Array<{ page: number; text: string }>): string {
	const lines = [`# ${info.title || basename(pdf.absolutePath)}`, ""];
	lines.push(`PDF: ${pdf.displayPath}`);
	if (info.pages) lines.push(`Pages: ${info.pages}`);
	if (info.author) lines.push(`Author: ${info.author}`);
	if (info.pageSize) lines.push(`Page size: ${info.pageSize}`);
	lines.push("", "Page outline:");
	for (const entry of entries) {
		const words = wordCount(entry.text);
		lines.push(`- Page ${entry.page}: ${pageHeadline(entry.text)} (${words} words)`);
	}
	return lines.join("\n");
}

function formatReadOutput(
	pdf: ResolvedPdf,
	info: ParsedPdfInfo,
	entries: Array<{ page: number; text: string }>,
	format: "markdown" | "text" | "outline",
	cacheTextPath: string,
	renderedPages: RenderedPage[],
	renderLimitHit: boolean,
	attachRenderedImages: boolean,
): string {
	if (format === "outline") {
		return formatOutline(pdf, info, entries);
	}

	const sparsePages = entries.filter((entry) => normalizeWhitespace(entry.text).length < 80).map((entry) => entry.page);
	const lines: string[] = [];
	if (format === "markdown") {
		lines.push(`# ${info.title || basename(pdf.absolutePath)}`, "");
		lines.push(`PDF: ${pdf.displayPath}`);
		if (info.pages) lines.push(`Pages: ${info.pages}`);
		if (info.author) lines.push(`Author: ${info.author}`);
		if (info.pageSize) lines.push(`Page size: ${info.pageSize}`);
		lines.push(`Full extracted text cache: ${cacheTextPath}`);
		if (renderedPages.length > 0) {
			lines.push(`Rendered page image cache: ${renderedPages.map((page) => page.path).join(", ")}`);
			if (!attachRenderedImages) lines.push("Rendered images were saved but not attached because the current model does not advertise image input support.");
		}
		if (renderLimitHit) {
			lines.push(`Rendered only the first ${MAX_RENDERED_PAGES} selected pages. Narrow the pages range to render others.`);
		}
		if (sparsePages.length > 0 && renderedPages.length === 0) {
			lines.push(`Sparse extracted text on page(s): ${sparsePages.slice(0, 10).join(", ")}. Use renderPages=true for scanned or layout-heavy pages.`);
		}
		lines.push("");
		for (const entry of entries) {
			lines.push(`## Page ${entry.page}`, "", entry.text.trim() || "(no extracted text)", "");
		}
		return lines.join("\n").trimEnd();
	}

	lines.push(`${info.title || basename(pdf.absolutePath)}`);
	lines.push(`PDF: ${pdf.displayPath}`);
	lines.push(`Full extracted text cache: ${cacheTextPath}`);
	if (renderedPages.length > 0) {
		lines.push(`Rendered page image cache: ${renderedPages.map((page) => page.path).join(", ")}`);
		if (!attachRenderedImages) lines.push("Rendered images were saved but not attached because the current model does not advertise image input support.");
	}
	if (renderLimitHit) lines.push(`Rendered only the first ${MAX_RENDERED_PAGES} selected pages. Narrow the pages range to render others.`);
	if (sparsePages.length > 0 && renderedPages.length === 0) {
		lines.push(`Sparse extracted text on page(s): ${sparsePages.slice(0, 10).join(", ")}. Use renderPages=true for scanned or layout-heavy pages.`);
	}
	lines.push("");
	for (const entry of entries) {
		lines.push(`Page ${entry.page}`, entry.text.trim() || "(no extracted text)", "");
	}
	return lines.join("\n").trimEnd();
}

function truncateForTool(text: string, fullPath: string): { text: string; truncated: boolean } {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return { text: truncation.content, truncated: false };
	const notice = `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full extracted text saved to: ${fullPath}]`;
	return { text: `${truncation.content}${notice}`, truncated: true };
}

async function renderPage(pi: ExtensionAPI, pdf: ResolvedPdf, cacheKeyValue: string, page: number, dpi: number): Promise<RenderedPage> {
	await requireCommands(pi, ["pdftoppm"]);
	const pngPath = renderCachePath(cacheKeyValue, page, dpi);
	await ensureDir(dirname(pngPath));
	await withFileMutationQueue(pngPath, async () => {
		if (await exists(pngPath)) return;
		const prefix = pngPath.replace(/\.png$/i, "");
		const result = await pi.exec(
			"pdftoppm",
			["-f", String(page), "-l", String(page), "-r", String(dpi), "-png", "-singlefile", pdf.absolutePath, prefix],
			{ timeout: RENDER_TIMEOUT_MS },
		) as CommandResult;
		if (result.code !== 0) throw popplerFailure("pdftoppm", result);
	});
	const pngStat = await stat(pngPath);
	return { page, path: pngPath, bytes: pngStat.size };
}

async function renderSelectedPages(pi: ExtensionAPI, pdf: ResolvedPdf, cacheKeyValue: string, pages: number[], dpi: number): Promise<{ rendered: RenderedPage[]; limitHit: boolean }> {
	const selected = pages.slice(0, MAX_RENDERED_PAGES);
	const rendered: RenderedPage[] = [];
	for (const page of selected) {
		rendered.push(await renderPage(pi, pdf, cacheKeyValue, page, dpi));
	}
	return { rendered, limitHit: pages.length > selected.length };
}

async function renderedPageContent(renderedPages: RenderedPage[], attachImages: boolean): Promise<ToolContent[]> {
	const content: ToolContent[] = [];
	if (!attachImages) return content;
	for (const rendered of renderedPages) {
		const data = await readFile(rendered.path);
		content.push({ type: "text", text: `Rendered PDF page ${rendered.page}: ${rendered.path}` });
		content.push({ type: "image", data: data.toString("base64"), mimeType: "image/png" });
	}
	return content;
}

function formatInfoOutput(pdf: ResolvedPdf | undefined, info: ParsedPdfInfo | undefined, statuses: ToolStatus[]): string {
	const lines = [formatToolStatus(statuses)];
	if (!pdf || !info) return lines.join("\n");

	lines.push("", `# ${info.title || basename(pdf.absolutePath)}`, "");
	lines.push(`PDF: ${pdf.displayPath}`);
	lines.push(`Size: ${formatSize(pdf.size)}`);
	if (info.pages !== undefined) lines.push(`Pages: ${info.pages}`);
	if (info.encrypted !== undefined) lines.push(`Encrypted: ${info.encrypted ? "yes" : "no"}`);
	if (info.author) lines.push(`Author: ${info.author}`);
	if (info.pageSize) lines.push(`Page size: ${info.pageSize}`);
	lines.push("", "Metadata:");
	for (const [key, value] of Object.entries(info.metadata)) {
		lines.push(`- ${key}: ${value}`);
	}
	return lines.join("\n");
}

function lineSnippet(lines: string[], lineIndex: number, contextLines: number): string {
	const start = Math.max(0, lineIndex - contextLines);
	const end = Math.min(lines.length, lineIndex + contextLines + 1);
	return lines.slice(start, end).join("\n").trim();
}

function searchPageText(text: string, page: number, query: string, caseSensitive: boolean, contextLines: number, remaining: number): SearchMatch[] {
	const needle = caseSensitive ? query : query.toLowerCase();
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const matches: SearchMatch[] = [];
	for (let index = 0; index < lines.length; index++) {
		const haystack = caseSensitive ? lines[index]! : lines[index]!.toLowerCase();
		if (!haystack.includes(needle)) continue;
		matches.push({ page, line: index + 1, snippet: lineSnippet(lines, index, contextLines) });
		if (matches.length >= remaining) break;
	}
	return matches;
}

function formatSearchOutput(pdf: ResolvedPdf, query: string, pages: number[], matches: SearchMatch[], cacheTextPath: string, maxResults: number): string {
	const lines = [`# PDF search: ${query}`, ""];
	lines.push(`PDF: ${pdf.displayPath}`);
	lines.push(`Pages searched: ${pages.length === 1 ? String(pages[0]) : `${pages[0]}-${pages[pages.length - 1]} (${pages.length} pages selected)`}`);
	lines.push(`Full extracted text cache: ${cacheTextPath}`);
	lines.push(`Matches returned: ${matches.length}${matches.length >= maxResults ? ` (hit maxResults=${maxResults})` : ""}`);
	if (matches.length === 0) {
		lines.push("", "No matches found in extracted text. If this is scanned or layout-heavy, use pdf_read with renderPages=true on likely pages.");
		return lines.join("\n");
	}

	for (const match of matches) {
		lines.push("", `## Page ${match.page}, line ${match.line}`, "", "```text", match.snippet || "(empty snippet)", "```");
	}
	return lines.join("\n");
}

export default function pdfExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "pdf_info",
		label: "PDF Info",
		description: "Check Poppler PDF tooling and inspect local PDF metadata. Requires Poppler commands on PATH.",
		promptSnippet: "Check PDF tooling and inspect metadata/page count for a local PDF.",
		promptGuidelines: [
			"Use pdf_info first when you need to inspect a PDF's page count, metadata, encryption status, or Poppler tool availability.",
			"Use pdf_read and pdf_search for local .pdf files instead of trying to read PDFs as plain text.",
		],
		parameters: PdfInfoParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const statuses = await checkPoppler(pi);
			let pdf: ResolvedPdf | undefined;
			let info: ParsedPdfInfo | undefined;
			if (params.path) {
				pdf = await resolvePdfPath(ctx.cwd, params.path);
				info = await readPdfInfo(pi, pdf);
			}
			return {
				content: [{ type: "text", text: formatInfoOutput(pdf, info, statuses) }],
				details: { toolStatus: statuses, pdf, info },
			};
		},
	});

	pi.registerTool({
		name: "pdf_read",
		label: "PDF Read",
		description: `Extract text from a local PDF with Poppler and optionally render selected pages as PNG images. Output is truncated to ${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} lines; full extracted text is cached on disk.`,
		promptSnippet: "Extract text from a local PDF and optionally render pages for visual/layout understanding.",
		promptGuidelines: [
			"Use pdf_read for local .pdf files when the user asks to summarize, inspect, or quote PDF content.",
			"For long PDFs, call pdf_info first, then pdf_read with format=outline or a narrow pages range before reading the whole document.",
			"Use pdf_read with renderPages=true when extracted text is sparse, the PDF is scanned, or the user asks about layout, figures, equations, handwriting, or tables.",
			`pdf_read renders at most ${MAX_RENDERED_PAGES} pages at once; narrow the pages range for additional visual pages.`,
		],
		parameters: PdfReadParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const pdf = await resolvePdfPath(ctx.cwd, params.path);
			onUpdate?.({ content: [{ type: "text", text: `Inspecting ${pdf.displayPath}...` }], details: {} });
			const info = await readPdfInfo(pi, pdf);
			if (!info.pages) throw new Error("Unable to determine PDF page count from pdfinfo output.");
			const pages = parsePageRange(params.pages, info.pages);
			const layout = params.layout !== false;
			const format = normalizeFormat(params.format);

			onUpdate?.({ content: [{ type: "text", text: `Extracting text from ${info.pages} page(s)...` }], details: {} });
			const extraction = await extractText(pi, pdf, info.pages, layout);
			const entries = selectedTextEntries(extraction.pages, pages);

			const dpi = clampInteger(params.dpi, DEFAULT_RENDER_DPI, MIN_RENDER_DPI, MAX_RENDER_DPI);
			let renderedPages: RenderedPage[] = [];
			let renderLimitHit = false;
			if (params.renderPages) {
				onUpdate?.({ content: [{ type: "text", text: `Rendering up to ${MAX_RENDERED_PAGES} selected page(s)...` }], details: {} });
				const rendered = await renderSelectedPages(pi, pdf, extraction.cacheKey, pages, dpi);
				renderedPages = rendered.rendered;
				renderLimitHit = rendered.limitHit;
			}

			const attachRenderedImages = renderedPages.length > 0 && (ctx.model?.input.includes("image") ?? false);
			const rawOutput = formatReadOutput(pdf, info, entries, format, extraction.cacheTextPath, renderedPages, renderLimitHit, attachRenderedImages);
			const truncated = truncateForTool(rawOutput, extraction.cacheTextPath);
			const content: ToolContent[] = [{ type: "text", text: truncated.text }];
			content.push(...await renderedPageContent(renderedPages, attachRenderedImages));

			return {
				content,
				details: {
					pdf,
					info,
					selectedPages: pages,
					format,
					layout,
					cacheTextPath: extraction.cacheTextPath,
					renderedPages,
					renderLimitHit,
					truncated: truncated.truncated,
				},
			};
		},
	});

	pi.registerTool({
		name: "pdf_search",
		label: "PDF Search",
		description: "Search extracted text from a local PDF with Poppler and return page-specific snippets.",
		promptSnippet: "Search a local PDF's extracted text and return page snippets.",
		promptGuidelines: [
			"Use pdf_search to find relevant pages in a PDF before reading or rendering many pages.",
			"If pdf_search finds no results but the PDF may be scanned or visual, use pdf_read with renderPages=true on likely pages.",
		],
		parameters: PdfSearchParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const query = params.query.trim();
			if (!query) throw new Error("Search query is empty.");
			const pdf = await resolvePdfPath(ctx.cwd, params.path);
			onUpdate?.({ content: [{ type: "text", text: `Inspecting ${pdf.displayPath}...` }], details: {} });
			const info = await readPdfInfo(pi, pdf);
			if (!info.pages) throw new Error("Unable to determine PDF page count from pdfinfo output.");
			const pages = parsePageRange(params.pages, info.pages);
			const layout = params.layout !== false;
			onUpdate?.({ content: [{ type: "text", text: `Extracting searchable text from ${info.pages} page(s)...` }], details: {} });
			const extraction = await extractText(pi, pdf, info.pages, layout);

			const caseSensitive = params.caseSensitive === true;
			const contextLines = clampInteger(params.contextLines, 2, 0, 8);
			const maxResults = clampInteger(params.maxResults, DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS);
			const matches: SearchMatch[] = [];
			for (const page of pages) {
				const remaining = maxResults - matches.length;
				if (remaining <= 0) break;
				matches.push(...searchPageText(extraction.pages[page - 1] ?? "", page, query, caseSensitive, contextLines, remaining));
			}

			const output = formatSearchOutput(pdf, query, pages, matches, extraction.cacheTextPath, maxResults);
			const truncated = truncateForTool(output, extraction.cacheTextPath);
			return {
				content: [{ type: "text", text: truncated.text }],
				details: {
					pdf,
					info,
					query,
					selectedPages: pages,
					caseSensitive,
					contextLines,
					maxResults,
					matches,
					cacheTextPath: extraction.cacheTextPath,
					truncated: truncated.truncated,
				},
			};
		},
	});

	pi.registerCommand("pdf-doctor", {
		description: "Check Poppler PDF tooling used by pirot",
		handler: async (_args, ctx) => {
			const statuses = await checkPoppler(pi);
			ctx.ui.notify(formatToolStatus(statuses), statuses.some((status) => !status.available) ? "warning" : "info");
		},
	});
}
