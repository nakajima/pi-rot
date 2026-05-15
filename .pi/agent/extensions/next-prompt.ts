import { complete, type Api, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@mariozechner/pi-tui";

const VERSION = "2026-05-15.11";
const STATUS_KEY = "next-prompt";
const MAX_TRANSCRIPT_CHARS = 8000;
const MAX_PROMPT_CHARS = 140;
const FAST_MODEL_HINTS = ["haiku", "mini", "nano", "flash", "lite", "small", "fast", "8b", "4o-mini"];
const SKIPPED_MODEL_PATTERNS = [/\bclaude-3(?:[-.]|\b)/, /deprecated/];
const MAX_MODEL_ATTEMPTS = 3;
const MODEL_TIMEOUT_MS = 8000;

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
		if (suggestion && this.getText().trim().length === 0 && this.bindings.matches(data, "tui.input.submit")) {
			this.setText(suggestion);
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
		const availablePlaceholderWidth = Math.max(0, contentWidth - 2);
		const placeholder = truncateToWidth(suggestion, availablePlaceholderWidth, "...");
		const styledPlaceholder = placeholder ? ` ${this.stylePlaceholder(placeholder)}` : "";
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

function isFastModel(model: Model<Api>): boolean {
	const label = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
	return FAST_MODEL_HINTS.some((hint) => label.includes(hint));
}

function isSkippedModel(model: Model<Api>): boolean {
	const label = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
	return SKIPPED_MODEL_PATTERNS.some((pattern) => pattern.test(label));
}

function modelScore(model: Model<Api>, currentProvider?: string): number {
	const label = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
	let score = isFastModel(model) ? 100 : 0;
	if (model.provider === currentProvider) score += 20;
	if (label.includes("haiku-4-5") || label.includes("haiku-4")) score += 60;
	if (label.includes("gpt-5") && label.includes("mini")) score += 50;
	if (label.includes("spark")) score += 45;
	if (label.includes("flash")) score += 40;
	if (label.includes("4o-mini") || label.includes("4.1-mini")) score += 30;
	return score;
}

function candidateModels(ctx: ExtensionContext): Model<Api>[] {
	return [...ctx.modelRegistry.getAvailable().filter((model) => model.input.includes("text") && !isSkippedModel(model))]
		.sort((a, b) => modelScore(b, ctx.model?.provider) - modelScore(a, ctx.model?.provider))
		.slice(0, MAX_MODEL_ATTEMPTS);
}

async function resolveModel(ctx: ExtensionContext, model: Model<Api>): Promise<ResolvedModel | undefined> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	return auth.ok ? { model, auth } : undefined;
}

class SuggestionTimeoutError extends Error {
	constructor(model: Model<Api>) {
		super(`Timed out waiting for ${model.provider}/${model.id}`);
		this.name = "SuggestionTimeoutError";
	}
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
			maxTokens: 48,
			temperature: 0.2,
			maxRetries: 0,
			timeoutMs: MODEL_TIMEOUT_MS,
			reasoningEffort: resolved.model.api === "openai-codex-responses" ? "none" : "minimal",
			reasoningSummary: resolved.model.api === "openai-codex-responses" ? "off" : null,
			textVerbosity: "low",
			thinkingEnabled: false,
			effort: "low",
			thinkingDisplay: "omitted",
			signal: controller.signal,
		},
	).finally(() => {
		if (timeoutId) clearTimeout(timeoutId);
		signal.removeEventListener("abort", abort);
	});

	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			controller.abort();
			reject(new SuggestionTimeoutError(resolved.model));
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

function buildSuggestionPrompt(transcript: string): string {
	return [
		"You are drafting the user's next message in a coding-agent chat.",
		"Always return exactly one short prompt, plain text only.",
		"Hard limit: 10 words or fewer.",
		"Write what the user should say next, not a summary of the conversation.",
		"If the assistant asked a numbered/design question and gave a recommended answer, accept the recommendation and name the concrete change.",
		"Never restate the question. Never include question numbers, headings, or code fences.",
		"Prefer terse imperative/confirmation phrasing.",
		"Bad: Implement question 17: should we remove last_sync_at from Syncer once the stamp file owns that state?",
		"Good: Yes - remove last_sync_at and add stamp helpers.",
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

	function setSuggestion(ctx: ExtensionContext, suggestion: string | undefined, status?: string): void {
		currentSuggestion = suggestion;
		activeEditor?.refresh();
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, status);
		}
	}

	async function generateSuggestion(ctx: ExtensionContext, notifyErrors: boolean, transcriptOverride?: string): Promise<void> {
		if (!ctx.hasUI || !activeEditor) return;

		const transcript = transcriptOverride?.trim() || buildTranscript(ctx.sessionManager.getBranch() as readonly SessionEntryLike[]);
		if (!transcript.trim()) {
			setSuggestion(ctx, undefined);
			return;
		}

		abortController?.abort();
		const localGenerationId = ++generationId;
		abortController = new AbortController();
		setSuggestion(ctx, undefined);

		let lastError: unknown;
		let tried = 0;
		const models = candidateModels(ctx);
		for (const model of models) {
			if (localGenerationId !== generationId || abortController.signal.aborted) return;

			const resolved = await resolveModel(ctx, model);
			if (!resolved) continue;
			tried++;

			try {
				const response = await completeSuggestion(resolved, transcript, abortController.signal);
				if (localGenerationId !== generationId || abortController.signal.aborted) return;

				const raw = response.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				const suggestion = cleanSuggestion(raw);
				if (suggestion) {
					setSuggestion(ctx, suggestion);
					return;
				}
				lastError = new Error("Suggestion model returned an empty prompt.");
			} catch (error) {
				if (localGenerationId !== generationId || abortController.signal.aborted) return;
				lastError = error;
				if (error instanceof SuggestionTimeoutError) break;
			}
		}

		if (localGenerationId !== generationId || abortController?.signal.aborted) return;
		setSuggestion(ctx, undefined);
		if (notifyErrors) {
			const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
			ctx.ui.notify(
				tried > 0 ? `No working model for next prompt suggestions.${suffix}` : "No available model for next prompt suggestions.",
				"warning",
			);
		}
	}

	function clearSuggestion(ctx: ExtensionContext): void {
		generationId++;
		abortController?.abort();
		abortController = undefined;
		setSuggestion(ctx, undefined);
	}

	pi.on("session_start", (_event, ctx) => {
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
		clearSuggestion(ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		const transcript = buildTranscriptFromMessages(event.messages as readonly MessageLike[]);
		void generateSuggestion(ctx, false, transcript).catch(() => undefined);
	});

	pi.on("session_shutdown", (_event, _ctx) => {
		generationId++;
		abortController?.abort();
		abortController = undefined;
		activeEditor = undefined;
		currentSuggestion = undefined;
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
				const models = candidateModels(ctx).map((model) => `${model.provider}/${model.id}`);
				ctx.ui.notify(models.length > 0 ? `Next prompt candidates: ${models.join(", ")}` : "No next prompt candidates found.", "info");
				return;
			}
			if (command === "version") {
				ctx.ui.notify(`next-prompt ${VERSION}`, "info");
				return;
			}
			await generateSuggestion(ctx, true);
		},
	});
}
