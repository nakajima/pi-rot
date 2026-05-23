import { complete, type Api, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@mariozechner/pi-tui";

const VERSION = "2026-05-15.23";
const STATUS_KEY = "next-prompt";
const MAX_TRANSCRIPT_CHARS = 8000;
const MAX_PROMPT_CHARS = 140;
const MODEL_TIMEOUT_MS = 8000;
const SUGGESTION_MODEL_BY_PROVIDER: Record<string, readonly string[]> = {
	anthropic: ["claude-haiku-4-5"],
	"openai-codex": ["gpt-5.4-mini", "gpt-5.5"],
	openai: ["gpt-4.1-mini", "gpt-4o-mini"],
	google: ["gemini-2.5-flash", "gemini-2.0-flash"],
	llamacpp: ["default"],
};

interface TextBlock {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
}

interface SessionEntryLike {
	type: string;
	message?: MessageLike;
}

interface MessageLike {
	role?: string;
	content?: unknown;
}

interface ResolvedModel {
	model: Model<Api>;
	auth: {
		ok: true;
		apiKey?: string;
		headers?: Record<string, string>;
	};
}

interface SuggestionDebugState {
	status: "idle" | "generating" | "set" | "empty" | "error" | "skipped" | "cleared" | "aborted";
	lastEvent?: string;
	trigger?: "agent_end" | "manual" | "clear" | "agent_start";
	currentProvider?: string;
	model?: string;
	transcriptChars?: number;
	startedAt?: number;
	finishedAt?: number;
	latencyMs?: number;
	rawPreview?: string;
	suggestion?: string;
	stopReason?: string;
	contentTypes?: string;
	outputTokens?: number;
	transport?: string;
	error?: string;
	note?: string;
	generationId?: number;
}

class SuggestedPromptEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly bindings: KeybindingsManager,
		private readonly getSuggestion: () => string | undefined,
		private readonly stylePlaceholder: (text: string) => string,
	) {
		super(tui, theme, bindings);
	}

	refresh(): void {
		this.tui.requestRender();
	}

	override handleInput(data: string): void {
		const suggestion = this.getSuggestion();
		if (suggestion && this.getText().trim().length === 0) {
			if (this.bindings.matches(data, "tui.input.submit")) {
				this.setText(suggestion);
			} else if (this.bindings.matches(data, "tui.input.tab")) {
				this.setText(suggestion);
				this.refresh();
				return;
			}
		}
		super.handleInput(data);
	}

	override render(width: number): string[] {
		if (width <= 0) return [""];

		const lines = super.render(width);
		const suggestion = this.getSuggestion();
		if (!suggestion || this.getText().trim().length > 0 || lines.length < 3) {
			return lines;
		}

		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.getPaddingX(), maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = leftPadding;
		const marker = this.focused ? CURSOR_MARKER : "";
		const cursor = `${marker}\x1b[7m \x1b[0m`;
		const availablePlaceholderWidth = Math.max(0, contentWidth - 1);
		const placeholder = truncateToWidth(suggestion, availablePlaceholderWidth, "...");
		const styledPlaceholder = placeholder ? this.stylePlaceholder(placeholder) : "";
		const displayText = `${cursor}${styledPlaceholder}`;
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(displayText)));

		lines[1] = `${leftPadding}${displayText}${padding}${rightPadding}`;
		return lines;
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	const toolCalls: string[] = [];
	for (const rawPart of content) {
		if (!rawPart || typeof rawPart !== "object") continue;
		const part = rawPart as TextBlock;
		if (part.type === "text" && typeof part.text === "string") {
			parts.push(part.text);
		} else if (part.type === "toolCall" && typeof part.name === "string") {
			toolCalls.push(part.name);
		}
	}

	if (toolCalls.length > 0) {
		parts.push(`Tools used: ${toolCalls.join(", ")}`);
	}
	return parts.join("\n");
}

function trimTranscriptSections(sections: string[]): string {
	const selected: string[] = [];
	let usedChars = 0;
	for (let i = sections.length - 1; i >= 0; i--) {
		const section = sections[i]!;
		if (usedChars + section.length > MAX_TRANSCRIPT_CHARS && selected.length > 0) break;
		selected.unshift(section);
		usedChars += section.length;
		if (usedChars >= MAX_TRANSCRIPT_CHARS) break;
	}
	return selected.join("\n\n");
}

function buildTranscriptFromMessages(messages: readonly MessageLike[]): string {
	const sections: string[] = [];
	for (const message of messages) {
		const role = message.role;
		if (role !== "user" && role !== "assistant") continue;

		const text = extractText(message.content).trim();
		if (!text) continue;
		sections.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
	}
	return trimTranscriptSections(sections);
}

function buildTranscript(entries: readonly SessionEntryLike[]): string {
	return buildTranscriptFromMessages(
		entries.filter((entry) => entry.type === "message").map((entry) => entry.message).filter((message): message is MessageLike => !!message),
	);
}

function fixedSuggestionModel(ctx: ExtensionContext): Model<Api> | undefined {
	const provider = ctx.model?.provider;
	if (!provider) return undefined;

	const models = ctx.modelRegistry.getAvailable().filter((model) => model.provider === provider && model.input.includes("text"));
	const fixedIds = SUGGESTION_MODEL_BY_PROVIDER[provider];
	if (fixedIds) {
		for (const id of fixedIds) {
			const model = models.find((candidate) => candidate.id === id);
			if (model) return model;
		}
		return undefined;
	}

	return ctx.model?.input.includes("text") ? ctx.model : undefined;
}

function suggestionModelLabel(ctx: ExtensionContext): string {
	const provider = ctx.model?.provider;
	const model = fixedSuggestionModel(ctx);
	if (model) return `${model.provider}/${model.id}`;
	return provider ? `none for provider ${provider}` : "none; no current provider";
}

async function resolveModel(ctx: ExtensionContext, model: Model<Api>): Promise<ResolvedModel | undefined> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	return auth.ok ? { model, auth } : undefined;
}

class SuggestionTimeoutError extends Error {
	constructor(label: string) {
		super(`Timed out waiting for ${label}`);
		this.name = "SuggestionTimeoutError";
	}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => reject(new SuggestionTimeoutError(label)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timeoutId) clearTimeout(timeoutId);
	});
}

function fixCodexPayloadWithoutTools(payload: unknown, model: Model<Api>): unknown | undefined {
	if (model.api !== "openai-codex-responses" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
		return undefined;
	}

	const body = payload as Record<string, unknown>;
	if (Array.isArray(body.tools) && body.tools.length > 0) return undefined;

	const next = { ...body };
	delete next.tool_choice;
	delete next.parallel_tool_calls;
	return next;
}

async function completeSuggestion(resolved: ResolvedModel, transcript: string, signal: AbortSignal): Promise<AssistantMessage> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", abort, { once: true });

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const completion = complete(
		resolved.model,
		{
			systemPrompt: "You generate concise next user prompts for coding-agent conversations.",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: buildSuggestionPrompt(transcript) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: resolved.auth.apiKey,
			headers: resolved.auth.headers,
			maxTokens: 64,
			temperature: resolved.model.api === "openai-codex-responses" ? undefined : 0.2,
			maxRetries: 0,
			timeoutMs: MODEL_TIMEOUT_MS,
			transport: "sse",
			reasoningEffort: "minimal",
			reasoningSummary: null,
			textVerbosity: "low",
			thinkingEnabled: false,
			effort: "low",
			thinkingDisplay: "omitted",
			onPayload: (payload) => fixCodexPayloadWithoutTools(payload, resolved.model),
			signal: controller.signal,
		},
	).finally(() => {
		if (timeoutId) clearTimeout(timeoutId);
		signal.removeEventListener("abort", abort);
	});

	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			controller.abort();
			reject(new SuggestionTimeoutError(`${resolved.model.provider}/${resolved.model.id}`));
		}, MODEL_TIMEOUT_MS);
	});

	return Promise.race([completion, timeout]);
}

function cleanSuggestion(raw: string): string | undefined {
	let text = raw.trim();
	text = text.replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/```$/, "").trim();
	text = text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0) ?? "";
	text = text.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
	text = text.replace(/^(recommended answer|suggested prompt|next prompt):\s*/i, "").trim();
	text = text.replace(/^["'`]+/, "").replace(/["'`]+$/, "").trim();
	if (!text || /^(none|n\/a|no suggestion|no useful next prompt)$/i.test(text)) return undefined;
	return text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS).trim()}...` : text;
}

function modelLabel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function preview(text: string | undefined, maxLength = 160): string | undefined {
	if (!text) return undefined;
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trim()}...` : normalized;
}

function formatLatency(ms: number | undefined): string {
	if (ms === undefined) return "n/a";
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function buildSuggestionPrompt(transcript: string): string {
	return [
		"You are drafting the user's next message in a coding-agent chat.",
		"Always return exactly one short prompt, plain text only.",
		"Hard limit: 10 words or fewer.",
		"Write what the user should say next, not a summary of the conversation.",
		"If the assistant asked a numbered/design question and gave a recommended answer, accept the recommendation and name the concrete change.",
		"For option lists, prefer the recommended option's name plus its action.",
		"Never restate the question. Never include question numbers, headings, or code fences.",
		"Prefer terse imperative/confirmation phrasing.",
		"Bad: Implement question 17: should we remove last_sync_at from Syncer once the stamp file owns that state?",
		"Good: Yes - remove last_sync_at and add stamp helpers.",
		"Good: Use endpoint-based file handling.",
		"Bad: Continue with the smallest correct next step.",
		"Good: Add the Syncer stamp path helper.",
		"If uncertain, choose the safest concrete continuation.",
		"Do not return an empty string for a non-empty conversation.",
		"",
		"<conversation>",
		transcript,
		"</conversation>",
	].join("\n");
}

export default function nextPromptExtension(pi: ExtensionAPI) {
	let currentSuggestion: string | undefined;
	let activeEditor: SuggestedPromptEditor | undefined;
	let generationId = 0;
	let abortController: AbortController | undefined;
	let statusClearTimer: ReturnType<typeof setTimeout> | undefined;
	let lastDebug: SuggestionDebugState = { status: "idle", note: "extension loaded" };

	function setStatus(ctx: ExtensionContext, status: string | undefined): void {
		if (statusClearTimer) {
			clearTimeout(statusClearTimer);
			statusClearTimer = undefined;
		}
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, status);
	}

	function setTransientStatus(ctx: ExtensionContext, status: string, localGenerationId: number): void {
		setStatus(ctx, status);
		statusClearTimer = setTimeout(() => {
			if (localGenerationId === generationId && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
			statusClearTimer = undefined;
		}, 2500);
	}

	function setSuggestion(ctx: ExtensionContext, suggestion: string | undefined): void {
		currentSuggestion = suggestion;
		activeEditor?.refresh();
	}

	function finishDebug(status: SuggestionDebugState["status"], update: Partial<SuggestionDebugState> = {}): void {
		const finishedAt = Date.now();
		lastDebug = {
			...lastDebug,
			...update,
			status,
			finishedAt,
			latencyMs: lastDebug.startedAt ? finishedAt - lastDebug.startedAt : undefined,
		};
	}

	function formatDebug(ctx: ExtensionContext): string {
		return [
			`next-prompt ${VERSION}`,
			`status: ${lastDebug.status}`,
			`last event: ${lastDebug.lastEvent ?? "none"}`,
			`trigger: ${lastDebug.trigger ?? "none"}`,
			`provider: ${lastDebug.currentProvider ?? ctx.model?.provider ?? "none"}`,
			`model: ${lastDebug.model ?? suggestionModelLabel(ctx)}`,
			`transcript chars: ${lastDebug.transcriptChars ?? 0}`,
			`latency: ${formatLatency(lastDebug.latencyMs)}`,
			`editor active: ${activeEditor ? "yes" : "no"}`,
			`editor text chars: ${activeEditor?.getText().length ?? "n/a"}`,
			`current suggestion: ${currentSuggestion ?? "none"}`,
			`last suggestion: ${lastDebug.suggestion ?? "none"}`,
			`raw preview: ${lastDebug.rawPreview ?? "none"}`,
			`stop reason: ${lastDebug.stopReason ?? "none"}`,
			`content types: ${lastDebug.contentTypes ?? "none"}`,
			`output tokens: ${lastDebug.outputTokens ?? "none"}`,
			`transport: ${lastDebug.transport ?? "sse"}`,
			`error: ${lastDebug.error ?? "none"}`,
			`note: ${lastDebug.note ?? "none"}`,
		].join("\n");
	}

	async function generateSuggestion(
		ctx: ExtensionContext,
		notifyErrors: boolean,
		trigger: "agent_end" | "manual" = "manual",
		transcriptOverride?: string,
	): Promise<void> {
		if (!ctx.hasUI || !activeEditor) {
			lastDebug = {
				status: "skipped",
				lastEvent: trigger,
				trigger,
				currentProvider: ctx.model?.provider,
				note: !ctx.hasUI ? "no UI" : "editor not active",
			};
			return;
		}

		const transcript = transcriptOverride?.trim() || buildTranscript(ctx.sessionManager.getBranch() as readonly SessionEntryLike[]);
		const startedAt = Date.now();
		lastDebug = {
			status: "generating",
			lastEvent: trigger,
			trigger,
			currentProvider: ctx.model?.provider,
			transcriptChars: transcript.length,
			startedAt,
			note: undefined,
			error: undefined,
			rawPreview: undefined,
			suggestion: undefined,
			stopReason: undefined,
			contentTypes: undefined,
			outputTokens: undefined,
			transport: "sse",
		};

		if (!transcript.trim()) {
			setSuggestion(ctx, undefined);
			finishDebug("skipped", { note: "empty transcript" });
			return;
		}

		abortController?.abort();
		const localGenerationId = ++generationId;
		abortController = new AbortController();
		lastDebug = { ...lastDebug, generationId: localGenerationId };
		setSuggestion(ctx, undefined);

		let finalStatus: string | undefined;
		const model = fixedSuggestionModel(ctx);
		if (!model) {
			finishDebug("error", { error: `No fixed next prompt model for ${ctx.model?.provider ?? "the current provider"}.` });
			if (notifyErrors) ctx.ui.notify(lastDebug.error ?? "No fixed next prompt model.", "warning");
			return;
		}

		const label = modelLabel(model);
		lastDebug = { ...lastDebug, model: label, transport: "sse" };
		setStatus(ctx, `suggesting ${model.id}...`);

		try {
			const resolved = await withTimeout(resolveModel(ctx, model), MODEL_TIMEOUT_MS, `${label} auth`);
			if (localGenerationId !== generationId || abortController.signal.aborted) {
				finishDebug("aborted", { note: "superseded during auth" });
				return;
			}
			if (!resolved) {
				finishDebug("error", { error: `No auth for next prompt model ${label}.` });
				if (notifyErrors) ctx.ui.notify(lastDebug.error ?? `No auth for next prompt model ${label}.`, "warning");
				return;
			}

			const response = await completeSuggestion(resolved, transcript, abortController.signal);
			if (localGenerationId !== generationId || abortController.signal.aborted) {
				finishDebug("aborted", { note: "superseded during completion" });
				return;
			}

			const responseDebug = {
				stopReason: response.stopReason,
				contentTypes: response.content.map((part) => part.type).join(", ") || "none",
				outputTokens: response.usage.output,
			};
			if (response.stopReason === "error") {
				finishDebug("error", { ...responseDebug, error: response.errorMessage || "Provider returned an error without a message." });
				finalStatus = "next prompt failed";
			} else {
				const raw = response.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				const suggestion = cleanSuggestion(raw);
				if (suggestion) {
					setSuggestion(ctx, suggestion);
					finishDebug("set", { ...responseDebug, rawPreview: preview(raw), suggestion });
					finalStatus = `next prompt set ${formatLatency(lastDebug.latencyMs)}`;
					return;
				}
				finishDebug("empty", { ...responseDebug, rawPreview: preview(raw), error: "Suggestion model returned an empty prompt." });
				finalStatus = "next prompt empty";
			}
		} catch (error) {
			if (localGenerationId !== generationId || abortController.signal.aborted) {
				finishDebug("aborted", { error: errorMessage(error) });
				return;
			}
			finishDebug("error", { error: errorMessage(error) });
			finalStatus = "next prompt failed";
		}
		finally {
			if (localGenerationId === generationId) {
				if (finalStatus) setTransientStatus(ctx, finalStatus, localGenerationId);
				else setStatus(ctx, undefined);
			}
		}

		if (localGenerationId !== generationId || abortController?.signal.aborted) return;
		setSuggestion(ctx, undefined);
		if (notifyErrors) {
			const suffix = lastDebug.error ? ` Last error: ${lastDebug.error}` : "";
			ctx.ui.notify(`No next prompt from ${label}.${suffix}`, "warning");
		}
	}

	function clearSuggestion(ctx: ExtensionContext, trigger: "clear" | "agent_start" = "clear"): void {
		generationId++;
		abortController?.abort();
		abortController = undefined;
		setStatus(ctx, undefined);
		setSuggestion(ctx, undefined);
		lastDebug = {
			...lastDebug,
			status: "cleared",
			lastEvent: trigger,
			trigger,
			currentProvider: ctx.model?.provider,
			finishedAt: Date.now(),
			note: trigger === "agent_start" ? "cleared for new agent run" : "cleared by command",
		};
	}

	pi.on("session_start", (_event, ctx) => {
		lastDebug = { ...lastDebug, lastEvent: "session_start", currentProvider: ctx.model?.provider };
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			activeEditor = new SuggestedPromptEditor(
				tui,
				theme,
				keybindings,
				() => currentSuggestion,
				(text) => `\x1b[2m${text}\x1b[22m`,
			);
			return activeEditor;
		});
	});

	pi.on("agent_start", (_event, ctx) => {
		clearSuggestion(ctx, "agent_start");
	});

	pi.on("agent_end", (event, ctx) => {
		const transcript = buildTranscriptFromMessages(event.messages as readonly MessageLike[]);
		void generateSuggestion(ctx, false, "agent_end", transcript).catch((error) => {
			finishDebug("error", { error: errorMessage(error), note: "unhandled generation error" });
			setStatus(ctx, undefined);
		});
	});

	pi.on("session_shutdown", (_event, _ctx) => {
		generationId++;
		abortController?.abort();
		abortController = undefined;
		if (statusClearTimer) clearTimeout(statusClearTimer);
		statusClearTimer = undefined;
		activeEditor = undefined;
		currentSuggestion = undefined;
		lastDebug = { ...lastDebug, status: "aborted", lastEvent: "session_shutdown", finishedAt: Date.now(), note: "session shutdown" };
	});

	pi.registerCommand("next-prompt", {
		description: "Regenerate the suggested next prompt placeholder",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const command = args.trim();
			if (command === "clear") {
				clearSuggestion(ctx);
				return;
			}
			if (command === "models") {
				ctx.ui.notify(`Next prompt model: ${suggestionModelLabel(ctx)}`, "info");
				return;
			}
			if (command === "version") {
				ctx.ui.notify(`next-prompt ${VERSION}`, "info");
				return;
			}
			if (command === "debug") {
				ctx.ui.notify(formatDebug(ctx), "info");
				return;
			}
			await generateSuggestion(ctx, true, "manual");
		},
	});
}
