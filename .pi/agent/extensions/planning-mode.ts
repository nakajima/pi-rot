import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface SavedPlan {
	text: string;
	updatedAt: number;
}

interface PlanningState {
	active: boolean;
	startedAt?: number;
	lastPlan?: SavedPlan;
}

const STATE_ENTRY = "planning-mode-state";
const STATUS_ID = "planning-mode";
const WIDGET_ID = "planning-mode";
const MAX_PLAN_CHARS = 6000;
const MAX_PLAN_PREVIEW = 140;
const IMPLEMENTATION_INTENT = [
	/\bgo ahead\b/i,
	/\bstart implementing\b/i,
	/\bimplement it\b/i,
	/\bok implement\b/i,
	/\bwrite the code\b/i,
	/\bbuild it\b/i,
	/\bship it\b/i,
	/^\s*(can|could|would|will)\s+you\s+.*\b(implement|build|code|write)\b/i,
];
const MUTATING_BASH_PATTERNS = [
	/(^|\s)rm\s/i,
	/(^|\s)mv\s/i,
	/(^|\s)cp\s/i,
	/(^|\s)mkdir\s/i,
	/(^|\s)rmdir\s/i,
	/(^|\s)touch\s/i,
	/(^|\s)chmod\s/i,
	/(^|\s)chown\s/i,
	/(^|\s)ln\s/i,
	/(^|\s)tee\s/i,
	/(^|\s)sed\s+-i\b/i,
	/(^|\s)perl\s+-pi\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|checkout|switch|restore|reset|clean|stash|apply|am)\b/i,
	/\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|update|up)\b/i,
	/\bcargo\s+(add|remove|install)\b/i,
	/\bpip\s+install\b/i,
	/\bpoetry\s+(add|remove|install)\b/i,
	/\bgo\s+get\b/i,
	/\bdocker\s+(build|run|compose|rm)\b/i,
	/\bkubectl\s+apply\b/i,
];
const PlanningModeExitParams = Type.Object({
	reason: Type.Optional(Type.String({ description: "Short reason for leaving planning mode and starting implementation." })),
});

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxLength: number): string {
	const normalized = normalizeWhitespace(text);
	return normalized.length > maxLength ? `${normalized.slice(0, Math.max(1, maxLength - 3))}...` : normalized;
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

function looksLikeImplementationIntent(text: string): boolean {
	return IMPLEMENTATION_INTENT.some((pattern) => pattern.test(text));
}

function looksLikePlan(text: string): boolean {
	const normalized = text.toLowerCase();
	if (
		normalized.includes("goal:") ||
		normalized.includes("plan:") ||
		normalized.includes("steps:") ||
		normalized.includes("implementation plan:") ||
		normalized.includes("constraints:") ||
		normalized.includes("open questions:")
	) {
		return true;
	}

	const lines = text.split(/\r?\n/).map((line) => line.trim());
	const bulletLines = lines.filter((line) => /^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line));
	return bulletLines.length >= 3;
}

function isMutatingBashCommand(command: string): boolean {
	const normalized = command.trim();
	if (!normalized) return false;
	if (/(^|[^<])>>?\s*[^&|]/.test(normalized)) return true;
	return MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function summarizePlan(text: string): string {
	const nonEmptyLines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const preferredLine = nonEmptyLines.find((line) => !/^#{1,6}\s+/.test(line) && !/^(goal|constraints|plan|steps|implementation plan|open questions):\s*$/i.test(line));
	return truncateText(preferredLine ?? nonEmptyLines[0] ?? "Plan in progress", MAX_PLAN_PREVIEW);
}

function restoreState(ctx: ExtensionContext): PlanningState {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as {
			type?: string;
			customType?: string;
			data?: Partial<PlanningState>;
		};
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		const lastPlan =
			entry.data?.lastPlan &&
			typeof entry.data.lastPlan === "object" &&
			typeof entry.data.lastPlan.text === "string" &&
			typeof entry.data.lastPlan.updatedAt === "number"
				? {
					text: entry.data.lastPlan.text,
					updatedAt: entry.data.lastPlan.updatedAt,
				}
				: undefined;
		return {
			active: entry.data?.active === true,
			startedAt: typeof entry.data?.startedAt === "number" ? entry.data.startedAt : undefined,
			lastPlan,
		};
	}

	return { active: false };
}

export default function planningModeExtension(pi: ExtensionAPI) {
	let state: PlanningState = { active: false };

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

		ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", "planning"));
		const lines = [
			ctx.ui.theme.fg("accent", "Planning mode active"),
			ctx.ui.theme.fg("dim", "Inspect, clarify, and plan. No code changes."),
		];
		if (state.lastPlan?.text) {
			lines.push(ctx.ui.theme.fg("muted", `Latest plan: ${summarizePlan(state.lastPlan.text)}`));
		}
		ctx.ui.setWidget(WIDGET_ID, lines);
	}

	function applyState(nextState: PlanningState, ctx: ExtensionContext, message?: string): void {
		state = nextState;
		persistState();
		updateUI(ctx);
		if (message) ctx.ui.notify(message, "info");
	}

	function setPlanningMode(active: boolean, ctx: ExtensionContext, reason?: string): void {
		if (active === state.active) {
			const label = active ? "Planning mode is already active." : "Planning mode is already off.";
			ctx.ui.notify(reason ?? label, "info");
			return;
		}

		applyState(
			{
				...state,
				active,
				startedAt: active ? Date.now() : undefined,
			},
			ctx,
			reason ?? (active ? "Planning mode active." : "Planning mode off."),
		);
	}

	function showStatus(ctx: ExtensionContext): void {
		const mode = state.active ? "active" : "off";
		const latest = state.lastPlan?.text ? ` Latest plan: ${summarizePlan(state.lastPlan.text)}` : "";
		ctx.ui.notify(`Planning mode is ${mode}.${latest}`, "info");
	}

	pi.registerCommand("plan", {
		description: "Toggle planning mode on/off",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (!command) {
				setPlanningMode(!state.active, ctx);
				return;
			}

			if (command === "on") {
				setPlanningMode(true, ctx);
				return;
			}

			if (command === "off") {
				setPlanningMode(false, ctx);
				return;
			}

			if (command === "status") {
				showStatus(ctx);
				return;
			}

			ctx.ui.notify("Usage: /plan [on|off|status]", "warning");
		},
	});

	pi.registerShortcut("shift+tab", {
		description: "Toggle planning mode",
		handler: async (ctx) => {
			setPlanningMode(!state.active, ctx);
		},
	});

	pi.registerTool({
		name: "request_planning_mode_exit",
		label: "Request planning mode exit",
		description: "Ask to leave planning mode so implementation can start. In interactive mode, this prompts the user for confirmation.",
		promptSnippet: "Request permission to leave planning mode and start implementing.",
		promptGuidelines: [
			"Use request_planning_mode_exit when planning mode is still active but you are ready to implement.",
			"Pass a short reason for why planning is complete or why implementation should begin now.",
			"If the user declines, stay in planning mode and continue planning.",
		],
		parameters: PlanningModeExitParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.active) {
				return {
					content: [{ type: "text", text: "Planning mode is already off. You may implement." }],
					details: { active: false, exited: false, approved: true },
				};
			}

			const reason = typeof params.reason === "string" ? normalizeWhitespace(params.reason) : "";
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Planning mode is active, but exiting it from a tool requires interactive confirmation. Ask the user to turn planning mode off or explicitly tell you to implement." }],
					details: { active: true, exited: false, approved: false, needsInteractiveConfirmation: true, reason },
				};
			}

			const confirmed = await ctx.ui.confirm(
				"Leave planning mode?",
				reason
					? `Pi wants to leave planning mode and start implementing.\n\nReason:\n${reason}`
					: "Pi wants to leave planning mode and start implementing.",
			);
			if (!confirmed) {
				ctx.ui.notify("Stayed in planning mode.", "info");
				return {
					content: [{ type: "text", text: "User kept planning mode on. Continue planning and do not implement yet." }],
					details: { active: true, exited: false, approved: false, reason },
				};
			}

			setPlanningMode(false, ctx, "Leaving planning mode. Implementation can continue.");
			return {
				content: [{ type: "text", text: "Planning mode is now off. You may implement in this turn." }],
				details: { active: false, exited: true, approved: true, reason },
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		state = restoreState(ctx);
		updateUI(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		state = restoreState(ctx);
		updateUI(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		state = restoreState(ctx);
		updateUI(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (!state.active || event.source === "extension") return { action: "continue" as const };
		const text = event.text.trim();
		if (!text || text.startsWith("/")) return { action: "continue" as const };
		if (!looksLikeImplementationIntent(text)) return { action: "continue" as const };

		applyState(
			{
				...state,
				active: false,
				startedAt: undefined,
			},
			ctx,
			"Leaving planning mode. Implementation can continue.",
		);
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.active) return;
		const currentPlan = state.lastPlan?.text ? `\n\nCurrent working plan:\n${state.lastPlan.text}` : "";
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n[PLANNING MODE]\nYou are in planning mode.\n\nRules:\n- Do not edit files, write files, or run mutating shell commands.\n- Prefer repo inspection, clarification, tradeoff analysis, and step-by-step planning.\n- Default to concise planning output rather than implementation.\n- If useful, structure the response as Goal, Constraints, Plan, and Open questions.\n- If you are ready to implement but planning mode is still on, use the request_planning_mode_exit tool to ask for approval. If it succeeds, planning mode is off for the rest of this turn and you may implement immediately.\n- Stay in planning mode until the user clearly asks to start implementing.${currentPlan}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state.active) return;

		if (event.toolName === "edit" || event.toolName === "write") {
			if (ctx.hasUI) ctx.ui.notify("Blocked file mutation in planning mode.", "warning");
			return {
				block: true,
				reason: "Planning mode is active. Do not modify files until the user leaves planning mode.",
			};
		}

		if (isToolCallEventType("bash", event) && isMutatingBashCommand(event.input.command)) {
			if (ctx.hasUI) ctx.ui.notify("Blocked mutating shell command in planning mode.", "warning");
			return {
				block: true,
				reason: "Planning mode is active. Mutating shell commands are blocked until the user leaves planning mode.",
			};
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!state.active) return;
		const message = event.message as { role?: string; content?: unknown };
		if (message.role !== "assistant") return;
		const text = getMessageText(message);
		if (!text || !looksLikePlan(text)) return;

		const normalized = text.length > MAX_PLAN_CHARS ? `${text.slice(0, MAX_PLAN_CHARS)}\n...` : text;
		if (state.lastPlan?.text === normalized) return;
		applyState(
			{
				...state,
				lastPlan: {
					text: normalized,
					updatedAt: Date.now(),
				},
			},
			ctx,
		);
	});
}
