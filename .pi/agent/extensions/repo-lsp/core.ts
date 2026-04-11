import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { basename, delimiter, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const STARTUP_TIMEOUT_MS = 25_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const DIAGNOSTIC_REQUEST_TIMEOUT_MS = 30_000;
const PUSH_DIAGNOSTIC_TIMEOUT_MS = 6_000;
const PUSH_DIAGNOSTIC_SETTLE_MS = 500;
const WORKSPACE_SCAN_MAX_DEPTH = 3;
const WORKSPACE_SCAN_MAX_ENTRIES = 200;
const FALLBACK_TEXT_SEARCH_MAX_FILES = 4_000;
const FALLBACK_TEXT_SEARCH_MAX_FILE_BYTES = 512_000;
const FALLBACK_TEXT_SEARCH_MAX_RESULTS = 200;
const FALLBACK_DIAGNOSTIC_TIMEOUT_MS = 60_000;

const FALLBACK_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "target", ".build", "DerivedData", "Pods", ".swiftpm"]);
const executableCache = new Map<string, string>();

export type SupportedLanguage =
	| "typescript"
	| "javascript"
	| "python"
	| "go"
	| "rust"
	| "swift"
	| "c"
	| "cpp"
	| "objective-c"
	| "objective-cpp"
	| "lua"
	| "yaml"
	| "json"
	| "shell";

export interface NormalizedLocation {
	uri: string;
	path?: string;
	line?: number;
	column?: number;
	endLine?: number;
	endColumn?: number;
}

export interface NormalizedSymbol {
	name: string;
	kind?: string;
	containerName?: string;
	uri?: string;
	path?: string;
	line?: number;
	column?: number;
}

export interface NormalizedDiagnosticRelatedInformation {
	message: string;
	uri: string;
	path?: string;
	line?: number;
	column?: number;
}

export interface NormalizedDiagnostic {
	uri: string;
	path?: string;
	line?: number;
	column?: number;
	endLine?: number;
	endColumn?: number;
	severity?: "error" | "warning" | "information" | "hint";
	code?: string;
	source?: string;
	message: string;
	relatedInformation?: NormalizedDiagnosticRelatedInformation[];
}

interface LanguageServerSpec {
	language: SupportedLanguage;
	label: string;
	command: string;
	args: string[];
	installCommand: string;
	installUrl?: string;
	capabilityKeys: {
		definition?: string;
		references?: string;
		workspaceSymbol?: string;
	};
	languageIdForFile(path: string): string | undefined;
}

interface LspUnavailableNotice {
	language: SupportedLanguage;
	label: string;
	command: string;
	operation: string;
	pathHint?: string;
	reason: string;
	installCommand: string;
	installUrl?: string;
}

class LspUnavailableError extends Error {
	readonly notice: LspUnavailableNotice;

	constructor(notice: LspUnavailableNotice) {
		super(notice.reason);
		this.name = "LspUnavailableError";
		this.notice = notice;
	}
}

interface FallbackDefinitionCandidate {
	name: string;
	kind?: string;
	containerName?: string;
	path: string;
	line: number;
	column: number;
	lineText: string;
}

interface DefinitionExtractor {
	kind: string;
	regex: RegExp;
	nameGroup?: number;
}

interface FallbackDiagnosticRun {
	results: NormalizedDiagnostic[];
	checker?: string;
	note?: string;
}

const SYMBOL_KIND: Record<number, string> = {
	1: "File",
	2: "Module",
	3: "Namespace",
	4: "Package",
	5: "Class",
	6: "Method",
	7: "Property",
	8: "Field",
	9: "Constructor",
	10: "Enum",
	11: "Interface",
	12: "Function",
	13: "Variable",
	14: "Constant",
	15: "String",
	16: "Number",
	17: "Boolean",
	18: "Array",
	19: "Object",
	20: "Key",
	21: "Null",
	22: "EnumMember",
	23: "Struct",
	24: "Event",
	25: "Operator",
	26: "TypeParameter",
};

const SERVER_SPECS: LanguageServerSpec[] = [
	{
		language: "typescript",
		label: "TypeScript / JavaScript",
		command: "typescript-language-server",
		args: ["--stdio"],
		installCommand: "npm install -g typescript typescript-language-server",
		installUrl: "https://github.com/typescript-language-server/typescript-language-server",
		capabilityKeys: {
			definition: "definitionProvider",
			references: "referencesProvider",
			workspaceSymbol: "workspaceSymbolProvider",
		},
		languageIdForFile(path) {
			const ext = extname(path).toLowerCase();
			if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "typescript";
			if (ext === ".tsx") return "typescriptreact";
			if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "javascript";
			if (ext === ".jsx") return "javascriptreact";
			return undefined;
		},
	},
	{
		language: "javascript",
		label: "TypeScript / JavaScript",
		command: "typescript-language-server",
		args: ["--stdio"],
		installCommand: "npm install -g typescript typescript-language-server",
		installUrl: "https://github.com/typescript-language-server/typescript-language-server",
		capabilityKeys: {
			definition: "definitionProvider",
			references: "referencesProvider",
			workspaceSymbol: "workspaceSymbolProvider",
		},
		languageIdForFile(path) {
			const ext = extname(path).toLowerCase();
			if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "typescript";
			if (ext === ".tsx") return "typescriptreact";
			if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "javascript";
			if (ext === ".jsx") return "javascriptreact";
			return undefined;
		},
	},
	{
		language: "python",
		label: "Python",
		command: "pyright-langserver",
		args: ["--stdio"],
		installCommand: "npm install -g pyright",
		installUrl: "https://github.com/microsoft/pyright",
		capabilityKeys: {
			definition: "definitionProvider",
			references: "referencesProvider",
			workspaceSymbol: "workspaceSymbolProvider",
		},
		languageIdForFile() {
			return "python";
		},
	},
	{
		language: "go",
		label: "Go",
		command: "gopls",
		args: [],
		installCommand: "go install golang.org/x/tools/gopls@latest",
		installUrl: "https://pkg.go.dev/golang.org/x/tools/gopls",
		capabilityKeys: {
			definition: "definitionProvider",
			references: "referencesProvider",
			workspaceSymbol: "workspaceSymbolProvider",
		},
		languageIdForFile() {
			return "go";
		},
	},
	{
		language: "rust",
		label: "Rust",
		command: "rust-analyzer",
		args: [],
		installCommand: "rustup component add rust-analyzer",
		installUrl: "https://rust-analyzer.github.io/",
		capabilityKeys: {
			definition: "definitionProvider",
			references: "referencesProvider",
			workspaceSymbol: "workspaceSymbolProvider",
		},
		languageIdForFile() {
			return "rust";
		},
	},
	{
		language: "swift",
		label: "Swift",
		command: "sourcekit-lsp",
		args: [],
		installCommand: "Install Xcode or a Swift toolchain that bundles sourcekit-lsp",
		installUrl: "https://github.com/swiftlang/sourcekit-lsp",
		capabilityKeys: {
			definition: "definitionProvider",
			references: "referencesProvider",
			workspaceSymbol: "workspaceSymbolProvider",
		},
		languageIdForFile() {
			return "swift";
		},
	},
	{
		language: "c",
		label: "C / C++ / Objective-C",
		command: "clangd",
		args: [],
		installCommand: "Install clangd via your package manager, e.g. brew install llvm",
		installUrl: "https://clangd.llvm.org/",
		capabilityKeys: {
			definition: "definitionProvider",
			references: "referencesProvider",
			workspaceSymbol: "workspaceSymbolProvider",
		},
		languageIdForFile(path) {
			const ext = extname(path).toLowerCase();
			if (ext === ".c" || ext === ".h") return "c";
			if (ext === ".m") return "objective-c";
			return undefined;
		},
	},
	{
		language: "cpp",
		label: "C / C++ / Objective-C",
		command: "clangd",
		args: [],
		installCommand: "Install clangd via your package manager, e.g. brew install llvm",
		installUrl: "https://clangd.llvm.org/",
		capabilityKeys: {
			definition: "definitionProvider",
			references: "referencesProvider",
			workspaceSymbol: "workspaceSymbolProvider",
		},
		languageIdForFile(path) {
			const ext = extname(path).toLowerCase();
			if ([".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"].includes(ext)) return "cpp";
			return undefined;
		},
	},
	{
		language: "objective-c",
		label: "C / C++ / Objective-C",
		command: "clangd",
		args: [],
		installCommand: "Install clangd via your package manager, e.g. brew install llvm",
		installUrl: "https://clangd.llvm.org/",
		capabilityKeys: {
			definition: "definitionProvider",
			references: "referencesProvider",
			workspaceSymbol: "workspaceSymbolProvider",
		},
		languageIdForFile(path) {
			const ext = extname(path).toLowerCase();
			if (ext === ".m") return "objective-c";
			return undefined;
		},
	},
	{
		language: "objective-cpp",
		label: "C / C++ / Objective-C",
		command: "clangd",
		args: [],
		installCommand: "Install clangd via your package manager, e.g. brew install llvm",
		installUrl: "https://clangd.llvm.org/",
		capabilityKeys: {
			definition: "definitionProvider",
			references: "referencesProvider",
			workspaceSymbol: "workspaceSymbolProvider",
		},
		languageIdForFile(path) {
			const ext = extname(path).toLowerCase();
			if (ext === ".mm") return "objective-cpp";
			return undefined;
		},
	},
	{
		language: "lua",
		label: "Lua",
		command: "lua-language-server",
		args: ["--stdio"],
		installCommand: "brew install lua-language-server",
		installUrl: "https://github.com/LuaLS/lua-language-server",
		capabilityKeys: {
			definition: "definitionProvider",
			references: "referencesProvider",
			workspaceSymbol: "workspaceSymbolProvider",
		},
		languageIdForFile() {
			return "lua";
		},
	},
	{
		language: "yaml",
		label: "YAML",
		command: "yaml-language-server",
		args: ["--stdio"],
		installCommand: "npm install -g yaml-language-server",
		installUrl: "https://github.com/redhat-developer/yaml-language-server",
		capabilityKeys: {
			definition: "definitionProvider",
			references: "referencesProvider",
			workspaceSymbol: "workspaceSymbolProvider",
		},
		languageIdForFile() {
			return "yaml";
		},
	},
	{
		language: "json",
		label: "JSON",
		command: "vscode-json-language-server",
		args: ["--stdio"],
		installCommand: "npm install -g vscode-langservers-extracted",
		installUrl: "https://github.com/microsoft/vscode/tree/main/extensions/json-language-features/server",
		capabilityKeys: {
			definition: "definitionProvider",
			references: "referencesProvider",
			workspaceSymbol: "workspaceSymbolProvider",
		},
		languageIdForFile() {
			return "json";
		},
	},
	{
		language: "shell",
		label: "Shell",
		command: "bash-language-server",
		args: ["start"],
		installCommand: "npm install -g bash-language-server",
		installUrl: "https://github.com/bash-lsp/bash-language-server",
		capabilityKeys: {
			definition: "definitionProvider",
			references: "referencesProvider",
			workspaceSymbol: "workspaceSymbolProvider",
		},
		languageIdForFile() {
			return "shellscript";
		},
	},
];

const SPEC_BY_LANGUAGE = new Map<SupportedLanguage, LanguageServerSpec>(SERVER_SPECS.map((spec) => [spec.language, spec]));

const LANGUAGE_EXTENSIONS: Record<SupportedLanguage, string[]> = {
	typescript: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
	javascript: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"],
	python: [".py"],
	go: [".go"],
	rust: [".rs"],
	swift: [".swift"],
	c: [".c", ".h", ".m"],
	cpp: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
	"objective-c": [".m", ".h"],
	"objective-cpp": [".mm", ".hpp", ".hh", ".hxx"],
	lua: [".lua"],
	yaml: [".yaml", ".yml"],
	json: [".json", ".jsonc"],
	shell: [".sh", ".bash", ".zsh"],
};

function normalizeAtPath(path: string): string {
	return path.replace(/^@+/, "");
}

function formatOperation(operation: string): string {
	return operation.replace(/_/g, " ");
}

function isTruthyCapability(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (value && typeof value === "object") return true;
	return false;
}

function getCapabilityValue(capabilities: Record<string, unknown>, key: string | undefined): unknown {
	if (!key) return undefined;
	const parts = key.split(".").filter(Boolean);
	let current: unknown = capabilities;
	for (const part of parts) {
		if (!current || typeof current !== "object" || !(part in current)) return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function filePathToUri(path: string): string {
	return pathToFileURL(path).toString();
}

function uriToFilePath(uri: string): string | undefined {
	try {
		if (!uri.startsWith("file:")) return undefined;
		return fileURLToPath(uri);
	} catch {
		return undefined;
	}
}

function toDisplayPath(cwd: string, path: string): string {
	const rel = relative(cwd, path).replace(/\\/g, "/");
	return rel && !rel.startsWith("../") ? rel : path;
}

function locationFromRange(uri: string, range: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } }): NormalizedLocation {
	const path = uriToFilePath(uri);
	return {
		uri,
		path,
		line: typeof range.start?.line === "number" ? range.start.line + 1 : undefined,
		column: typeof range.start?.character === "number" ? range.start.character + 1 : undefined,
		endLine: typeof range.end?.line === "number" ? range.end.line + 1 : undefined,
		endColumn: typeof range.end?.character === "number" ? range.end.character + 1 : undefined,
	};
}

function normalizeDiagnosticSeverity(value: unknown): NormalizedDiagnostic["severity"] | undefined {
	if (value === 1) return "error";
	if (value === 2) return "warning";
	if (value === 3) return "information";
	if (value === 4) return "hint";
	return undefined;
}

function severityRank(value: NormalizedDiagnostic["severity"] | undefined): number {
	if (value === "error") return 1;
	if (value === "warning") return 2;
	if (value === "information") return 3;
	if (value === "hint") return 4;
	return 99;
}

function parseSeverityFilter(value: string | undefined): NormalizedDiagnostic["severity"] | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "error") return "error";
	if (normalized === "warning" || normalized === "warn") return "warning";
	if (normalized === "information" || normalized === "info") return "information";
	if (normalized === "hint") return "hint";
	return undefined;
}

function normalizeDiagnosticsForUri(uri: string, diagnostics: unknown): NormalizedDiagnostic[] {
	if (!Array.isArray(diagnostics)) return [];
	const normalized: NormalizedDiagnostic[] = [];
	for (const item of diagnostics) {
		if (!item || typeof item !== "object") continue;
		const diagnostic = item as {
			range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } };
			severity?: number;
			code?: string | number;
			source?: string;
			message?: string;
			relatedInformation?: Array<{ location?: { uri?: string; range?: { start?: { line?: number; character?: number } } }; message?: string }>;
		};
		if (!diagnostic.range || typeof diagnostic.message !== "string") continue;
		const location = locationFromRange(uri, diagnostic.range);
		const relatedInformation = Array.isArray(diagnostic.relatedInformation)
			? diagnostic.relatedInformation.reduce<NormalizedDiagnosticRelatedInformation[]>((acc, info) => {
					if (!info?.location || typeof info.location.uri !== "string" || typeof info.message !== "string") return acc;
					const relatedLocation = locationFromRange(info.location.uri, info.location.range ?? {});
					acc.push({
						message: info.message,
						uri: info.location.uri,
						path: relatedLocation.path,
						line: relatedLocation.line,
						column: relatedLocation.column,
					});
					return acc;
				}, [])
			: undefined;
		normalized.push({
			...location,
			severity: normalizeDiagnosticSeverity(diagnostic.severity),
			code: diagnostic.code !== undefined ? String(diagnostic.code) : undefined,
			source: typeof diagnostic.source === "string" ? diagnostic.source : undefined,
			message: diagnostic.message,
			relatedInformation: relatedInformation && relatedInformation.length > 0 ? relatedInformation : undefined,
		});
	}
	return normalized;
}

function appendDocumentDiagnosticReport(uri: string, report: unknown, output: NormalizedDiagnostic[]): void {
	if (!report || typeof report !== "object") return;
	const candidate = report as {
		kind?: string;
		items?: unknown;
		relatedDocuments?: Record<string, unknown>;
	};
	if (candidate.kind === "full") {
		output.push(...normalizeDiagnosticsForUri(uri, candidate.items));
	}
	if (candidate.relatedDocuments && typeof candidate.relatedDocuments === "object") {
		for (const [relatedUri, relatedReport] of Object.entries(candidate.relatedDocuments)) {
			appendDocumentDiagnosticReport(relatedUri, relatedReport, output);
		}
	}
}

function normalizeDocumentDiagnosticReport(uri: string, report: unknown): NormalizedDiagnostic[] {
	const output: NormalizedDiagnostic[] = [];
	appendDocumentDiagnosticReport(uri, report, output);
	return output;
}

function normalizeWorkspaceDiagnosticReport(report: unknown): NormalizedDiagnostic[] {
	if (!report || typeof report !== "object") return [];
	const candidate = report as {
		items?: Array<{ uri?: string; kind?: string; items?: unknown }>;
	};
	if (!Array.isArray(candidate.items)) return [];
	const output: NormalizedDiagnostic[] = [];
	for (const item of candidate.items) {
		if (!item || typeof item.uri !== "string" || item.kind !== "full") continue;
		output.push(...normalizeDiagnosticsForUri(item.uri, item.items));
	}
	return output;
}

function dedupeDiagnostics(items: NormalizedDiagnostic[]): NormalizedDiagnostic[] {
	const seen = new Set<string>();
	const output: NormalizedDiagnostic[] = [];
	for (const item of items) {
		const key = [item.uri, item.line ?? "", item.column ?? "", item.endLine ?? "", item.endColumn ?? "", item.code ?? "", item.message].join("|");
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(item);
	}
	return output;
}

function filterDiagnostics(items: NormalizedDiagnostic[], options: { path?: string; pathIsDirectory?: boolean; severity?: string; limit: number }): NormalizedDiagnostic[] {
	const normalizedPath = options.path ? resolve(options.path).replace(/\\/g, "/") : undefined;
	const severityFilter = parseSeverityFilter(options.severity);
	const filtered = items.filter((item) => {
		if (severityFilter && severityRank(item.severity) > severityRank(severityFilter)) return false;
		if (!normalizedPath) return true;
		if (!item.path) return false;
		const normalizedItemPath = resolve(item.path).replace(/\\/g, "/");
		if (options.pathIsDirectory) return normalizedItemPath === normalizedPath || normalizedItemPath.startsWith(`${normalizedPath}/`);
		return normalizedItemPath === normalizedPath;
	});
	filtered.sort((a, b) => {
		const severityDiff = severityRank(a.severity) - severityRank(b.severity);
		if (severityDiff !== 0) return severityDiff;
		const pathDiff = (a.path ?? a.uri).localeCompare(b.path ?? b.uri);
		if (pathDiff !== 0) return pathDiff;
		const lineDiff = (a.line ?? 0) - (b.line ?? 0);
		if (lineDiff !== 0) return lineDiff;
		const columnDiff = (a.column ?? 0) - (b.column ?? 0);
		if (columnDiff !== 0) return columnDiff;
		return a.message.localeCompare(b.message);
	});
	return dedupeDiagnostics(filtered).slice(0, Math.max(1, options.limit));
}

export function normalizeLocations(value: unknown): NormalizedLocation[] {
	if (!value) return [];
	const items = Array.isArray(value) ? value : [value];
	const normalized: NormalizedLocation[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const candidate = item as {
			uri?: string;
			range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } };
			targetUri?: string;
			targetRange?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } };
			targetSelectionRange?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } };
		};
		if (typeof candidate.targetUri === "string") {
			const range = candidate.targetSelectionRange ?? candidate.targetRange;
			if (range) normalized.push(locationFromRange(candidate.targetUri, range));
			continue;
		}
		if (typeof candidate.uri === "string" && candidate.range) {
			normalized.push(locationFromRange(candidate.uri, candidate.range));
		}
	}
	return normalized;
}

export function normalizeWorkspaceSymbols(value: unknown): NormalizedSymbol[] {
	if (!Array.isArray(value)) return [];
	const normalized: NormalizedSymbol[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const symbol = item as {
			name?: string;
			kind?: number;
			containerName?: string;
			location?: { uri?: string; range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } } } | { uri?: string };
		};
		if (typeof symbol.name !== "string" || !symbol.name.trim()) continue;
		let uri: string | undefined;
		let path: string | undefined;
		let line: number | undefined;
		let column: number | undefined;
		const location = symbol.location;
		if (location && typeof location === "object" && typeof location.uri === "string") {
			uri = location.uri;
			path = uriToFilePath(uri);
			if ("range" in location && location.range) {
				line = typeof location.range.start?.line === "number" ? location.range.start.line + 1 : undefined;
				column = typeof location.range.start?.character === "number" ? location.range.start.character + 1 : undefined;
			}
		}
		normalized.push({
			name: symbol.name,
			kind: typeof symbol.kind === "number" ? (SYMBOL_KIND[symbol.kind] ?? `Kind ${symbol.kind}`) : undefined,
			containerName: typeof symbol.containerName === "string" ? symbol.containerName : undefined,
			uri,
			path,
			line,
			column,
		});
	}
	return normalized;
}

function detectLanguageFromPath(path: string): SupportedLanguage | undefined {
	const ext = extname(path).toLowerCase();
	if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "typescript";
	if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
	if (ext === ".py") return "python";
	if (ext === ".go") return "go";
	if (ext === ".rs") return "rust";
	if (ext === ".swift") return "swift";
	if (ext === ".c") return "c";
	if ([".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"].includes(ext)) return "cpp";
	if (ext === ".m") return "objective-c";
	if (ext === ".mm") return "objective-cpp";
	if (ext === ".lua") return "lua";
	if (ext === ".yaml" || ext === ".yml") return "yaml";
	if (ext === ".json" || ext === ".jsonc") return "json";
	if (ext === ".sh" || ext === ".bash" || ext === ".zsh") return "shell";
	return undefined;
}

function normalizeLanguageInput(value: string | undefined): SupportedLanguage | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	if (["ts", "tsx", "typescript"].includes(normalized)) return "typescript";
	if (["js", "jsx", "javascript", "node"].includes(normalized)) return "javascript";
	if (["py", "python"].includes(normalized)) return "python";
	if (["go", "golang"].includes(normalized)) return "go";
	if (["rs", "rust"].includes(normalized)) return "rust";
	if (["swift"].includes(normalized)) return "swift";
	if (["c"].includes(normalized)) return "c";
	if (["cpp", "c++", "cxx", "hpp"].includes(normalized)) return "cpp";
	if (["objective-c", "objc", "obj-c"].includes(normalized)) return "objective-c";
	if (["objective-cpp", "objc++", "obj-c++"].includes(normalized)) return "objective-cpp";
	if (["lua"].includes(normalized)) return "lua";
	if (["yaml", "yml"].includes(normalized)) return "yaml";
	if (["json", "jsonc"].includes(normalized)) return "json";
	if (["shell", "bash", "sh", "zsh"].includes(normalized)) return "shell";
	return undefined;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function resolveExistingPath(cwd: string, rawPath: string): Promise<string> {
	const normalized = normalizeAtPath(rawPath.trim());
	if (!normalized) throw new Error("Path cannot be empty.");
	const absolute = resolve(cwd, normalized);
	if (!(await pathExists(absolute))) throw new Error(`Path not found: ${normalized}`);
	return absolute;
}

async function scoreWorkspace(root: string): Promise<Map<SupportedLanguage, number>> {
	const scores = new Map<SupportedLanguage, number>();
	const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
	let scannedEntries = 0;

	const addScore = (language: SupportedLanguage, score: number) => {
		scores.set(language, (scores.get(language) ?? 0) + score);
	};

	while (queue.length > 0 && scannedEntries < WORKSPACE_SCAN_MAX_ENTRIES) {
		const next = queue.shift();
		if (!next) break;
		let entries;
		try {
			entries = await readdir(next.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build" || entry.name === "target") {
				continue;
			}
			scannedEntries += 1;
			const fullPath = join(next.dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name.endsWith(".xcodeproj")) addScore("swift", 8);
				if (next.depth < WORKSPACE_SCAN_MAX_DEPTH) queue.push({ dir: fullPath, depth: next.depth + 1 });
				continue;
			}
			const lower = entry.name.toLowerCase();
			if (lower === "package.json" || lower === "tsconfig.json") {
				addScore("typescript", 6);
				addScore("javascript", 5);
			}
			if (lower === "cargo.toml") addScore("rust", 8);
			if (lower === "go.mod") addScore("go", 8);
			if (lower === "pyproject.toml" || lower === "requirements.txt") addScore("python", 8);
			if (lower === "package.swift") addScore("swift", 8);
			const language = detectLanguageFromPath(fullPath);
			if (language) addScore(language, 2);
			if (scannedEntries >= WORKSPACE_SCAN_MAX_ENTRIES) break;
		}
	}

	return scores;
}

async function inferLanguage(input: { cwd: string; path?: string; language?: string }): Promise<SupportedLanguage | undefined> {
	const explicit = normalizeLanguageInput(input.language);
	if (explicit) return explicit;
	let scanRoot = input.cwd;
	if (input.path) {
		const fromPath = detectLanguageFromPath(input.path);
		if (fromPath) return fromPath;
		try {
			const info = await stat(input.path);
			scanRoot = info.isDirectory() ? input.path : dirname(input.path);
		} catch {
			// Ignore path stat failures and fall back to cwd-based detection.
		}
	}
	const scores = await scoreWorkspace(scanRoot);
	const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return ranked[0]?.[0];
}

function buildLspUnavailableNotice(spec: LanguageServerSpec, operation: string, reason: string, pathHint?: string): LspUnavailableNotice {
	return {
		language: spec.language,
		label: spec.label,
		command: spec.command,
		operation,
		pathHint,
		reason,
		installCommand: spec.installCommand,
		installUrl: spec.installUrl,
	};
}

function formatLspFallbackNote(notice: LspUnavailableNotice, fallbackDescription: string): string {
	const target = notice.pathHint ? ` for ${notice.pathHint}` : "";
	return `${notice.command} wasn't available${target}, so ${fallbackDescription}`;
}

async function checkExecutableCandidate(path: string): Promise<string | undefined> {
	try {
		const info = await stat(path);
		if (!info.isFile()) return undefined;
		await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return path;
	} catch {
		return undefined;
	}
}

async function findExecutable(command: string, options?: { refresh?: boolean; extraSearchDirs?: string[] }): Promise<string | undefined> {
	const extraSearchDirs = (options?.extraSearchDirs ?? []).filter(Boolean);
	const useCache = !options?.refresh && extraSearchDirs.length === 0;
	if (useCache && executableCache.has(command)) return executableCache.get(command);

	const candidates: string[] = [];
	if (command.includes("/") || command.includes("\\")) {
		candidates.push(command);
	} else {
		const pathEntries = (process.env.PATH ?? "")
			.split(delimiter)
			.map((entry) => entry.trim())
			.filter(Boolean);
		const suffixes = process.platform === "win32"
			? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
				.split(";")
				.filter(Boolean)
			: [""];
		const appendCandidates = (dir: string) => {
			for (const suffix of suffixes) {
				candidates.push(join(dir, process.platform === "win32" && extname(command) ? command : `${command}${suffix.toLowerCase()}`));
				if (process.platform === "win32" && suffix !== suffix.toUpperCase()) {
					candidates.push(join(dir, `${command}${suffix.toUpperCase()}`));
				}
			}
		};
		for (const dir of extraSearchDirs) appendCandidates(dir);
		for (const pathEntry of pathEntries) appendCandidates(pathEntry);
	}

	for (const candidate of new Set(candidates)) {
		const resolved = await checkExecutableCandidate(candidate);
		if (!resolved) continue;
		if (useCache) executableCache.set(command, resolved);
		return resolved;
	}
	return undefined;
}

async function ensureServerAvailable(spec: LanguageServerSpec, operation: string, pathHint?: string, workspaceRoot?: string): Promise<string> {
	const searchDirs = workspaceRoot ? [join(workspaceRoot, "node_modules", ".bin")] : [];
	const existing = await findExecutable(spec.command, { extraSearchDirs: searchDirs });
	if (existing) return existing;
	throw new LspUnavailableError(buildLspUnavailableNotice(spec, operation, `Missing language server: ${spec.command}`, pathHint));
}

class LspClient {
	private process: ReturnType<typeof spawn> | undefined;
	private stdoutBuffer = Buffer.alloc(0);
	private nextId = 1;
	private pending = new Map<number, {
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
		cleanup?: () => void;
	}>();
	private notificationListeners = new Map<string, Set<(params: unknown) => void>>();
	private stderrTail = "";
	private closed = false;

	constructor(
		private readonly commandPath: string,
		private readonly args: string[],
		private readonly cwd: string,
	) {}

	private processStdoutChunk(chunk: Buffer): void {
		this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
		while (true) {
			const headerEnd = this.stdoutBuffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const headerText = this.stdoutBuffer.subarray(0, headerEnd).toString("utf8");
			const lengthLine = headerText
				.split("\r\n")
				.find((line) => line.toLowerCase().startsWith("content-length:"));
			if (!lengthLine) throw new Error(`Invalid LSP message: missing Content-Length header from ${basename(this.commandPath)}`);
			const contentLength = Number(lengthLine.split(":")[1]?.trim());
			if (!Number.isFinite(contentLength) || contentLength < 0) {
				throw new Error(`Invalid LSP Content-Length from ${basename(this.commandPath)}: ${lengthLine}`);
			}
			const messageStart = headerEnd + 4;
			const messageEnd = messageStart + contentLength;
			if (this.stdoutBuffer.length < messageEnd) return;
			const body = this.stdoutBuffer.subarray(messageStart, messageEnd).toString("utf8");
			this.stdoutBuffer = this.stdoutBuffer.subarray(messageEnd);
			const parsed = JSON.parse(body) as { id?: number; method?: string; result?: unknown; error?: { message?: string } };
			this.handleMessage(parsed);
		}
	}

	private handleMessage(message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }): void {
		if (typeof message.id === "number") {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			clearTimeout(pending.timeout);
			pending.cleanup?.();
			if (message.error) {
				pending.reject(new Error(message.error.message || `LSP request failed for ${basename(this.commandPath)}`));
			} else {
				pending.resolve(message.result);
			}
			return;
		}
		if (typeof message.method === "string") {
			const listeners = this.notificationListeners.get(message.method);
			if (!listeners || listeners.size === 0) return;
			for (const listener of [...listeners]) listener(message.params);
		}
	}

	private send(message: Record<string, unknown>): void {
		if (!this.process?.stdin) throw new Error(`LSP process not running: ${basename(this.commandPath)}`);
		const payload = Buffer.from(JSON.stringify(message), "utf8");
		const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
		this.process.stdin.write(Buffer.concat([header, payload]));
	}

	private failPending(reason: Error): void {
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timeout);
			pending.cleanup?.();
			pending.reject(reason);
		}
	}

	onNotification(method: string, listener: (params: unknown) => void): () => void {
		const listeners = this.notificationListeners.get(method) ?? new Set<(params: unknown) => void>();
		listeners.add(listener);
		this.notificationListeners.set(method, listeners);
		return () => {
			const current = this.notificationListeners.get(method);
			if (!current) return;
			current.delete(listener);
			if (current.size === 0) this.notificationListeners.delete(method);
		};
	}

	async start(signal?: AbortSignal): Promise<void> {
		if (this.process) return;
		const proc = spawn(this.commandPath, this.args, {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		this.process = proc;

		proc.stdout?.on("data", (chunk: Buffer) => {
			try {
				this.processStdoutChunk(chunk);
			} catch (error) {
				this.failPending(error instanceof Error ? error : new Error(String(error)));
			}
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-8_000);
		});
		proc.on("error", (error) => {
			this.failPending(new Error(`Failed to start ${basename(this.commandPath)}: ${error.message}`));
		});
		proc.on("exit", (code, signalName) => {
			this.closed = true;
			const tail = this.stderrTail.trim();
			const suffix = tail ? `\n\n${tail}` : "";
			this.failPending(new Error(`${basename(this.commandPath)} exited (${signalName ?? code ?? "unknown"})${suffix}`));
		});

		if (signal) {
			const onAbort = () => {
				this.kill();
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	request(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			if (!this.process) {
				reject(new Error(`LSP process not running: ${basename(this.commandPath)}`));
				return;
			}
			let cleanup: (() => void) | undefined;
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				cleanup?.();
				reject(new Error(`LSP request timed out: ${method}`));
			}, timeoutMs);
			if (signal) {
				const abortListener = () => {
					this.pending.delete(id);
					clearTimeout(timeout);
					cleanup?.();
					reject(new Error(`LSP request aborted: ${method}`));
				};
				if (signal.aborted) {
					clearTimeout(timeout);
					reject(new Error(`LSP request aborted: ${method}`));
					return;
				}
				signal.addEventListener("abort", abortListener, { once: true });
				cleanup = () => signal.removeEventListener("abort", abortListener);
			}
			this.pending.set(id, { resolve, reject, timeout, cleanup });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	async shutdown(): Promise<void> {
		if (!this.process || this.closed) return;
		try {
			await this.request("shutdown", null, SHUTDOWN_TIMEOUT_MS);
		} catch {
			// Ignore shutdown failures and continue with exit/kill.
		}
		try {
			this.notify("exit", null);
		} catch {
			// Ignore notify failures during shutdown.
		}
		this.kill();
	}

	kill(): void {
		if (!this.process || this.closed) return;
		this.process.kill();
		this.closed = true;
	}
}

async function getWorkspaceRoot(pi: ExtensionAPI, cwd: string, pathHint?: string): Promise<string> {
	let candidate = cwd;
	if (pathHint) {
		try {
			const info = await stat(pathHint);
			candidate = info.isDirectory() ? pathHint : dirname(pathHint);
		} catch {
			candidate = dirname(pathHint);
		}
	}
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: candidate, timeout: 5_000 });
	if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
	return candidate;
}

async function initializeClient(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	operation: string;
	language: SupportedLanguage;
	pathHint?: string;
	signal?: AbortSignal;
}): Promise<{ client: LspClient; spec: LanguageServerSpec; workspaceRoot: string; capabilities: Record<string, unknown> }> {
	const spec = SPEC_BY_LANGUAGE.get(options.language);
	if (!spec) throw new Error(`Unsupported LSP language: ${options.language}`);
	const displayPath = options.pathHint ? toDisplayPath(options.ctx.cwd, options.pathHint) : undefined;
	const workspaceRoot = await getWorkspaceRoot(options.pi, options.ctx.cwd, options.pathHint);
	const commandPath = await ensureServerAvailable(spec, options.operation, displayPath, workspaceRoot);
	const client = new LspClient(commandPath, spec.args, workspaceRoot);
	try {
		await client.start(options.signal);
		const rootUri = filePathToUri(workspaceRoot);
		const initializeResult = await client.request(
			"initialize",
			{
				processId: process.pid,
				clientInfo: {
					name: "pirot-lsp",
					version: "0.1.0",
				},
				rootUri,
				workspaceFolders: [{ uri: rootUri, name: basename(workspaceRoot) }],
				capabilities: {
					workspace: {
						workspaceFolders: true,
						symbol: {
							dynamicRegistration: false,
						},
						diagnostics: {
							refreshSupport: false,
						},
					},
					textDocument: {
						definition: {
							linkSupport: true,
						},
						references: {
							dynamicRegistration: false,
						},
						diagnostic: {
							dynamicRegistration: false,
							relatedDocumentSupport: true,
							relatedInformation: true,
							codeDescriptionSupport: true,
							dataSupport: true,
							tagSupport: {
								valueSet: [1, 2],
							},
						},
						synchronization: {
							dynamicRegistration: false,
							willSave: false,
							willSaveWaitUntil: false,
							didSave: false,
						},
					},
				},
			},
			STARTUP_TIMEOUT_MS,
			options.signal,
		) as { capabilities?: Record<string, unknown> };
		client.notify("initialized", {});
		return {
			client,
			spec,
			workspaceRoot,
			capabilities: initializeResult?.capabilities ?? {},
		};
	} catch (error) {
		client.kill();
		throw error;
	}
}

function assertCapability(capabilities: Record<string, unknown>, capabilityKey: string | undefined, operation: string, label: string): void {
	if (!capabilityKey) return;
	if (isTruthyCapability(getCapabilityValue(capabilities, capabilityKey))) return;
	throw new Error(`${label} does not advertise support for ${formatOperation(operation)}.`);
}

async function openDocument(client: LspClient, spec: LanguageServerSpec, path: string): Promise<string> {
	const text = await readFile(path, "utf8");
	const uri = filePathToUri(path);
	const languageId = spec.languageIdForFile(path);
	if (!languageId) throw new Error(`Unable to determine language id for ${path}`);
	client.notify("textDocument/didOpen", {
		textDocument: {
			uri,
			languageId,
			version: 1,
			text,
		},
	});
	return uri;
}

async function closeDocument(client: LspClient, uri: string): Promise<void> {
	client.notify("textDocument/didClose", { textDocument: { uri } });
}

const FALLBACK_CONTROL_FLOW_NAMES = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"guard",
	"return",
	"case",
	"else",
	"do",
	"repeat",
	"defer",
]);

function isIdentifierChar(char: string | undefined): boolean {
	return Boolean(char && /[A-Za-z0-9_$]/.test(char));
}

function isIdentifierStartChar(char: string | undefined): boolean {
	return Boolean(char && /[A-Za-z_$]/.test(char));
}

function extractIdentifierAtTextPosition(text: string, line: number, column: number): string | undefined {
	const lines = text.split(/\r?\n/);
	const targetLine = lines[line - 1];
	if (targetLine === undefined || targetLine.length === 0) return undefined;
	let index = Math.max(0, Math.min(targetLine.length - 1, column - 1));
	if (!isIdentifierChar(targetLine[index]) && index > 0 && isIdentifierChar(targetLine[index - 1])) {
		index -= 1;
	}
	if (!isIdentifierChar(targetLine[index])) return undefined;
	let start = index;
	while (start > 0 && isIdentifierChar(targetLine[start - 1])) start -= 1;
	let end = index + 1;
	while (end < targetLine.length && isIdentifierChar(targetLine[end])) end += 1;
	const identifier = targetLine.slice(start, end);
	return isIdentifierStartChar(identifier[0]) ? identifier : undefined;
}

async function readIdentifierAtPosition(path: string, line: number, column: number): Promise<string | undefined> {
	const text = await readFile(path, "utf8");
	return extractIdentifierAtTextPosition(text, line, column);
}

function shouldIncludeFallbackFile(path: string, workspaceRoot: string, language: SupportedLanguage): boolean {
	const absolute = resolve(path);
	const relativePath = relative(workspaceRoot, absolute);
	if (!relativePath || relativePath.startsWith("..")) return false;
	if (relativePath.split(/[\\/]+/).some((segment) => FALLBACK_SKIP_DIRS.has(segment))) return false;
	const ext = extname(absolute).toLowerCase();
	if (LANGUAGE_EXTENSIONS[language].includes(ext)) return true;
	if (language === "shell" && ext === "") {
		const base = basename(absolute).toLowerCase();
		return base === "bashrc" || base === "zshrc" || base.endsWith("rc");
	}
	return false;
}

async function listWorkspaceFilesFromGit(pi: ExtensionAPI, workspaceRoot: string, language: SupportedLanguage): Promise<string[] | undefined> {
	const result = await pi.exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
		cwd: workspaceRoot,
		timeout: 10_000,
	});
	if (result.code !== 0) return undefined;
	const files: string[] = [];
	for (const line of result.stdout.split(/\r?\n/)) {
		const relativePath = line.trim();
		if (!relativePath) continue;
		const absolute = resolve(workspaceRoot, relativePath);
		if (!shouldIncludeFallbackFile(absolute, workspaceRoot, language)) continue;
		files.push(absolute);
		if (files.length >= FALLBACK_TEXT_SEARCH_MAX_FILES) break;
	}
	return files;
}

async function walkWorkspaceFiles(workspaceRoot: string, language: SupportedLanguage): Promise<string[]> {
	const files: string[] = [];
	const queue = [workspaceRoot];
	while (queue.length > 0 && files.length < FALLBACK_TEXT_SEARCH_MAX_FILES) {
		const dir = queue.shift();
		if (!dir) break;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (FALLBACK_SKIP_DIRS.has(entry.name)) continue;
				queue.push(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!shouldIncludeFallbackFile(fullPath, workspaceRoot, language)) continue;
			files.push(fullPath);
			if (files.length >= FALLBACK_TEXT_SEARCH_MAX_FILES) break;
		}
	}
	return files;
}

async function listFallbackWorkspaceFiles(pi: ExtensionAPI, workspaceRoot: string, language: SupportedLanguage): Promise<string[]> {
	const fromGit = await listWorkspaceFilesFromGit(pi, workspaceRoot, language);
	if (fromGit) return fromGit;
	return walkWorkspaceFiles(workspaceRoot, language);
}

async function readFallbackSearchFile(path: string): Promise<string | undefined> {
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size > FALLBACK_TEXT_SEARCH_MAX_FILE_BYTES) return undefined;
		const text = await readFile(path, "utf8");
		if (text.includes("\u0000")) return undefined;
		return text;
	} catch {
		return undefined;
	}
}

function normalizeFallbackSymbolName(rawName: string): { name: string; containerName?: string } {
	const separatorIndex = Math.max(rawName.lastIndexOf("."), rawName.lastIndexOf(":"));
	if (separatorIndex === -1) return { name: rawName };
	const containerName = rawName.slice(0, separatorIndex) || undefined;
	const name = rawName.slice(separatorIndex + 1);
	return { name, containerName };
}

function getDefinitionExtractors(language: SupportedLanguage): DefinitionExtractor[] {
	switch (language) {
		case "typescript":
		case "javascript":
			return [
				{ kind: "Function", regex: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/ },
				{ kind: "Class", regex: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/ },
				{ kind: "Interface", regex: /^\s*(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/ },
				{ kind: "Type", regex: /^\s*(?:export\s+)?(?:default\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/ },
				{ kind: "Enum", regex: /^\s*(?:export\s+)?(?:default\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/ },
				{ kind: "Variable", regex: /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/ },
				{ kind: "Method", regex: /^\s*(?:public|private|protected|readonly|static|async|get|set|\s)+([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^;=]*\)\s*(?::[^\{=]+)?\s*\{/ },
			];
		case "python":
			return [
				{ kind: "Function", regex: /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
				{ kind: "Class", regex: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
				{ kind: "Variable", regex: /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/ },
			];
		case "go":
			return [
				{ kind: "Function", regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\b/ },
				{ kind: "Type", regex: /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
				{ kind: "Variable", regex: /^\s*(?:var|const)\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
			];
		case "rust":
			return [
				{ kind: "Function", regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
				{ kind: "Type", regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|mod|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
			];
		case "swift":
			return [
				{ kind: "Function", regex: /^\s*(?:@\w+\s+)*(?:public|private|fileprivate|internal|open|final|override|static|class|mutating|nonmutating|required|convenience|indirect|lazy|prefix|postfix|infix|\s)*func\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
				{ kind: "Class", regex: /^\s*(?:public|private|fileprivate|internal|open|final|\s)*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
				{ kind: "Struct", regex: /^\s*(?:public|private|fileprivate|internal|open|final|\s)*struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
				{ kind: "Enum", regex: /^\s*(?:public|private|fileprivate|internal|open|final|\s)*enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
				{ kind: "Protocol", regex: /^\s*(?:public|private|fileprivate|internal|open|\s)*protocol\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
				{ kind: "Actor", regex: /^\s*(?:public|private|fileprivate|internal|open|final|\s)*actor\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
				{ kind: "TypeAlias", regex: /^\s*(?:public|private|fileprivate|internal|open|\s)*typealias\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
				{ kind: "Variable", regex: /^\s*(?:public|private|fileprivate|internal|open|static|class|lazy|\s)*(?:let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
			];
		case "c":
		case "cpp":
		case "objective-c":
		case "objective-cpp":
			return [
				{ kind: "Type", regex: /^\s*(?:class|struct|enum|namespace)\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
				{ kind: "Class", regex: /^\s*@(?:interface|implementation)\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
				{ kind: "Function", regex: /^\s*(?:[A-Za-z_][A-Za-z0-9_:<>,*&\s]+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|$)/ },
			];
		case "lua":
			return [
				{ kind: "Function", regex: /^\s*(?:local\s+)?function\s+([A-Za-z_][A-Za-z0-9_:.]*)\b/ },
				{ kind: "Variable", regex: /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/ },
			];
		case "yaml":
			return [{ kind: "Property", regex: /^\s*([A-Za-z0-9_.-]+)\s*:/ }];
		case "json":
			return [{ kind: "Property", regex: /^\s*"([A-Za-z0-9_.-]+)"\s*:/ }];
		case "shell":
			return [
				{ kind: "Function", regex: /^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{/ },
				{ kind: "Variable", regex: /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/ },
			];
	}
}

function extractDefinitionCandidatesFromLine(language: SupportedLanguage, path: string, lineText: string, lineNumber: number): FallbackDefinitionCandidate[] {
	const candidates: FallbackDefinitionCandidate[] = [];
	const seen = new Set<string>();
	for (const extractor of getDefinitionExtractors(language)) {
		const match = extractor.regex.exec(lineText);
		if (!match) continue;
		const rawName = match[extractor.nameGroup ?? 1];
		if (typeof rawName !== "string" || !rawName.trim()) continue;
		const normalized = normalizeFallbackSymbolName(rawName.trim());
		if (!normalized.name || FALLBACK_CONTROL_FLOW_NAMES.has(normalized.name)) continue;
		const rawIndex = lineText.indexOf(rawName, Math.max(0, match.index));
		const nameIndex = lineText.indexOf(normalized.name, rawIndex === -1 ? 0 : rawIndex);
		const column = (nameIndex === -1 ? rawIndex : nameIndex) + 1;
		if (column <= 0) continue;
		const key = `${normalized.name}|${column}|${extractor.kind}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({
			name: normalized.name,
			kind: extractor.kind,
			containerName: normalized.containerName,
			path,
			line: lineNumber,
			column,
			lineText,
		});
	}
	return candidates;
}

function findIdentifierOccurrences(lineText: string, identifier: string): number[] {
	const columns: number[] = [];
	let index = 0;
	while (index < lineText.length) {
		const found = lineText.indexOf(identifier, index);
		if (found === -1) break;
		const before = found > 0 ? lineText[found - 1] : undefined;
		const after = found + identifier.length < lineText.length ? lineText[found + identifier.length] : undefined;
		if (!isIdentifierChar(before) && !isIdentifierChar(after)) {
			columns.push(found + 1);
		}
		index = found + identifier.length;
	}
	return columns;
}

function isDefinitionLineForIdentifier(language: SupportedLanguage, path: string, lineText: string, lineNumber: number, identifier: string): boolean {
	return extractDefinitionCandidatesFromLine(language, path, lineText, lineNumber).some((candidate) => candidate.name === identifier);
}

async function forEachFallbackWorkspaceFile(options: {
	pi: ExtensionAPI;
	workspaceRoot: string;
	language: SupportedLanguage;
	signal?: AbortSignal;
	visitor: (path: string, text: string) => Promise<void> | void;
}): Promise<void> {
	const files = await listFallbackWorkspaceFiles(options.pi, options.workspaceRoot, options.language);
	for (const file of files) {
		if (options.signal?.aborted) throw new Error("Fallback search aborted.");
		const text = await readFallbackSearchFile(file);
		if (text === undefined) continue;
		await options.visitor(file, text);
	}
}

function compareFallbackDefinitionCandidates(sourcePath: string, a: FallbackDefinitionCandidate, b: FallbackDefinitionCandidate): number {
	const sameFileDiff = Number(b.path === sourcePath) - Number(a.path === sourcePath);
	if (sameFileDiff !== 0) return sameFileDiff;
	const sameBasenameDiff = Number(basename(b.path) === basename(sourcePath)) - Number(basename(a.path) === basename(sourcePath));
	if (sameBasenameDiff !== 0) return sameBasenameDiff;
	return a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column;
}

function compareFallbackReferenceLocations(sourcePath: string, a: NormalizedLocation, b: NormalizedLocation): number {
	const sameFileDiff = Number(b.path === sourcePath) - Number(a.path === sourcePath);
	if (sameFileDiff !== 0) return sameFileDiff;
	return (a.path ?? a.uri).localeCompare(b.path ?? b.uri)
		|| (a.line ?? 0) - (b.line ?? 0)
		|| (a.column ?? 0) - (b.column ?? 0);
}

async function runFallbackGoToDefinition(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	path: string;
	line: number;
	column: number;
	language: SupportedLanguage;
	notice: LspUnavailableNotice;
	signal?: AbortSignal;
}): Promise<{ results: NormalizedLocation[]; workspaceRoot: string; language: SupportedLanguage; mode: "fallback"; note: string }> {
	const identifier = await readIdentifierAtPosition(options.path, options.line, options.column);
	if (!identifier) throw new Error(`Couldn't extract an identifier at ${toDisplayPath(options.ctx.cwd, options.path)}:${options.line}:${options.column}`);
	const workspaceRoot = await getWorkspaceRoot(options.pi, options.ctx.cwd, options.path);
	const exactMatches: FallbackDefinitionCandidate[] = [];
	const insensitiveMatches: FallbackDefinitionCandidate[] = [];
	await forEachFallbackWorkspaceFile({
		pi: options.pi,
		workspaceRoot,
		language: options.language,
		signal: options.signal,
		visitor: async (file, text) => {
			const lines = text.split(/\r?\n/);
			for (let index = 0; index < lines.length; index++) {
				for (const candidate of extractDefinitionCandidatesFromLine(options.language, file, lines[index] ?? "", index + 1)) {
					if (candidate.name === identifier) exactMatches.push(candidate);
					else if (candidate.name.toLowerCase() === identifier.toLowerCase()) insensitiveMatches.push(candidate);
				}
			}
		},
	});
	const matches = (exactMatches.length > 0 ? exactMatches : insensitiveMatches)
		.sort((a, b) => compareFallbackDefinitionCandidates(options.path, a, b))
		.slice(0, FALLBACK_TEXT_SEARCH_MAX_RESULTS);
	return {
		results: matches.map((candidate) => ({
			uri: filePathToUri(candidate.path),
			path: candidate.path,
			line: candidate.line,
			column: candidate.column,
		})),
		workspaceRoot,
		language: options.language,
		mode: "fallback",
		note: formatLspFallbackNote(options.notice, `this used heuristic text search for '${identifier}' instead of symbol-aware LSP results.`),
	};
}

async function runFallbackFindReferences(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	path: string;
	line: number;
	column: number;
	includeDeclaration: boolean;
	language: SupportedLanguage;
	notice: LspUnavailableNotice;
	signal?: AbortSignal;
}): Promise<{ results: NormalizedLocation[]; workspaceRoot: string; language: SupportedLanguage; mode: "fallback"; note: string }> {
	const identifier = await readIdentifierAtPosition(options.path, options.line, options.column);
	if (!identifier) throw new Error(`Couldn't extract an identifier at ${toDisplayPath(options.ctx.cwd, options.path)}:${options.line}:${options.column}`);
	const workspaceRoot = await getWorkspaceRoot(options.pi, options.ctx.cwd, options.path);
	const results: NormalizedLocation[] = [];
	await forEachFallbackWorkspaceFile({
		pi: options.pi,
		workspaceRoot,
		language: options.language,
		signal: options.signal,
		visitor: async (file, text) => {
			const lines = text.split(/\r?\n/);
			for (let index = 0; index < lines.length; index++) {
				const lineText = lines[index] ?? "";
				const columns = findIdentifierOccurrences(lineText, identifier);
				if (columns.length === 0) continue;
				const isDefinitionLine = isDefinitionLineForIdentifier(options.language, file, lineText, index + 1, identifier);
				if (!options.includeDeclaration && isDefinitionLine) continue;
				for (const column of columns) {
					results.push({
						uri: filePathToUri(file),
						path: file,
						line: index + 1,
						column,
					});
					if (results.length >= FALLBACK_TEXT_SEARCH_MAX_RESULTS) return;
				}
				if (results.length >= FALLBACK_TEXT_SEARCH_MAX_RESULTS) return;
			}
		},
	});
	results.sort((a, b) => compareFallbackReferenceLocations(options.path, a, b));
	return {
		results,
		workspaceRoot,
		language: options.language,
		mode: "fallback",
		note: formatLspFallbackNote(options.notice, `this used heuristic text search for '${identifier}' instead of true reference analysis.`),
	};
}

async function runFallbackSymbolSearch(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	query: string;
	path?: string;
	language: SupportedLanguage;
	limit: number;
	notice: LspUnavailableNotice;
	signal?: AbortSignal;
}): Promise<{ results: NormalizedSymbol[]; workspaceRoot: string; language: SupportedLanguage; mode: "fallback"; note: string }> {
	const workspaceRoot = await getWorkspaceRoot(options.pi, options.ctx.cwd, options.path);
	const normalizedQuery = options.query.trim().toLowerCase();
	const ranked: Array<{ symbol: NormalizedSymbol; score: number }> = [];
	await forEachFallbackWorkspaceFile({
		pi: options.pi,
		workspaceRoot,
		language: options.language,
		signal: options.signal,
		visitor: async (file, text) => {
			const lines = text.split(/\r?\n/);
			for (let index = 0; index < lines.length; index++) {
				for (const candidate of extractDefinitionCandidatesFromLine(options.language, file, lines[index] ?? "", index + 1)) {
					const nameLower = candidate.name.toLowerCase();
					if (!nameLower.includes(normalizedQuery)) continue;
					let score = 60;
					if (candidate.name === options.query) score = 120;
					else if (nameLower === normalizedQuery) score = 110;
					else if (candidate.name.startsWith(options.query)) score = 100;
					else if (nameLower.startsWith(normalizedQuery)) score = 90;
					if (options.path && file === options.path) score += 15;
					ranked.push({
						symbol: {
							name: candidate.name,
							kind: candidate.kind,
							containerName: candidate.containerName,
							uri: filePathToUri(file),
							path: file,
							line: candidate.line,
							column: candidate.column,
						},
						score,
					});
				}
			}
		},
	});
	ranked.sort((a, b) => b.score - a.score
		|| a.symbol.name.localeCompare(b.symbol.name)
		|| (a.symbol.path ?? a.symbol.uri ?? "").localeCompare(b.symbol.path ?? b.symbol.uri ?? "")
		|| (a.symbol.line ?? 0) - (b.symbol.line ?? 0)
		|| (a.symbol.column ?? 0) - (b.symbol.column ?? 0));
	const deduped: NormalizedSymbol[] = [];
	const seen = new Set<string>();
	for (const entry of ranked) {
		const key = `${entry.symbol.name}|${entry.symbol.path ?? entry.symbol.uri ?? ""}|${entry.symbol.line ?? 0}|${entry.symbol.column ?? 0}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(entry.symbol);
		if (deduped.length >= Math.max(1, options.limit)) break;
	}
	return {
		results: deduped,
		workspaceRoot,
		language: options.language,
		mode: "fallback",
		note: formatLspFallbackNote(options.notice, `this used heuristic definition matching for '${options.query}' instead of LSP symbol indexing.`),
	};
}

function makeFallbackDiagnostic(path: string, message: string, severity: NormalizedDiagnostic["severity"], source: string, line?: number, column?: number): NormalizedDiagnostic {
	return {
		uri: filePathToUri(path),
		path,
		line,
		column,
		severity,
		source,
		message,
	};
}

function lineColumnFromOffset(text: string, offset: number): { line: number; column: number } {
	const clamped = Math.max(0, Math.min(text.length, offset));
	let line = 1;
	let column = 1;
	for (let index = 0; index < clamped; index++) {
		if (text[index] === "\n") {
			line += 1;
			column = 1;
		} else {
			column += 1;
		}
	}
	return { line, column };
}

function resolveDiagnosticPath(cwd: string, rawPath: string, defaultPath?: string): string {
	const cleaned = rawPath.replace(/^['"]|['"]$/g, "").trim();
	if (!cleaned || cleaned === "<stdin>") return defaultPath ?? resolve(cwd, rawPath);
	if (cleaned.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cleaned)) return resolve(cleaned);
	return resolve(cwd, cleaned);
}

function parseGenericDiagnostics(output: string, cwd: string, source: string, defaultPath?: string): NormalizedDiagnostic[] {
	const diagnostics: NormalizedDiagnostic[] = [];
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		let match = /^(.*)\((\d+),(\d+)\):\s*(error|warning|note)\s*(?:[A-Z]+\d+:)?\s*(.+)$/.exec(line);
		if (match) {
			const [, rawPath, rawLineNumber, rawColumn, level, message] = match;
			const severity = level === "warning" ? "warning" : level === "note" ? "information" : "error";
			diagnostics.push(makeFallbackDiagnostic(resolveDiagnosticPath(cwd, rawPath, defaultPath), message.trim(), severity, source, Number(rawLineNumber), Number(rawColumn)));
			continue;
		}
		match = /^(.*):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/.exec(line);
		if (match) {
			const [, rawPath, rawLineNumber, rawColumn, level, message] = match;
			const severity = level === "warning" ? "warning" : level === "note" ? "information" : "error";
			diagnostics.push(makeFallbackDiagnostic(resolveDiagnosticPath(cwd, rawPath, defaultPath), message.trim(), severity, source, Number(rawLineNumber), Number(rawColumn)));
			continue;
		}
		match = /^(.*):(\d+):\s*(error|warning|note):\s*(.+)$/.exec(line);
		if (match) {
			const [, rawPath, rawLineNumber, level, message] = match;
			const severity = level === "warning" ? "warning" : level === "note" ? "information" : "error";
			diagnostics.push(makeFallbackDiagnostic(resolveDiagnosticPath(cwd, rawPath, defaultPath), message.trim(), severity, source, Number(rawLineNumber)));
			continue;
		}
		match = /^(.*): line (\d+):\s*(.+)$/.exec(line);
		if (match) {
			const [, rawPath, rawLineNumber, message] = match;
			diagnostics.push(makeFallbackDiagnostic(resolveDiagnosticPath(cwd, rawPath, defaultPath), message.trim(), "error", source, Number(rawLineNumber)));
		}
	}
	return dedupeDiagnostics(diagnostics);
}

function findLastMatchingLine(lines: string[], predicate: (line: string) => boolean): string | undefined {
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index];
		if (predicate(line)) return line;
	}
	return undefined;
}

function parseNodeCheckDiagnostics(output: string, path: string, source: string): NormalizedDiagnostic[] {
	const lines = output.split(/\r?\n/).filter(Boolean);
	if (lines.length === 0) return [];
	const locationLine = lines.find((line) => /:\d+$/.test(line));
	const locationMatch = locationLine ? /^(.*):(\d+)$/.exec(locationLine) : undefined;
	const lineNumber = locationMatch ? Number(locationMatch[2]) : undefined;
	const caretLine = lines.find((line) => /^\s*\^\s*$/.test(line));
	const column = caretLine ? caretLine.indexOf("^") + 1 : undefined;
	const messageLine = findLastMatchingLine(lines, (line) => line.includes("SyntaxError:")) ?? lines[lines.length - 1] ?? "Syntax error";
	return [makeFallbackDiagnostic(path, messageLine.replace(/^SyntaxError:\s*/, "").trim(), "error", source, lineNumber, column)];
}

function parsePythonCompileDiagnostics(output: string, path: string, source: string): NormalizedDiagnostic[] {
	const lines = output.split(/\r?\n/).filter(Boolean);
	const locationLine = lines.find((line) => line.includes('File "'));
	const locationMatch = locationLine ? /File "(.*)", line (\d+)/.exec(locationLine) : undefined;
	const lineNumber = locationMatch ? Number(locationMatch[2]) : undefined;
	const message = findLastMatchingLine(lines, (line) => /Error|Exception/.test(line)) ?? lines[lines.length - 1] ?? "Python syntax error";
	return [makeFallbackDiagnostic(path, message.trim(), "error", source, lineNumber)];
}

async function findAncestorFile(startDir: string, fileName: string, workspaceRoot: string): Promise<string | undefined> {
	let current = startDir;
	while (true) {
		const candidate = join(current, fileName);
		if (await pathExists(candidate)) return candidate;
		if (current === workspaceRoot) return undefined;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

async function runFallbackChecker(pi: ExtensionAPI, commandPath: string, args: string[], cwd: string): Promise<{ code: number; output: string; checker: string }> {
	const result = await pi.exec(commandPath, args, {
		cwd,
		timeout: FALLBACK_DIAGNOSTIC_TIMEOUT_MS,
	});
	const output = [result.stdout, result.stderr].map((value) => value.trim()).filter(Boolean).join("\n");
	return {
		code: result.code,
		output,
		checker: basename(commandPath),
	};
}

async function runJsonSyntaxFallback(path: string): Promise<FallbackDiagnosticRun> {
	const text = await readFile(path, "utf8");
	try {
		JSON.parse(text);
		return { results: [], checker: "json" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const positionMatch = /position (\d+)/i.exec(message);
		const location = positionMatch ? lineColumnFromOffset(text, Number(positionMatch[1])) : undefined;
		return {
			results: [makeFallbackDiagnostic(path, message.trim(), "error", "json", location?.line, location?.column)],
			checker: "json",
		};
	}
}

async function runTypeScriptFallbackDiagnostics(pi: ExtensionAPI, workspaceRoot: string, path: string): Promise<FallbackDiagnosticRun | undefined> {
	const tscPath = await findExecutable("tsc", { extraSearchDirs: [join(workspaceRoot, "node_modules", ".bin")] });
	if (!tscPath) return undefined;
	const tsconfigPath = await findAncestorFile(dirname(path), "tsconfig.json", workspaceRoot);
	const cwd = tsconfigPath ? dirname(tsconfigPath) : workspaceRoot;
	const args = tsconfigPath
		? ["--pretty", "false", "--noEmit", "-p", tsconfigPath]
		: ["--pretty", "false", "--noEmit", path];
	const result = await runFallbackChecker(pi, tscPath, args, cwd);
	if (result.code === 0) {
		return {
			results: [],
			checker: result.checker,
			note: tsconfigPath ? `Used ${relative(workspaceRoot, tsconfigPath) || basename(tsconfigPath)}.` : "Checked the file without project config.",
		};
	}
	const diagnostics = parseGenericDiagnostics(result.output, cwd, result.checker, path);
	return {
		results: diagnostics.length > 0 ? diagnostics : [makeFallbackDiagnostic(path, result.output || "TypeScript check failed", "error", result.checker)],
		checker: result.checker,
		note: tsconfigPath ? `Used ${relative(workspaceRoot, tsconfigPath) || basename(tsconfigPath)}.` : "Checked the file without project config.",
	};
}

async function runJavaScriptFallbackDiagnostics(pi: ExtensionAPI, workspaceRoot: string, path: string): Promise<FallbackDiagnosticRun | undefined> {
	const nodePath = await findExecutable("node");
	if (!nodePath) return undefined;
	const result = await runFallbackChecker(pi, nodePath, ["--check", path], workspaceRoot);
	if (result.code === 0) return { results: [], checker: `${result.checker} --check` };
	return {
		results: parseNodeCheckDiagnostics(result.output, path, `${result.checker} --check`),
		checker: `${result.checker} --check`,
	};
}

async function runPythonFallbackDiagnostics(pi: ExtensionAPI, workspaceRoot: string, path: string): Promise<FallbackDiagnosticRun | undefined> {
	const pythonPath = await findExecutable("python3") ?? await findExecutable("python");
	if (!pythonPath) return undefined;
	const result = await runFallbackChecker(pi, pythonPath, ["-m", "py_compile", path], workspaceRoot);
	if (result.code === 0) return { results: [], checker: `${result.checker} -m py_compile` };
	return {
		results: parsePythonCompileDiagnostics(result.output, path, `${result.checker} -m py_compile`),
		checker: `${result.checker} -m py_compile`,
	};
}

async function runShellFallbackDiagnostics(pi: ExtensionAPI, workspaceRoot: string, path: string): Promise<FallbackDiagnosticRun | undefined> {
	const bashPath = await findExecutable("bash");
	if (!bashPath) return undefined;
	const result = await runFallbackChecker(pi, bashPath, ["-n", path], workspaceRoot);
	if (result.code === 0) return { results: [], checker: `${result.checker} -n` };
	const diagnostics = parseGenericDiagnostics(result.output, workspaceRoot, `${result.checker} -n`, path);
	return {
		results: diagnostics.length > 0 ? diagnostics : [makeFallbackDiagnostic(path, result.output || "Shell syntax check failed", "error", `${result.checker} -n`)],
		checker: `${result.checker} -n`,
	};
}

async function runLuaFallbackDiagnostics(pi: ExtensionAPI, workspaceRoot: string, path: string): Promise<FallbackDiagnosticRun | undefined> {
	const luacPath = await findExecutable("luac");
	if (!luacPath) return undefined;
	const result = await runFallbackChecker(pi, luacPath, ["-p", path], workspaceRoot);
	if (result.code === 0) return { results: [], checker: `${result.checker} -p` };
	const diagnostics = parseGenericDiagnostics(result.output, workspaceRoot, `${result.checker} -p`, path);
	return {
		results: diagnostics.length > 0 ? diagnostics : [makeFallbackDiagnostic(path, result.output || "Lua syntax check failed", "error", `${result.checker} -p`)],
		checker: `${result.checker} -p`,
	};
}

async function runSwiftFallbackDiagnostics(pi: ExtensionAPI, workspaceRoot: string, path: string): Promise<FallbackDiagnosticRun | undefined> {
	const swiftcPath = await findExecutable("swiftc");
	if (swiftcPath) {
		const result = await runFallbackChecker(pi, swiftcPath, ["-typecheck", path], workspaceRoot);
		if (result.code === 0) return { results: [], checker: `${result.checker} -typecheck` };
		const diagnostics = parseGenericDiagnostics(result.output, workspaceRoot, `${result.checker} -typecheck`, path);
		return {
			results: diagnostics.length > 0 ? diagnostics : [makeFallbackDiagnostic(path, result.output || "Swift typecheck failed", "error", `${result.checker} -typecheck`)],
			checker: `${result.checker} -typecheck`,
		};
	}
	const xcrunPath = await findExecutable("xcrun");
	if (!xcrunPath) return undefined;
	const result = await runFallbackChecker(pi, xcrunPath, ["swiftc", "-typecheck", path], workspaceRoot);
	if (result.code === 0) return { results: [], checker: `${result.checker} swiftc -typecheck` };
	const diagnostics = parseGenericDiagnostics(result.output, workspaceRoot, `${result.checker} swiftc -typecheck`, path);
	return {
		results: diagnostics.length > 0 ? diagnostics : [makeFallbackDiagnostic(path, result.output || "Swift typecheck failed", "error", `${result.checker} swiftc -typecheck`)],
		checker: `${result.checker} swiftc -typecheck`,
	};
}

async function runSingleFileFallbackDiagnostics(options: {
	pi: ExtensionAPI;
	workspaceRoot: string;
	language: SupportedLanguage;
	path: string;
}): Promise<FallbackDiagnosticRun | undefined> {
	switch (options.language) {
		case "json":
			return runJsonSyntaxFallback(options.path);
		case "typescript":
			return runTypeScriptFallbackDiagnostics(options.pi, options.workspaceRoot, options.path);
		case "javascript":
			return runJavaScriptFallbackDiagnostics(options.pi, options.workspaceRoot, options.path);
		case "python":
			return runPythonFallbackDiagnostics(options.pi, options.workspaceRoot, options.path);
		case "shell":
			return runShellFallbackDiagnostics(options.pi, options.workspaceRoot, options.path);
		case "lua":
			return runLuaFallbackDiagnostics(options.pi, options.workspaceRoot, options.path);
		case "swift":
			return runSwiftFallbackDiagnostics(options.pi, options.workspaceRoot, options.path);
		default:
			return undefined;
	}
}

async function runFallbackWorkspaceDiagnostics(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	path?: string;
	language: SupportedLanguage;
	severity?: string;
	limit: number;
	notice: LspUnavailableNotice;
}): Promise<{ results: NormalizedDiagnostic[]; workspaceRoot: string; language: SupportedLanguage; mode: "fallback"; note: string }> {
	const workspaceRoot = await getWorkspaceRoot(options.pi, options.ctx.cwd, options.path);
	let pathIsFile = false;
	let pathIsDirectory = false;
	if (options.path) {
		try {
			const info = await stat(options.path);
			pathIsFile = info.isFile();
			pathIsDirectory = info.isDirectory();
		} catch {
			pathIsFile = false;
			pathIsDirectory = false;
		}
	}
	if (!options.path || !pathIsFile) {
		const suggestion = " Provide a file path for a best-effort syntax check.";
		return {
			results: [],
			workspaceRoot,
			language: options.language,
			mode: "fallback",
			note: `${formatLspFallbackNote(options.notice, "this could not use LSP diagnostics.")}${suggestion}`,
		};
	}
	const fallback = await runSingleFileFallbackDiagnostics({
		pi: options.pi,
		workspaceRoot,
		language: options.language,
		path: options.path,
	});
	if (!fallback) {
		return {
			results: [],
			workspaceRoot,
			language: options.language,
			mode: "fallback",
			note: `${formatLspFallbackNote(options.notice, "this used a limited diagnostics fallback instead of LSP diagnostics.")} No best-effort checker is configured for ${options.language} files.`,
		};
	}
	const results = filterDiagnostics(fallback.results, {
		path: options.path,
		pathIsDirectory: false,
		severity: options.severity,
		limit: options.limit,
	});
	const checkerNote = fallback.checker ? ` Used ${fallback.checker}.` : "";
	const extraNote = fallback.note ? ` ${fallback.note}` : "";
	return {
		results,
		workspaceRoot,
		language: options.language,
		mode: "fallback",
		note: `${formatLspFallbackNote(options.notice, "this used a best-effort fallback instead of LSP diagnostics.")}${checkerNote}${extraNote}`.trim(),
	};
}

async function waitForNotificationSequence(
	client: LspClient,
	method: string,
	predicate: (params: unknown) => boolean,
	options?: { timeoutMs?: number; settleMs?: number; signal?: AbortSignal },
): Promise<{ received: boolean; params?: unknown }> {
	const timeoutMs = options?.timeoutMs ?? PUSH_DIAGNOSTIC_TIMEOUT_MS;
	const settleMs = options?.settleMs ?? PUSH_DIAGNOSTIC_SETTLE_MS;
	return new Promise((resolve, reject) => {
		let latest: unknown;
		let received = false;
		let settled = false;
		let settleTimer: ReturnType<typeof setTimeout> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let cleanupSignal: (() => void) | undefined;
		let removeListener: (() => void) | undefined;

		const cleanup = () => {
			if (settleTimer) clearTimeout(settleTimer);
			if (timeout) clearTimeout(timeout);
			cleanupSignal?.();
			removeListener?.();
		};

		const finish = (value: { received: boolean; params?: unknown }) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		removeListener = client.onNotification(method, (params) => {
			if (!predicate(params)) return;
			received = true;
			latest = params;
			if (settleTimer) clearTimeout(settleTimer);
			settleTimer = setTimeout(() => finish({ received: true, params: latest }), settleMs);
		});

		timeout = setTimeout(() => finish(received ? { received: true, params: latest } : { received: false }), timeoutMs);

		if (options?.signal) {
			const abortListener = () => fail(new Error(`LSP notification wait aborted: ${method}`));
			if (options.signal.aborted) {
				abortListener();
				return;
			}
			options.signal.addEventListener("abort", abortListener, { once: true });
			cleanupSignal = () => options.signal?.removeEventListener("abort", abortListener);
		}
	});
}

async function requestDocumentDiagnostics(options: {
	client: LspClient;
	uri: string;
	identifier?: string;
	signal?: AbortSignal;
}): Promise<NormalizedDiagnostic[]> {
	const result = await options.client.request(
		"textDocument/diagnostic",
		{
			textDocument: { uri: options.uri },
			identifier: options.identifier,
		},
		DIAGNOSTIC_REQUEST_TIMEOUT_MS,
		options.signal,
	);
	return normalizeDocumentDiagnosticReport(options.uri, result);
}

async function waitForPublishedDiagnostics(options: {
	client: LspClient;
	uri: string;
	signal?: AbortSignal;
}): Promise<{ diagnostics: NormalizedDiagnostic[]; received: boolean }> {
	const notification = await waitForNotificationSequence(
		options.client,
		"textDocument/publishDiagnostics",
		(params) => {
			if (!params || typeof params !== "object") return false;
			return (params as { uri?: string }).uri === options.uri;
		},
		{ signal: options.signal },
	);
	if (!notification.received || !notification.params || typeof notification.params !== "object") {
		return { diagnostics: [], received: false };
	}
	const payload = notification.params as { uri?: string; diagnostics?: unknown };
	if (typeof payload.uri !== "string") return { diagnostics: [], received: false };
	return {
		diagnostics: normalizeDiagnosticsForUri(payload.uri, payload.diagnostics),
		received: true,
	};
}

export async function runWorkspaceDiagnostics(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	path?: string;
	language?: string;
	severity?: string;
	limit: number;
	signal?: AbortSignal;
}): Promise<{ results: NormalizedDiagnostic[]; workspaceRoot: string; language: SupportedLanguage; mode: "workspace" | "document" | "push" | "fallback"; note?: string }> {
	const language = await inferLanguage({ cwd: options.ctx.cwd, path: options.path, language: options.language });
	if (!language) {
		throw new Error("Couldn't infer a supported language server. Pass a path or language hint.");
	}
	let pathIsDirectory = false;
	let pathIsFile = false;
	if (options.path) {
		try {
			const info = await stat(options.path);
			pathIsDirectory = info.isDirectory();
			pathIsFile = info.isFile();
		} catch {
			pathIsDirectory = false;
			pathIsFile = false;
		}
	}
	try {
		const { client, spec, workspaceRoot, capabilities } = await initializeClient({
			pi: options.pi,
			ctx: options.ctx,
			operation: "workspace_diagnostics",
			language,
			pathHint: options.path,
			signal: options.signal,
		});
		try {
			const diagnosticProvider = getCapabilityValue(capabilities, "diagnosticProvider") as { identifier?: string; workspaceDiagnostics?: boolean } | undefined;
			if (diagnosticProvider?.workspaceDiagnostics) {
				const result = await client.request(
					"workspace/diagnostic",
					{
						identifier: diagnosticProvider.identifier,
						previousResultIds: [],
					},
					DIAGNOSTIC_REQUEST_TIMEOUT_MS,
					options.signal,
				);
				return {
					results: filterDiagnostics(normalizeWorkspaceDiagnosticReport(result), {
						path: options.path,
						pathIsDirectory,
						severity: options.severity,
						limit: options.limit,
					}),
					workspaceRoot,
					language,
					mode: "workspace",
				};
			}

			if (!options.path || !pathIsFile) {
				if (diagnosticProvider) {
					throw new Error(`${spec.label} does not advertise workspace diagnostics. Provide a file path to collect diagnostics for a single document.`);
				}
				throw new Error(`${spec.label} does not advertise diagnostic pull support. Provide a file path to attempt diagnostics via published notifications.`);
			}

			const uri = filePathToUri(options.path);
			const publishPromise = waitForPublishedDiagnostics({ client, uri, signal: options.signal });
			await openDocument(client, spec, options.path);
			try {
				if (diagnosticProvider) {
					try {
						const pulled = await requestDocumentDiagnostics({
							client,
							uri,
							identifier: diagnosticProvider.identifier,
							signal: options.signal,
						});
						return {
							results: filterDiagnostics(pulled, {
								path: options.path,
								pathIsDirectory: false,
								severity: options.severity,
								limit: options.limit,
							}),
							workspaceRoot,
							language,
							mode: "document",
						};
					} catch {
						// Fall back to push diagnostics below.
					}
				}
				const pushed = await publishPromise;
				return {
					results: filterDiagnostics(pushed.diagnostics, {
						path: options.path,
						pathIsDirectory: false,
						severity: options.severity,
						limit: options.limit,
					}),
					workspaceRoot,
					language,
					mode: "push",
					note: pushed.received ? undefined : `No publishDiagnostics notification arrived for ${toDisplayPath(options.ctx.cwd, options.path)} within ${Math.round(PUSH_DIAGNOSTIC_TIMEOUT_MS / 1000)}s.`,
				};
			} finally {
				await closeDocument(client, uri);
			}
		} finally {
			await client.shutdown();
		}
	} catch (error) {
		if (error instanceof LspUnavailableError) {
			return runFallbackWorkspaceDiagnostics({
				pi: options.pi,
				ctx: options.ctx,
				path: options.path,
				language,
				severity: options.severity,
				limit: options.limit,
				notice: error.notice,
			});
		}
		throw error;
	}
}

export async function runGoToDefinition(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	path: string;
	line: number;
	column: number;
	signal?: AbortSignal;
}): Promise<{ results: NormalizedLocation[]; workspaceRoot: string; language: SupportedLanguage; mode: "lsp" | "fallback"; note?: string }> {
	const language = await inferLanguage({ cwd: options.ctx.cwd, path: options.path });
	if (!language) throw new Error(`Couldn't infer a supported language for ${options.path}`);
	try {
		const { client, spec, workspaceRoot, capabilities } = await initializeClient({
			pi: options.pi,
			ctx: options.ctx,
			operation: "go_to_definition",
			language,
			pathHint: options.path,
			signal: options.signal,
		});
		try {
			assertCapability(capabilities, spec.capabilityKeys.definition, "go_to_definition", spec.label);
			const uri = await openDocument(client, spec, options.path);
			try {
				const result = await client.request(
					"textDocument/definition",
					{
						textDocument: { uri },
						position: { line: options.line - 1, character: options.column - 1 },
					},
					DEFAULT_REQUEST_TIMEOUT_MS,
					options.signal,
				);
				return {
					results: normalizeLocations(result),
					workspaceRoot,
					language,
					mode: "lsp",
				};
			} finally {
				await closeDocument(client, uri);
			}
		} finally {
			await client.shutdown();
		}
	} catch (error) {
		if (error instanceof LspUnavailableError) {
			return runFallbackGoToDefinition({
				pi: options.pi,
				ctx: options.ctx,
				path: options.path,
				line: options.line,
				column: options.column,
				language,
				notice: error.notice,
				signal: options.signal,
			});
		}
		throw error;
	}
}

export async function runFindReferences(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	path: string;
	line: number;
	column: number;
	includeDeclaration: boolean;
	signal?: AbortSignal;
}): Promise<{ results: NormalizedLocation[]; workspaceRoot: string; language: SupportedLanguage; mode: "lsp" | "fallback"; note?: string }> {
	const language = await inferLanguage({ cwd: options.ctx.cwd, path: options.path });
	if (!language) throw new Error(`Couldn't infer a supported language for ${options.path}`);
	try {
		const { client, spec, workspaceRoot, capabilities } = await initializeClient({
			pi: options.pi,
			ctx: options.ctx,
			operation: "find_references",
			language,
			pathHint: options.path,
			signal: options.signal,
		});
		try {
			assertCapability(capabilities, spec.capabilityKeys.references, "find_references", spec.label);
			const uri = await openDocument(client, spec, options.path);
			try {
				const result = await client.request(
					"textDocument/references",
					{
						textDocument: { uri },
						position: { line: options.line - 1, character: options.column - 1 },
						context: {
							includeDeclaration: options.includeDeclaration,
						},
					},
					DEFAULT_REQUEST_TIMEOUT_MS,
					options.signal,
				);
				return {
					results: normalizeLocations(result),
					workspaceRoot,
					language,
					mode: "lsp",
				};
			} finally {
				await closeDocument(client, uri);
			}
		} finally {
			await client.shutdown();
		}
	} catch (error) {
		if (error instanceof LspUnavailableError) {
			return runFallbackFindReferences({
				pi: options.pi,
				ctx: options.ctx,
				path: options.path,
				line: options.line,
				column: options.column,
				includeDeclaration: options.includeDeclaration,
				language,
				notice: error.notice,
				signal: options.signal,
			});
		}
		throw error;
	}
}

export async function runSymbolSearch(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	query: string;
	path?: string;
	language?: string;
	limit: number;
	signal?: AbortSignal;
}): Promise<{ results: NormalizedSymbol[]; workspaceRoot: string; language: SupportedLanguage; mode: "lsp" | "fallback"; note?: string }> {
	const language = await inferLanguage({ cwd: options.ctx.cwd, path: options.path, language: options.language });
	if (!language) {
		throw new Error("Couldn't infer a supported language server. Pass a path or language hint.");
	}
	try {
		const { client, spec, workspaceRoot, capabilities } = await initializeClient({
			pi: options.pi,
			ctx: options.ctx,
			operation: "symbol_search",
			language,
			pathHint: options.path,
			signal: options.signal,
		});
		try {
			assertCapability(capabilities, spec.capabilityKeys.workspaceSymbol, "symbol_search", spec.label);
			const result = await client.request(
				"workspace/symbol",
				{ query: options.query },
				DEFAULT_REQUEST_TIMEOUT_MS,
				options.signal,
			);
			return {
				results: normalizeWorkspaceSymbols(result).slice(0, Math.max(1, options.limit)),
				workspaceRoot,
				language,
				mode: "lsp",
			};
		} finally {
			await client.shutdown();
		}
	} catch (error) {
		if (error instanceof LspUnavailableError) {
			return runFallbackSymbolSearch({
				pi: options.pi,
				ctx: options.ctx,
				query: options.query,
				path: options.path,
				language,
				limit: options.limit,
				notice: error.notice,
				signal: options.signal,
			});
		}
		throw error;
	}
}

export async function resolveToolPath(ctx: ExtensionContext, rawPath: string): Promise<string> {
	return resolveExistingPath(ctx.cwd, rawPath);
}

export function formatDiagnosticSummary(cwd: string, items: NormalizedDiagnostic[], limit = 12): string {
	if (items.length === 0) return "No diagnostics found.";
	return items
		.slice(0, Math.max(1, limit))
		.map((item, index) => {
			const displayPath = item.path ? toDisplayPath(cwd, item.path) : item.uri;
			const position = item.line && item.column ? `:${item.line}:${item.column}` : "";
			const prefix = [item.severity, item.source, item.code ? `code=${item.code}` : undefined].filter(Boolean).join(" • ");
			return `${index + 1}. ${displayPath}${position} — ${prefix || "diagnostic"} — ${item.message}`;
		})
		.join("\n");
}

export function formatLocationSummary(cwd: string, items: NormalizedLocation[], limit = 12): string {
	if (items.length === 0) return "No locations found.";
	return items
		.slice(0, Math.max(1, limit))
		.map((item, index) => {
			const displayPath = item.path ? toDisplayPath(cwd, item.path) : item.uri;
			const position = item.line && item.column ? `:${item.line}:${item.column}` : "";
			return `${index + 1}. ${displayPath}${position}`;
		})
		.join("\n");
}

export function formatSymbolSummary(cwd: string, items: NormalizedSymbol[], limit = 12): string {
	if (items.length === 0) return "No symbols found.";
	return items
		.slice(0, Math.max(1, limit))
		.map((item, index) => {
			const displayPath = item.path ? toDisplayPath(cwd, item.path) : item.uri || "unknown";
			const position = item.line && item.column ? `:${item.line}:${item.column}` : "";
			const extras = [item.kind, item.containerName ? `container=${item.containerName}` : undefined].filter(Boolean).join(" • ");
			return `${index + 1}. ${item.name} — ${displayPath}${position}${extras ? ` • ${extras}` : ""}`;
		})
		.join("\n");
}
