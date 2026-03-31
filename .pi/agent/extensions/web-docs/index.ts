import { formatSize, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
	docsLookup,
	docsReadSection,
	fetchUrl,
	normalizeFetchFormat,
	restoreLookupResultsFromBranch,
	type SearchResultItem,
} from "./core";

const FetchUrlParams = Type.Object({
	url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
	format: Type.Optional(Type.String({ description: 'Output format: "markdown" (default), "text", or "outline".' })),
	selector: Type.Optional(Type.String({ description: "Optional section hint, such as a heading name or fragment id." })),
});

const DocsLookupParams = Type.Object({
	query: Type.String({ description: "The coding/docs question to research." }),
	package: Type.Optional(Type.String({ description: "Optional package or framework name to bias the lookup." })),
	version: Type.Optional(Type.String({ description: "Optional package/framework version hint." })),
	language: Type.Optional(Type.String({ description: "Optional language or ecosystem hint, such as TypeScript or Rust." })),
	preferredDomains: Type.Optional(Type.Array(Type.String({ description: "A domain to prefer, like docs.python.org or react.dev." }))),
	allowedDomains: Type.Optional(Type.Array(Type.String({ description: "Limit results to these domains and their subdomains." }))),
	blockedDomains: Type.Optional(Type.Array(Type.String({ description: "Exclude these domains and their subdomains." }))),
});

const DocsReadSectionParams = Type.Object({
	docIdOrUrl: Type.String({ description: "A doc id returned by docs_lookup, or a direct HTTP/HTTPS URL." }),
	heading: Type.Optional(Type.String({ description: "Optional heading or section name to read." })),
});

function restoreLookupIndex(ctx: ExtensionContext): Map<string, SearchResultItem> {
	return restoreLookupResultsFromBranch(ctx.sessionManager.getBranch() as unknown[]);
}

export default function webDocsExtension(pi: ExtensionAPI) {
	let recentLookupResults = new Map<string, SearchResultItem>();

	function restore(ctx: ExtensionContext): void {
		recentLookupResults = restoreLookupIndex(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		restore(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		restore(ctx);
	});

	pi.registerTool({
		name: "fetch_url",
		label: "Fetch URL",
		description: `Fetch a web page or document and convert it into readable markdown, text, or an outline. Output is truncated to ${formatSize(50 * 1024)} or 2000 lines.`,
		promptSnippet: "Fetch a specific URL and extract readable docs/article content.",
		promptGuidelines: [
			"Use fetch_url when the user gives a specific URL or when you already know the exact page to inspect.",
			"Prefer docs_read_section over repeatedly fetching the same large page when you only need one heading.",
		],
		parameters: FetchUrlParams,
		async execute(_toolCallId, params, signal) {
			const result = await fetchUrl({
				url: params.url,
				format: normalizeFetchFormat(params.format),
				selector: params.selector,
			}, signal);
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});

	pi.registerTool({
		name: "docs_lookup",
		label: "Docs Lookup",
		description: "Find relevant documentation and research sources for a coding question. Returns ranked results with doc ids that can be passed to docs_read_section.",
		promptSnippet: "Look up external docs and research sources, returning doc ids for follow-up reading.",
		promptGuidelines: [
			"Use docs_lookup when you need external docs or broader web research.",
			"Prefer docs_lookup before guessing about unfamiliar frameworks, APIs, or libraries.",
			"After docs_lookup, use docs_read_section with a returned doc id to read a specific heading instead of pulling the whole page again.",
		],
		parameters: DocsLookupParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await docsLookup(
				{
					query: params.query,
					package: params.package,
					version: params.version,
					language: params.language,
					preferredDomains: params.preferredDomains,
					allowedDomains: params.allowedDomains,
					blockedDomains: params.blockedDomains,
				},
				ctx.cwd,
				signal,
			);
			for (const item of result.results) {
				recentLookupResults.set(item.id, item);
			}
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});

	pi.registerTool({
		name: "docs_read_section",
		label: "Docs Read Section",
		description: "Read a focused section from a docs_lookup result or direct URL. Use this to zoom in on one heading instead of re-reading a whole page.",
		promptSnippet: "Read a specific section from a docs result or URL.",
		promptGuidelines: [
			"Use docs_read_section after docs_lookup to inspect one promising result in more detail.",
			"Pass the doc id returned by docs_lookup when possible so you do not have to repeat the URL.",
		],
		parameters: DocsReadSectionParams,
		async execute(_toolCallId, params, signal) {
			const result = await docsReadSection(
				{
					docIdOrUrl: params.docIdOrUrl,
					heading: params.heading,
				},
				recentLookupResults,
				signal,
			);
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});
}
