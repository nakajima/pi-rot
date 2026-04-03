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

const DELETE_PREFIX = "   delete";

function buildSelectLabels(items: string[]): string[] {
	const labels: string[] = [];
	for (let i = 0; i < items.length; i++) {
		labels.push(`${i + 1}. ${items[i]}`);
		labels.push(DELETE_PREFIX);
	}
	return labels;
}

function isDeleteLabel(label: string): boolean {
	return label === DELETE_PREFIX;
}

function itemIndexFromDeleteLabel(labels: string[], selectedIndex: number): number {
	return Math.floor(selectedIndex / 2);
}

async function removeTodoItem(path: string, items: string[], indexToRemove: number): Promise<string[]> {
	const remaining = items.filter((_, i) => i !== indexToRemove);
	if (remaining.length === 0) {
		await writeFile(path, "", "utf8");
	} else {
		await writeFile(path, remaining.join("\n") + "\n", "utf8");
	}
	return remaining;
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

			let currentItems = items;

			while (currentItems.length > 0) {
				const labels = buildSelectLabels(currentItems);
				const selectedLabel = await ctx.ui.select(
					`Start a new session from ${TODO_FILENAME}`,
					labels,
				);
				if (!selectedLabel) return;

				const selectedIndex = labels.indexOf(selectedLabel);
				if (selectedIndex === -1) {
					ctx.ui.notify("Couldn't resolve the selected todo item.", "error");
					return;
				}

				if (isDeleteLabel(selectedLabel)) {
					const itemIndex = itemIndexFromDeleteLabel(labels, selectedIndex);
					const itemText = currentItems[itemIndex];
					const confirmed = await ctx.ui.confirm(`Delete "${itemText}"?`);
					if (confirmed) {
						currentItems = await removeTodoItem(todoPath, currentItems, itemIndex);
						if (currentItems.length === 0) {
							ctx.ui.notify(`${TODO_FILENAME} is now empty.`, "info");
							return;
						}
					}
					continue;
				}

				// Selected a todo item — start a session
				const itemIndex = Math.floor(selectedIndex / 2);
				await startTodoSession(pi, ctx, currentItems[itemIndex]);
				return;
			}
		},
	});
}
