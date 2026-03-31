import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
	formatDiagnosticSummary,
	formatLocationSummary,
	formatSymbolSummary,
	resolveToolPath,
	runFindReferences,
	runGoToDefinition,
	runSymbolSearch,
	runWorkspaceDiagnostics,
} from "./core";

const PositionParams = Type.Object({
	path: Type.String({ description: "Path to the source file. Line and column are 1-based." }),
	line: Type.Integer({ minimum: 1, description: "1-based line number." }),
	column: Type.Integer({ minimum: 1, description: "1-based column number." }),
});

const DefinitionParams = PositionParams;

const ReferencesParams = Type.Object({
	path: Type.String({ description: "Path to the source file. Line and column are 1-based." }),
	line: Type.Integer({ minimum: 1, description: "1-based line number." }),
	column: Type.Integer({ minimum: 1, description: "1-based column number." }),
	includeDeclaration: Type.Optional(Type.Boolean({ description: "Include the symbol declaration in results. Defaults to false." })),
});

const SymbolSearchParams = Type.Object({
	query: Type.String({ description: "Symbol name or partial query to search for." }),
	path: Type.Optional(Type.String({ description: "Optional file or directory path used to infer the language server and workspace." })),
	language: Type.Optional(Type.String({ description: "Optional language hint like typescript, rust, swift, go, or python." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum number of results to return. Defaults to 20." })),
});

const WorkspaceDiagnosticsParams = Type.Object({
	path: Type.Optional(Type.String({ description: "Optional file or directory path to scope diagnostics. If the server lacks workspace-wide diagnostics, provide a file path for single-file fallback." })),
	language: Type.Optional(Type.String({ description: "Optional language hint like typescript, rust, swift, go, or python." })),
	severity: Type.Optional(Type.String({ description: "Optional severity threshold: error, warning, information, or hint. For example, warning includes both errors and warnings. Defaults to all severities." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum number of diagnostics to return. Defaults to 50." })),
});

export default function repoLspExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "go_to_definition",
		label: "Go to Definition",
		description: "Resolve the definition location for a symbol at a given file position using a language server. If the required LSP is missing, prompts the user to install it.",
		promptSnippet: "Resolve symbol definitions via an LSP-backed go-to-definition request.",
		promptGuidelines: [
			"Use go_to_definition when you know the file path and cursor position of the symbol you want to navigate.",
			"If you do not yet know the exact position, use symbol_search first or inspect the file with read.",
			"If the tool reports a missing language server, ask the user to install it and then retry.",
		],
		parameters: DefinitionParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Resolving definition via LSP..." }], details: {} });
			const path = await resolveToolPath(ctx, params.path);
			const result = await runGoToDefinition({
				pi,
				ctx,
				path,
				line: params.line,
				column: params.column,
				signal,
			});
			const summary = result.results.length > 0
				? `Found ${result.results.length} definition${result.results.length === 1 ? "" : "s"}.\n${formatLocationSummary(ctx.cwd, result.results)}`
				: "No definitions found.";
			return {
				content: [{ type: "text", text: summary }],
				details: {
					language: result.language,
					workspaceRoot: result.workspaceRoot,
					results: result.results,
				},
			};
		},
	});

	pi.registerTool({
		name: "find_references",
		label: "Find References",
		description: "Find project-wide references for a symbol at a given file position using a language server. If the required LSP is missing, prompts the user to install it.",
		promptSnippet: "Find symbol references via an LSP-backed find-references request.",
		promptGuidelines: [
			"Use find_references when you know the file path and cursor position of the symbol you want to analyze.",
			"If you want only usages, leave includeDeclaration unset or false.",
			"If the tool reports a missing language server, ask the user to install it and then retry.",
		],
		parameters: ReferencesParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Finding references via LSP..." }], details: {} });
			const path = await resolveToolPath(ctx, params.path);
			const result = await runFindReferences({
				pi,
				ctx,
				path,
				line: params.line,
				column: params.column,
				includeDeclaration: Boolean(params.includeDeclaration),
				signal,
			});
			const summary = result.results.length > 0
				? `Found ${result.results.length} reference${result.results.length === 1 ? "" : "s"}.\n${formatLocationSummary(ctx.cwd, result.results)}`
				: "No references found.";
			return {
				content: [{ type: "text", text: summary }],
				details: {
					language: result.language,
					workspaceRoot: result.workspaceRoot,
					results: result.results,
				},
			};
		},
	});

	pi.registerTool({
		name: "symbol_search",
		label: "Symbol Search",
		description: "Search workspace symbols through a language server. Useful for finding symbol candidates before go-to-definition or find-references. If the required LSP is missing, prompts the user to install it.",
		promptSnippet: "Search workspace symbols via an LSP-backed symbol index.",
		promptGuidelines: [
			"Use symbol_search when grep is too noisy and you want symbol-level results from a language server.",
			"Provide a path or language hint when working in a mixed-language repository so the correct language server is selected.",
			"Use symbol_search before go_to_definition or find_references if you do not yet know the exact file position.",
			"If the tool reports a missing language server, ask the user to install it and then retry.",
		],
		parameters: SymbolSearchParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Searching symbols via LSP..." }], details: {} });
			const path = params.path ? await resolveToolPath(ctx, params.path) : undefined;
			const result = await runSymbolSearch({
				pi,
				ctx,
				query: params.query,
				path,
				language: params.language,
				limit: params.limit ?? 20,
				signal,
			});
			const summary = result.results.length > 0
				? `Found ${result.results.length} symbol${result.results.length === 1 ? "" : "s"}.\n${formatSymbolSummary(ctx.cwd, result.results)}`
				: "No symbols found.";
			return {
				content: [{ type: "text", text: summary }],
				details: {
					language: result.language,
					workspaceRoot: result.workspaceRoot,
					results: result.results,
				},
			};
		},
	});

	pi.registerTool({
		name: "workspace_diagnostics",
		label: "Workspace Diagnostics",
		description: "Collect diagnostics from a language server. Uses workspace-wide pull diagnostics when available, otherwise falls back to single-file diagnostics when a file path is provided. If the required LSP is missing, prompts the user to install it.",
		promptSnippet: "Collect LSP diagnostics for a workspace or file.",
		promptGuidelines: [
			"Use workspace_diagnostics when you want structured editor-like diagnostics instead of scraping build output.",
			"Provide a path or language hint in mixed-language repositories so the correct language server is selected.",
			"If the server does not support workspace-wide diagnostics, provide a file path so the tool can fall back to single-file diagnostics.",
			"If the tool reports a missing language server, ask the user to install it and then retry.",
		],
		parameters: WorkspaceDiagnosticsParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Collecting diagnostics via LSP..." }], details: {} });
			const path = params.path ? await resolveToolPath(ctx, params.path) : undefined;
			const result = await runWorkspaceDiagnostics({
				pi,
				ctx,
				path,
				language: params.language,
				severity: params.severity,
				limit: params.limit ?? 50,
				signal,
			});
			const note = result.note ? `\n\nNote: ${result.note}` : "";
			const summary = result.results.length > 0
				? `Found ${result.results.length} diagnostic${result.results.length === 1 ? "" : "s"} via ${result.mode}.\n${formatDiagnosticSummary(ctx.cwd, result.results)}${note}`
				: `No diagnostics found via ${result.mode}.${note}`;
			return {
				content: [{ type: "text", text: summary }],
				details: {
					language: result.language,
					workspaceRoot: result.workspaceRoot,
					mode: result.mode,
					note: result.note,
					results: result.results,
				},
			};
		},
	});
}
