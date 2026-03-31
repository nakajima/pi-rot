import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const LIVE_PROTOCOL_VERSION = 2;
const PARTIAL_UPDATE_THROTTLE_MS = 150;
const SOCKET_RECONNECT_DELAY_MS = 500;

type PimuxRole =
	| "user"
	| "assistant"
	| "toolResult"
	| "bashExecution"
	| "custom"
	| "branchSummary"
	| "compactionSummary"
	| "other";

type PimuxMessageBlockType = "text" | "thinking" | "toolCall" | "image" | "other";

interface PimuxMessageBlock {
	type: PimuxMessageBlockType;
	text?: string;
	toolCallName?: string;
	mimeType?: string;
	data?: string;
}

interface PimuxMessage {
	created_at: string;
	role: PimuxRole;
	body: string;
	toolName?: string;
	blocks?: PimuxMessageBlock[];
}

interface PimuxSessionContextUsage {
	usedTokens?: number;
	maxTokens?: number;
}

interface PimuxSessionMetadata {
	createdAt: string;
	cwd: string;
	summary: string;
	model: string;
	contextUsage?: PimuxSessionContextUsage;
}

type BridgeToAgentMessage =
	| { type: "hello"; protocolVersion: number }
	| { type: "sessionAttached"; sessionId: string; metadata: PimuxSessionMetadata }
	| { type: "sessionSnapshot"; sessionId: string; messages: PimuxMessage[]; metadata: PimuxSessionMetadata }
	| { type: "sessionAppend"; sessionId: string; messages: PimuxMessage[]; metadata: PimuxSessionMetadata }
	| { type: "assistantPartial"; sessionId: string; message: PimuxMessage }
	| { type: "sessionDetached"; sessionId: string }
	| { type: "sendUserMessageResult"; requestId: string; sessionId: string; error?: string }
	| { type: "getCommandsResult"; requestId: string; sessionId: string; commands: PimuxSessionCommand[]; error?: string };

interface PimuxInputImage {
	type: "image";
	data: string;
	mimeType: string;
}

type AgentToBridgeMessage =
	| {
			type: "sendUserMessage";
			requestId: string;
			sessionId: string;
			body: string;
			images?: PimuxInputImage[];
	  }
	| {
			type: "getCommands";
			requestId: string;
			sessionId: string;
	  };

interface PimuxSessionCommand {
	name: string;
	description?: string;
	source: string;
}

interface PendingPartial {
	message: PimuxMessage;
	timer: ReturnType<typeof setTimeout>;
}

interface BridgeStateSnapshot {
	currentSessionId?: string;
	latestSnapshotMessages: PimuxMessage[];
	latestMetadata?: PimuxSessionMetadata;
	currentAssistantPartial?: PimuxMessage;
}

class LiveBridgeClient {
	private readonly socketPath: string;
	private readonly onCommand: (command: AgentToBridgeMessage) => void;
	private readonly getStateSnapshot: () => BridgeStateSnapshot;
	private socket?: Socket;
	private activeSocketId = 0;
	private connecting = false;
	private connected = false;
	private closed = false;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private incomingBuffer = "";

	constructor(
		socketPath: string,
		onCommand: (command: AgentToBridgeMessage) => void,
		getStateSnapshot: () => BridgeStateSnapshot
	) {
		this.socketPath = socketPath;
		this.onCommand = onCommand;
		this.getStateSnapshot = getStateSnapshot;
		this.ensureConnected();
	}

	send(message: BridgeToAgentMessage) {
		if (this.closed) return;
		if (this.writeNow(message)) return;

		// Reconnects always resync the current session state, so avoid buffering
		// stale live payloads while the socket is down.
		this.ensureConnected();
	}

	close() {
		this.closed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		if (this.socket && !this.socket.destroyed) {
			this.socket.destroy();
		}
		this.socket = undefined;
		this.connected = false;
		this.connecting = false;
	}

	private ensureConnected() {
		if (this.closed || this.connected || this.connecting) return;
		this.connecting = true;

		const socketId = ++this.activeSocketId;
		const socket = createConnection(this.socketPath);
		this.socket = socket;

		socket.on("connect", () => {
			if (socketId !== this.activeSocketId) return;
			this.connecting = false;
			this.connected = true;
			this.incomingBuffer = "";
			this.writeNow({ type: "hello", protocolVersion: LIVE_PROTOCOL_VERSION });
			this.resyncCurrentSession();
		});

		socket.on("data", (chunk) => {
			if (socketId !== this.activeSocketId) return;
			this.incomingBuffer += chunk.toString("utf8");
			this.drainIncomingBuffer();
		});

		socket.on("error", () => {
			// close always fires after error; reconnect is handled there.
		});

		socket.on("close", () => {
			if (socketId !== this.activeSocketId) return;
			this.connected = false;
			this.connecting = false;
			this.socket = undefined;
			this.scheduleReconnect();
		});
	}

	private writeNow(message: BridgeToAgentMessage): boolean {
		if (this.closed) return false;
		if (!this.connected || !this.socket || this.socket.destroyed) {
			return false;
		}

		this.socket.write(`${JSON.stringify(message)}\n`);
		return true;
	}

	private resyncCurrentSession() {
		const state = this.getStateSnapshot();
		if (!state.currentSessionId || !state.latestMetadata) return;
		this.writeNow({
			type: "sessionAttached",
			sessionId: state.currentSessionId,
			metadata: state.latestMetadata,
		});
		this.writeNow({
			type: "sessionSnapshot",
			sessionId: state.currentSessionId,
			messages: state.latestSnapshotMessages,
			metadata: state.latestMetadata,
		});
		if (state.currentAssistantPartial) {
			this.writeNow({
				type: "assistantPartial",
				sessionId: state.currentSessionId,
				message: state.currentAssistantPartial,
			});
		}
	}

	private drainIncomingBuffer() {
		while (true) {
			const newlineIndex = this.incomingBuffer.indexOf("\n");
			if (newlineIndex === -1) return;

			let line = this.incomingBuffer.slice(0, newlineIndex);
			this.incomingBuffer = this.incomingBuffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			line = line.trim();
			if (!line) continue;

			try {
					const command = JSON.parse(line) as AgentToBridgeMessage;
				this.onCommand(command);
			} catch {
				// Ignore malformed agent-side commands.
			}
		}
	}

	private scheduleReconnect() {
		if (this.closed) return;
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			if (!this.closed) this.ensureConnected();
		}, SOCKET_RECONNECT_DELAY_MS);
	}
}

export default function (pi: ExtensionAPI) {
	const state: {
		currentSessionId?: string;
		latestSnapshotMessages: PimuxMessage[];
		latestMetadata?: PimuxSessionMetadata;
		currentAssistantPartial?: PimuxMessage;
		isAgentBusy: boolean;
	} = {
		currentSessionId: undefined,
		latestSnapshotMessages: [],
		latestMetadata: undefined,
		currentAssistantPartial: undefined,
		isAgentBusy: false,
	};

	const pendingPartials = new Map<string, PendingPartial>();
	let bridge!: LiveBridgeClient;

	function bridgeStateSnapshot(): BridgeStateSnapshot {
		return {
			currentSessionId: state.currentSessionId,
			latestSnapshotMessages: state.latestSnapshotMessages,
			latestMetadata: state.latestMetadata,
			currentAssistantPartial: state.currentAssistantPartial,
		};
	}

	function respondToSendRequest(requestId: string, sessionId: string, error?: string) {
		bridge.send({ type: "sendUserMessageResult", requestId, sessionId, error });
	}

	function userMessageContent(
		body: string,
		images: PimuxInputImage[]
	): string | Array<{ type: "text"; text: string } | PimuxInputImage> {
		if (images.length === 0) return body;

		const content: Array<{ type: "text"; text: string } | PimuxInputImage> = [];
		if (body) {
			content.push({ type: "text", text: body });
		}
		content.push(...images);
		return content;
	}

	function handleGetCommands(requestId: string, sessionId: string) {
		try {
			const slashCommands = pi.getCommands();
			const commands: PimuxSessionCommand[] = slashCommands.map((cmd) => ({
				name: cmd.name,
				description: cmd.description,
				source: cmd.source,
			}));
			bridge.send({ type: "getCommandsResult", requestId, sessionId, commands });
		} catch (error) {
			bridge.send({
				type: "getCommandsResult",
				requestId,
				sessionId,
				commands: [],
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	function handleBridgeCommand(command: AgentToBridgeMessage) {
		if (command.type === "getCommands") {
			handleGetCommands(command.requestId, command.sessionId);
			return;
		}

		if (command.type !== "sendUserMessage") return;

		if (!state.currentSessionId || command.sessionId !== state.currentSessionId) {
			respondToSendRequest(
				command.requestId,
				command.sessionId,
				`session ${command.sessionId} is not currently attached in this pi runtime`
			);
			return;
		}

		const body = command.body.trim();
		const images = Array.isArray(command.images) ? command.images : [];
		if (!body && images.length === 0) {
			respondToSendRequest(command.requestId, command.sessionId, "message body or images must not both be empty");
			return;
		}

		const content = userMessageContent(body, images);
		if (state.isAgentBusy) {
			pi.sendUserMessage(content, { deliverAs: "followUp" });
		} else {
			pi.sendUserMessage(content);
		}

		respondToSendRequest(command.requestId, command.sessionId);
	}

	bridge = new LiveBridgeClient(resolveSocketPath(), handleBridgeCommand, bridgeStateSnapshot);

	pi.on("session_start", async (_event, ctx) => {
		await attachCurrentSession(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await attachCurrentSession(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		await attachCurrentSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		publishSnapshot(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		publishSnapshot(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (state.currentSessionId === ctx.sessionManager.getSessionId()) {
			publishSnapshot(ctx);
		}
	});

	pi.on("agent_start", async () => {
		state.isAgentBusy = true;
	});

	pi.on("agent_end", async () => {
		state.isAgentBusy = false;
	});

	pi.on("message_update", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId || sessionId !== state.currentSessionId) return;

		const message = agentMessageToPimuxMessage(event.message);
		if (!message || message.role !== "assistant") return;

		state.currentAssistantPartial = message;
		schedulePartial(sessionId, message);
	});

	pi.on("message_end", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId || sessionId !== state.currentSessionId) return;

		const message = agentMessageToPimuxMessage(event.message);
		if (!message) return;

		if (message.role === "assistant") {
			cancelPendingPartial(sessionId);
			state.currentAssistantPartial = undefined;
		}

		state.latestSnapshotMessages = [...state.latestSnapshotMessages, message];
		state.latestMetadata = buildSessionMetadata(ctx, state.latestSnapshotMessages);
		bridge.send({
			type: "sessionAppend",
			sessionId,
			messages: [message],
			metadata: state.latestMetadata,
		});
	});

	pi.on("session_shutdown", async () => {
		for (const sessionId of pendingPartials.keys()) {
			cancelPendingPartial(sessionId);
		}

		if (state.currentSessionId) {
			bridge.send({ type: "sessionDetached", sessionId: state.currentSessionId });
			state.currentSessionId = undefined;
			state.latestSnapshotMessages = [];
			state.latestMetadata = undefined;
			state.currentAssistantPartial = undefined;
		}

		bridge.close();
	});

	function schedulePartial(sessionId: string, message: PimuxMessage) {
		const pending = pendingPartials.get(sessionId);
		if (pending) {
			pending.message = message;
			return;
		}

		const timer = setTimeout(() => {
			const latest = pendingPartials.get(sessionId);
			if (!latest) return;
			pendingPartials.delete(sessionId);
			bridge.send({
				type: "assistantPartial",
				sessionId,
				message: latest.message,
			});
		}, PARTIAL_UPDATE_THROTTLE_MS);

		pendingPartials.set(sessionId, { message, timer });
	}

	function cancelPendingPartial(sessionId: string) {
		const pending = pendingPartials.get(sessionId);
		if (!pending) return;
		clearTimeout(pending.timer);
		pendingPartials.delete(sessionId);
	}

	async function attachCurrentSession(ctx: ExtensionContext) {
		const nextSessionId = ctx.sessionManager.getSessionId();
		if (!nextSessionId) return;

		if (state.currentSessionId && state.currentSessionId !== nextSessionId) {
			cancelPendingPartial(state.currentSessionId);
			bridge.send({ type: "sessionDetached", sessionId: state.currentSessionId });
		}

		state.currentSessionId = nextSessionId;
		state.latestSnapshotMessages = buildSnapshotMessages(ctx);
		state.latestMetadata = buildSessionMetadata(ctx, state.latestSnapshotMessages);
		state.currentAssistantPartial = undefined;
		bridge.send({
			type: "sessionAttached",
			sessionId: nextSessionId,
			metadata: state.latestMetadata,
		});
		bridge.send({
			type: "sessionSnapshot",
			sessionId: nextSessionId,
			messages: state.latestSnapshotMessages,
			metadata: state.latestMetadata,
		});
	}

	function publishSnapshot(ctx: ExtensionContext) {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;

		state.currentSessionId = sessionId;
		state.latestSnapshotMessages = buildSnapshotMessages(ctx);
		state.latestMetadata = buildSessionMetadata(ctx, state.latestSnapshotMessages);
		state.currentAssistantPartial = undefined;
		cancelPendingPartial(sessionId);
		bridge.send({
			type: "sessionSnapshot",
			sessionId,
			messages: state.latestSnapshotMessages,
			metadata: state.latestMetadata,
		});
	}
}

function buildSessionMetadata(ctx: ExtensionContext, messages: PimuxMessage[]): PimuxSessionMetadata {
	const header = ctx.sessionManager.getHeader();
	const sessionId = ctx.sessionManager.getSessionId();
	const namedSummary = normalizeDisplayText(ctx.sessionManager.getSessionName());
	const fallbackSummary = summarizeMessages(messages) || sessionId;
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
	const usage = ctx.getContextUsage();
	const contextUsage =
		usage && (typeof usage.tokens === "number" || typeof usage.contextWindow === "number")
			? {
					usedTokens: typeof usage.tokens === "number" ? usage.tokens : undefined,
					maxTokens: typeof usage.contextWindow === "number" ? usage.contextWindow : undefined,
				}
			: undefined;

	return {
		createdAt: toIsoString(header?.timestamp ?? messages[0]?.created_at ?? new Date().toISOString()),
		cwd: ctx.sessionManager.getCwd(),
		summary: namedSummary || fallbackSummary,
		model,
		contextUsage,
	};
}

function summarizeMessages(messages: PimuxMessage[]): string | undefined {
	const firstUser = messages.find((message) => message.role === "user");
	const source = firstUser?.body || messages.find((message) => message.body)?.body;
	if (!source) return undefined;
	const collapsed = collapseWhitespace(source);
	if (!collapsed) return undefined;
	return truncateChars(collapsed, 120);
}

function buildSnapshotMessages(ctx: ExtensionContext): PimuxMessage[] {
	const branch = ctx.sessionManager.getBranch();
	return branch
		.map((entry: any) => entryToPimuxMessage(entry))
		.filter((message): message is PimuxMessage => Boolean(message));
}

function entryToPimuxMessage(entry: any): PimuxMessage | undefined {
	switch (entry?.type) {
		case "message":
			return agentMessageToPimuxMessage(entry.message, entry.timestamp);
		case "custom_message": {
			const text = flattenTextContent(entry.content);
			if (!text) return undefined;
			return pimuxMessageFromText(toIsoString(entry.timestamp), "custom", text);
		}
		case "branch_summary": {
			const text = collapseWhitespace(entry.summary);
			if (!text) return undefined;
			return pimuxMessageFromText(toIsoString(entry.timestamp), "branchSummary", text);
		}
		case "compaction": {
			const text = collapseWhitespace(entry.summary);
			if (!text) return undefined;
			return pimuxMessageFromText(toIsoString(entry.timestamp), "compactionSummary", text);
		}
		default:
			return undefined;
	}
}

function agentMessageToPimuxMessage(message: any, fallbackTimestamp?: string): PimuxMessage | undefined {
	if (!message?.role) return undefined;

	switch (message.role) {
		case "user":
			return pimuxMessageFromBlocks(
				timestampToIso(message.timestamp, fallbackTimestamp),
				"user",
				contentToBlocks(message.content, false)
			);
		case "assistant":
			return pimuxMessageFromBlocks(
				timestampToIso(message.timestamp, fallbackTimestamp),
				"assistant",
				contentToBlocks(message.content, true)
			);
		case "toolResult":
			return pimuxMessageFromBlocks(
				timestampToIso(message.timestamp, fallbackTimestamp),
				"toolResult",
				contentToBlocks(message.content, false),
				typeof message.toolName === "string" ? collapseWhitespace(message.toolName) : undefined
			);
		case "bashExecution": {
			const text = flattenBashExecution(message);
			if (!text) return undefined;
			return pimuxMessageFromText(timestampToIso(message.timestamp, fallbackTimestamp), "bashExecution", text);
		}
		case "custom": {
			const text = flattenTextContent(message.content);
			if (!text) return undefined;
			return pimuxMessageFromText(timestampToIso(message.timestamp, fallbackTimestamp), "custom", text);
		}
		case "branchSummary": {
			const text = collapseWhitespace(message.summary);
			if (!text) return undefined;
			return pimuxMessageFromText(timestampToIso(message.timestamp, fallbackTimestamp), "branchSummary", text);
		}
		case "compactionSummary": {
			const text = collapseWhitespace(message.summary);
			if (!text) return undefined;
			return pimuxMessageFromText(timestampToIso(message.timestamp, fallbackTimestamp), "compactionSummary", text);
		}
		default: {
			const text = flattenTextContent(message.content) ?? collapseWhitespace(message.summary) ?? "";
			if (!text) return undefined;
			return pimuxMessageFromText(timestampToIso(message.timestamp, fallbackTimestamp), "other", text);
		}
	}
}

function pimuxMessageFromText(created_at: string, role: PimuxRole, text: string): PimuxMessage | undefined {
	const normalized = normalizeDisplayText(text);
	if (!normalized) return undefined;
	return {
		created_at,
		role,
		body: normalized,
		blocks: [{ type: "text", text: normalized }],
	};
}

function pimuxMessageFromBlocks(
	created_at: string,
	role: PimuxRole,
	blocks: PimuxMessageBlock[],
	toolName?: string
): PimuxMessage | undefined {
	const normalizedBlocks = blocks
		.map(normalizeBlock)
		.filter((block): block is PimuxMessageBlock => Boolean(block));
	if (normalizedBlocks.length === 0) return undefined;

	return {
		created_at,
		role,
		body: bodyFromBlocks(role, normalizedBlocks),
		toolName: toolName || undefined,
		blocks: normalizedBlocks,
	};
}

function normalizeBlock(block: PimuxMessageBlock | undefined): PimuxMessageBlock | undefined {
	if (!block) return undefined;

	switch (block.type) {
		case "text":
		case "thinking":
		case "other": {
			const text = normalizeDisplayText(block.text);
			if (!text) return undefined;
			return { type: block.type, text };
		}
		case "toolCall": {
			const toolCallName = collapseWhitespace(block.toolCallName);
			if (!toolCallName) return undefined;
			const text = normalizeDisplayText(block.text);
			return text ? { type: "toolCall", toolCallName, text } : { type: "toolCall", toolCallName };
		}
		case "image": {
			const mimeType = normalizeMimeType(block.mimeType);
			const data = normalizeImageData(block.data);
			if (!data) return mimeType ? { type: "image", mimeType } : { type: "image" };
			return mimeType ? { type: "image", mimeType, data } : { type: "image", data };
		}
		default:
			return undefined;
	}
}

function bodyFromBlocks(role: PimuxRole, blocks: PimuxMessageBlock[]): string {
	const parts = blocks.flatMap((block) => {
		if (block.type === "text" && block.text) return [block.text];
		if (role === "assistant" && block.type === "toolCall" && block.toolCallName) {
			return [`Tool call: ${block.toolCallName}`];
		}
		return [];
	});
	if (parts.length > 0) {
		return parts.join("\n\n");
	}

	const imageCount = blocks.filter((block) => block.type === "image").length;
	if (imageCount === 1) return "[Image]";
	if (imageCount > 1) return `[${imageCount} images]`;
	return "";
}

function toolCallSummary(toolName: string, args: any): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;

	switch (toolName) {
		case "read": {
			if (typeof args.path !== "string") return undefined;
			let summary = args.path;
			const options: string[] = [];
			if (typeof args.offset === "number") options.push(`offset=${args.offset}`);
			if (typeof args.limit === "number") options.push(`limit=${args.limit}`);
			if (options.length > 0) summary += ` (${options.join(", ")})`;
			return normalizeDisplayText(summary);
		}
		case "bash": {
			if (typeof args.command !== "string") return undefined;
			let summary = `$ ${args.command}`;
			if (typeof args.timeout === "number") summary += `\n\ntimeout: ${args.timeout}s`;
			return normalizeDisplayText(summary);
		}
		case "edit": {
			if (typeof args.path !== "string") return undefined;
			const lines = [args.path];
			if (Array.isArray(args.edits)) {
				lines.push(`${args.edits.length} ${args.edits.length === 1 ? "edit" : "edits"}`);
			} else if (typeof args.oldText === "string" || typeof args.newText === "string") {
				lines.push("single replacement");
			}
			return normalizeDisplayText(lines.join("\n\n"));
		}
		case "write": {
			if (typeof args.path !== "string") return undefined;
			const lines = [args.path];
			if (typeof args.content === "string") {
				lines.push(`${Math.max(args.content.split("\n").length, 1)} lines`);
			}
			return normalizeDisplayText(lines.join("\n\n"));
		}
		case "mcp": {
			const lines: string[] = [];
			for (const key of ["tool", "server", "connect", "describe", "search", "action"]) {
				if (typeof args[key] === "string" && args[key].trim()) {
					lines.push(`${key}: ${args[key].trim()}`);
				}
			}
			if (typeof args.args === "string" && args.args.trim()) {
				lines.push(`args: ${truncateSummary(args.args, 500)}`);
			}
			if (lines.length > 0) return lines.join("\n");
			return prettyJsonSummary(args);
		}
		case "multi_tool_use.parallel": {
			if (!Array.isArray(args.tool_uses)) return undefined;
			const count = args.tool_uses.length;
			return `${count} parallel ${count === 1 ? "tool call" : "tool calls"}`;
		}
		default:
			return prettyJsonSummary(args);
	}
}

function prettyJsonSummary(value: any): string | undefined {
	try {
		const pretty = JSON.stringify(value, null, 2);
		return normalizeDisplayText(truncateSummary(pretty, 2000));
	} catch {
		return undefined;
	}
}

function truncateSummary(value: string, maxChars: number): string {
	const chars = [...value];
	if (chars.length <= maxChars) return value;
	return `${chars.slice(0, maxChars).join("")}…`;
}

function contentToBlocks(content: any, includeToolCalls: boolean): PimuxMessageBlock[] {
	if (typeof content === "string") {
		const text = normalizeDisplayText(content);
		return text ? [{ type: "text", text }] : [];
	}

	if (!Array.isArray(content)) return [];

	return content
		.map((block): PimuxMessageBlock | undefined => {
			switch (block?.type) {
				case "text": {
					const text = normalizeDisplayText(block.text);
					return text ? ({ type: "text", text } satisfies PimuxMessageBlock) : undefined;
				}
				case "thinking": {
					const text = normalizeDisplayText(block.thinking);
					return text ? ({ type: "thinking", text } satisfies PimuxMessageBlock) : undefined;
				}
				case "toolCall": {
					if (!includeToolCalls || typeof block.name !== "string") return undefined;
					const toolCallName = collapseWhitespace(block.name);
					if (!toolCallName) return undefined;
					const text = toolCallSummary(toolCallName, block.arguments);
					return text
						? ({ type: "toolCall", toolCallName, text } satisfies PimuxMessageBlock)
						: ({ type: "toolCall", toolCallName } satisfies PimuxMessageBlock);
				}
				case "image": {
					const mimeType = normalizeMimeType(block.mimeType);
					const data = normalizeImageData(block.data);
					if (mimeType && data) return { type: "image", mimeType, data } satisfies PimuxMessageBlock;
					if (mimeType) return { type: "image", mimeType } satisfies PimuxMessageBlock;
					if (data) return { type: "image", data } satisfies PimuxMessageBlock;
					return { type: "image" } satisfies PimuxMessageBlock;
				}
				default:
					return undefined;
			}
		})
		.filter((block): block is PimuxMessageBlock => Boolean(block));
}

function flattenTextContent(content: any): string | undefined {
	const text = contentToBlocks(content, false)
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.filter((text): text is string => Boolean(text))
		.join("\n\n");
	return text || undefined;
}

function flattenBashExecution(message: any): string | undefined {
	const parts: string[] = [];

	if (typeof message.command === "string") {
		const command = normalizeDisplayText(message.command);
		if (command) parts.push(`$ ${command}`);
	}

	if (typeof message.output === "string") {
		const output = normalizeDisplayText(message.output);
		if (output) parts.push(output);
	}

	const metadata: string[] = [];
	if (typeof message.exitCode === "number") metadata.push(`exit code: ${message.exitCode}`);
	if (message.cancelled === true) metadata.push("cancelled");
	if (message.truncated === true) metadata.push("truncated");
	if (typeof message.fullOutputPath === "string") {
		const path = normalizeDisplayText(message.fullOutputPath);
		if (path) metadata.push(`full output: ${path}`);
	}
	if (metadata.length > 0) parts.push(metadata.join("\n"));

	const body = parts.join("\n\n");
	return body || undefined;
}

function timestampToIso(timestamp: unknown, fallbackTimestamp?: string): string {
	if (typeof timestamp === "number") {
		return new Date(timestamp).toISOString();
	}

	if (typeof fallbackTimestamp === "string") {
		return toIsoString(fallbackTimestamp);
	}

	return new Date().toISOString();
}

function toIsoString(timestamp: unknown): string {
	if (typeof timestamp === "string") {
		return new Date(timestamp).toISOString();
	}
	if (typeof timestamp === "number") {
		return new Date(timestamp).toISOString();
	}
	return new Date().toISOString();
}

function normalizeDisplayText(value: unknown): string {
	if (typeof value !== "string") return "";
	const normalized = value.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
	return normalized.trim().length > 0 ? normalized : "";
}

function collapseWhitespace(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.split(/\s+/).filter(Boolean).join(" ");
}

function normalizeMimeType(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim().toLowerCase();
}

function normalizeImageData(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.replace(/\s+/g, "");
}

function truncateChars(value: string, maxChars: number): string {
	const chars = Array.from(value);
	if (chars.length <= maxChars) return value;
	return `${chars.slice(0, maxChars).join("")}…`;
}

function resolveSocketPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, "pimux", "live.sock");
}
