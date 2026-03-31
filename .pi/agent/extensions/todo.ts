import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const TODO_FILENAME = "todo.txt";
const MAX_SESSION_NAME = 80;

function getTodoPath(ctx: Pick<ExtensionCommandContext, "cwd">): string {
	return join(ctx.cwd, TODO_FILENAME);
}

async function readTodoFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

function parseTodoItems(raw: string): string[] {
	return raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

function normalizeSessionName(text: string): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= MAX_SESSION_NAME) return singleLine;
	return `${singleLine.slice(0, MAX_SESSION_NAME - 1).trimEnd()}…`;
}

async function appendTodo(path: string, body: string): Promise<"created" | "appended"> {
	const trimmed = body.trim();
	if (!trimmed) {
		throw new Error("Todo text cannot be empty");
	}

	await mkdir(dirname(path), { recursive: true });

	const existing = await readTodoFile(path);
	if (existing === undefined) {
		await writeFile(path, `${trimmed}\n`, "utf8");
		return "created";
	}

	const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
	await appendFile(path, `${prefix}${trimmed}\n`, "utf8");
	return "appended";
}

async function startTodoSession(pi: ExtensionAPI, ctx: ExtensionCommandContext, todoText: string): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Waiting for the current work to finish...", "info");
		await ctx.waitForIdle();
	}

	const newSession = await ctx.newSession({
		parentSession: ctx.sessionManager.getSessionFile(),
	});
	if (newSession.cancelled) {
		ctx.ui.notify("New session cancelled.", "info");
		return;
	}

	pi.setSessionName(normalizeSessionName(todoText));
	pi.sendUserMessage(todoText);
}

export default function todoExtension(pi: ExtensionAPI) {
	pi.registerCommand("todo", {
		description: "Append to ./todo.txt, or choose a todo to start a new session",
		handler: async (args, ctx) => {
			const body = args.trim();
			const todoPath = getTodoPath(ctx);

			if (body) {
				const action = await appendTodo(todoPath, body);
				ctx.ui.notify(`${action === "created" ? "Created" : "Appended to"} ${todoPath}`, "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/todo without a body requires interactive mode", "warning");
				return;
			}

			const raw = await readTodoFile(todoPath);
			if (raw === undefined) {
				ctx.ui.notify(`No ${TODO_FILENAME} found at ${todoPath}. Use /todo <text> to create it.`, "warning");
				return;
			}

			const items = parseTodoItems(raw);
			if (items.length === 0) {
				ctx.ui.notify(`${todoPath} is empty. Use /todo <text> to add a task.`, "warning");
				return;
			}

			const menuItems = items.map((item, index) => ({
				label: `${index + 1}. ${item}`,
				value: item,
			}));
			const selectedLabel = await ctx.ui.select(
				`Start a new session from ${TODO_FILENAME}`,
				menuItems.map((item) => item.label),
			);
			if (!selectedLabel) return;

			const selected = menuItems.find((item) => item.label === selectedLabel);
			if (!selected) {
				ctx.ui.notify("Couldn't resolve the selected todo item.", "error");
				return;
			}

			await startTodoSession(pi, ctx, selected.value);
		},
	});
}
