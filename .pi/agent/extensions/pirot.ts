import { homedir } from "node:os";
import { join } from "node:path";
import { complete, getModel } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { requestReloadForOtherInteractiveSessions } from "./reload-coordinator";

const PIROT_REPO_DIR = join(homedir(), "apps", "pirot");

function subcommandCompletions(prefix: string): AutocompleteItem[] | null {
	const items: AutocompleteItem[] = [
		{ value: "sync", label: "sync" },
		{ value: "install-server", label: "install-server" },
		{ value: "uninstall-server", label: "uninstall-server" },
		{ value: "restart-server", label: "restart-server" },
	];
	const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
	return filtered.length > 0 ? filtered : null;
}

async function summarizeChanges(ctx: ExtensionCommandContext, diff: string): Promise<string> {
	const model = getModel("anthropic", "claude-haiku-4-5");
	if (!model) return "";
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return "";

	const truncated = diff.length > 8000 ? `${diff.slice(0, 8000)}\n... (truncated)` : diff;
	const response = await complete(
		model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: `Summarize these git changes in 1-2 concise sentences describing what was changed and why (infer intent). No markdown, no bullet points, just plain text.\n\n${truncated}` }],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey: auth.apiKey },
	);
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
}

async function handleLocalChanges(pi: ExtensionAPI, ctx: ExtensionCommandContext, repoRoot: string): Promise<boolean> {
	const statusResult = await pi.exec("git", ["status", "--porcelain"], { cwd: repoRoot, timeout: 10_000 });
	if (statusResult.code !== 0 || !statusResult.stdout.trim()) {
		return true; // No local changes (or error checking), proceed with pull
	}

	ctx.ui.notify("Summarizing local changes...", "info");

	// Get the full diff for summarization
	const diffResult = await pi.exec("git", ["diff", "HEAD"], { cwd: repoRoot, timeout: 10_000 });
	const lines = statusResult.stdout.trim().split("\n");
	const untracked = lines.filter((l) => l.startsWith("??")).map((l) => l.substring(3));

	// Include untracked file contents in the diff context
	let fullDiff = diffResult.stdout || "";
	for (const file of untracked.slice(0, 5)) {
		const cat = await pi.exec("head", ["-c", "2000", file], { cwd: repoRoot, timeout: 5_000 });
		if (cat.code === 0 && cat.stdout) fullDiff += `\n--- /dev/null\n+++ b/${file}\n${cat.stdout}`;
	}

	const summary = await summarizeChanges(ctx, fullDiff);
	const fileCount = lines.length;

	if (summary) {
		ctx.ui.notify(summary, "info");
	}

	const confirmMsg = summary
		? `${summary}\n\n${fileCount} file${fileCount === 1 ? "" : "s"} changed. Commit and push before pulling?`
		: `${fileCount} file${fileCount === 1 ? "" : "s"} changed. Commit and push before pulling?`;
	const shouldPush = await ctx.ui.confirm("Local changes", confirmMsg);
	if (!shouldPush) {
		return true; // User declined, proceed with pull anyway
	}

	// Stage all changes
	const addResult = await pi.exec("git", ["add", "-A"], { cwd: repoRoot, timeout: 10_000 });
	if (addResult.code !== 0) {
		ctx.ui.notify(`Failed to stage changes: ${(addResult.stderr || addResult.stdout).trim()}`, "error");
		return false;
	}

	// Use the LLM summary as the commit message, or fall back to file list
	const commitMsg = summary || `sync: ${fileCount} file${fileCount === 1 ? "" : "s"} changed`;
	const commitResult = await pi.exec("git", ["commit", "-m", commitMsg], { cwd: repoRoot, timeout: 30_000 });
	if (commitResult.code !== 0) {
		ctx.ui.notify(`Commit failed: ${(commitResult.stderr || commitResult.stdout).trim()}`, "error");
		return false;
	}

	// Push
	ctx.ui.notify("Pushing...", "info");
	const pushResult = await pi.exec("git", ["push"], { cwd: repoRoot, timeout: 120_000 });
	if (pushResult.code !== 0) {
		ctx.ui.notify(`Push failed: ${(pushResult.stderr || pushResult.stdout).trim()}`, "error");
		return false;
	}

	ctx.ui.notify("Pushed.", "info");
	return true;
}

async function handleSync(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const repoRoot = PIROT_REPO_DIR;
	const repoCheckResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: repoRoot, timeout: 10_000 });
	if (repoCheckResult.code !== 0) {
		const message = (repoCheckResult.stderr || repoCheckResult.stdout || "Unable to access ~/apps/pirot").trim();
		ctx.ui.notify(`Pirot repo unavailable at ${repoRoot}: ${message}`, "error");
		return;
	}

	// Handle local changes first (commit + push if user agrees)
	const proceed = await handleLocalChanges(pi, ctx, repoRoot);
	if (!proceed) {
		return;
	}

	ctx.ui.notify(`Pulling ${repoRoot}...`, "info");
	const pullResult = await pi.exec("git", ["pull", "--ff-only"], { cwd: repoRoot, timeout: 120_000 });
	if (pullResult.code !== 0) {
		const message = (pullResult.stderr || pullResult.stdout || "git pull failed").trim();
		ctx.ui.notify(`Pull failed: ${message}`, "error");
		return;
	}

	// Restart the pimux2000 server if installed
	const serverCli = join(PIROT_REPO_DIR, "server", "src", "cli.ts");
	const restartResult = await pi.exec("bun", ["run", serverCli, "restart-server"], {
		cwd: PIROT_REPO_DIR,
		timeout: 15_000,
	});
	if (restartResult.code === 0) {
		ctx.ui.notify("Restarted pimux2000 server.", "info");
	}

	const { requested, interactiveCount, skipped } = await requestReloadForOtherInteractiveSessions(process.pid, {
		reason: "pirot-sync",
	});
	ctx.ui.notify(`Synced ${repoRoot}; reloading sessions...`, "info");
	if (skipped.length > 0) {
		ctx.ui.notify(`Skipped: ${skipped.slice(0, 4).join(", ")}${skipped.length > 4 ? ", …" : ""}`, "warning");
	}
	if (interactiveCount === 1) {
		ctx.ui.notify("No other active interactive sessions found.", "info");
	} else if (requested > 0) {
		ctx.ui.notify(`Queued /reload for ${requested} other active session${requested === 1 ? "" : "s"}.`, "info");
	}
	await ctx.reload();
	return;
}

async function handleServerCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, command: string): Promise<void> {
	const serverCli = join(PIROT_REPO_DIR, "server", "src", "cli.ts");
	ctx.ui.notify(`Running ${command}...`, "info");

	const result = await pi.exec("bun", ["run", serverCli, command], {
		cwd: PIROT_REPO_DIR,
		timeout: 30_000,
	});

	if (result.code !== 0) {
		const msg = (result.stderr || result.stdout || "unknown error").trim();
		ctx.ui.notify(`${command} failed: ${msg}`, "error");
		return;
	}

	const output = (result.stdout || "").trim();
	if (output) {
		ctx.ui.notify(output, "info");
	} else {
		ctx.ui.notify(`${command} completed.`, "info");
	}
}

export default function pirotExtension(pi: ExtensionAPI) {
	pi.registerCommand("pirot", {
		description: "Pirot repo commands",
		getArgumentCompletions: subcommandCompletions,
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "sync") {
				await handleSync(pi, ctx);
				return;
			}

			if (trimmed === "install-server" || trimmed === "uninstall-server" || trimmed === "restart-server") {
				await handleServerCommand(pi, ctx, trimmed);
				return;
			}

			ctx.ui.notify("Usage: /pirot sync | install-server | uninstall-server | restart-server", "info");
		},
	});
}
