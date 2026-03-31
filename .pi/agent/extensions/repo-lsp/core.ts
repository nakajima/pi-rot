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

const executableCache = new Map<string, string>();
const installPromptInflight = new Map<string, Promise<void>>();

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

function buildMissingServerMessage(spec: LanguageServerSpec, operation: string, pathHint?: string): string {
	const lines = [
		`Missing language server: ${spec.command}`,
		`Language: ${spec.label}`,
		`Needed for: ${formatOperation(operation)}`,
		pathHint ? `Target: ${pathHint}` : undefined,
		"Install it, then retry.",
		`Suggested install: ${spec.installCommand}`,
		spec.installUrl ? `Docs: ${spec.installUrl}` : undefined,
	].filter(Boolean);
	return lines.join("\n");
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

async function findExecutable(command: string, options?: { refresh?: boolean }): Promise<string | undefined> {
	if (!options?.refresh && executableCache.has(command)) return executableCache.get(command);

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
		for (const pathEntry of pathEntries) {
			for (const suffix of suffixes) {
				candidates.push(join(pathEntry, process.platform === "win32" && extname(command) ? command : `${command}${suffix.toLowerCase()}`));
				if (process.platform === "win32" && suffix !== suffix.toUpperCase()) {
					candidates.push(join(pathEntry, `${command}${suffix.toUpperCase()}`));
				}
			}
		}
	}

	for (const candidate of candidates) {
		const resolved = await checkExecutableCandidate(candidate);
		if (!resolved) continue;
		executableCache.set(command, resolved);
		return resolved;
	}
	return undefined;
}

async function ensureServerAvailable(spec: LanguageServerSpec, operation: string, ctx: ExtensionContext, pathHint?: string): Promise<string> {
	const existing = await findExecutable(spec.command);
	if (existing) return existing;

	let inflight = installPromptInflight.get(spec.command);
	if (!inflight) {
		const message = buildMissingServerMessage(spec, operation, pathHint);
		inflight = (async () => {
			if (!ctx.hasUI) throw new Error(message);
			const confirmed = await ctx.ui.confirm("Missing language server", `${message}\n\nPress confirm after you install it.`);
			if (!confirmed) throw new Error(message);
			const refreshed = await findExecutable(spec.command, { refresh: true });
			if (!refreshed) throw new Error(message);
		})().finally(() => {
			installPromptInflight.delete(spec.command);
		});
		installPromptInflight.set(spec.command, inflight);
	}

	await inflight;
	const resolved = await findExecutable(spec.command, { refresh: true });
	if (!resolved) throw new Error(buildMissingServerMessage(spec, operation, pathHint));
	return resolved;
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
	const commandPath = await ensureServerAvailable(spec, options.operation, options.ctx, displayPath);
	const workspaceRoot = await getWorkspaceRoot(options.pi, options.ctx.cwd, options.pathHint);
	const client = new LspClient(commandPath, spec.args, workspaceRoot);
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
}): Promise<{ results: NormalizedDiagnostic[]; workspaceRoot: string; language: SupportedLanguage; mode: "workspace" | "document" | "push"; note?: string }> {
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
}

export async function runGoToDefinition(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	path: string;
	line: number;
	column: number;
	signal?: AbortSignal;
}): Promise<{ results: NormalizedLocation[]; workspaceRoot: string; language: SupportedLanguage }> {
	const language = await inferLanguage({ cwd: options.ctx.cwd, path: options.path });
	if (!language) throw new Error(`Couldn't infer a supported language for ${options.path}`);
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
			};
		} finally {
			await closeDocument(client, uri);
		}
	} finally {
		await client.shutdown();
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
}): Promise<{ results: NormalizedLocation[]; workspaceRoot: string; language: SupportedLanguage }> {
	const language = await inferLanguage({ cwd: options.ctx.cwd, path: options.path });
	if (!language) throw new Error(`Couldn't infer a supported language for ${options.path}`);
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
			};
		} finally {
			await closeDocument(client, uri);
		}
	} finally {
		await client.shutdown();
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
}): Promise<{ results: NormalizedSymbol[]; workspaceRoot: string; language: SupportedLanguage }> {
	const language = await inferLanguage({ cwd: options.ctx.cwd, path: options.path, language: options.language });
	if (!language) {
		throw new Error("Couldn't infer a supported language server. Pass a path or language hint.");
	}
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
		};
	} finally {
		await client.shutdown();
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
