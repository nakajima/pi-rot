import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { requestReloadForOtherInteractiveSessions } from "./reload-coordinator";

const PIROT_REPO_DIR = join(homedir(), "apps", "pirot");

function syncCompletions(prefix: string): AutocompleteItem[] | null {
	const items: AutocompleteItem[] = [{ value: "sync", label: "sync" }];
	const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
	return filtered.length > 0 ? filtered : null;
}

async function handleLocalChanges(pi: ExtensionAPI, ctx: ExtensionCommandContext, repoRoot: string): Promise<boolean> {
	const statusResult = await pi.exec("git", ["status", "--porcelain"], { cwd: repoRoot, timeout: 10_000 });
	if (statusResult.code !== 0 || !statusResult.stdout.trim()) {
		return true; // No local changes (or error checking), proceed with pull
	}

	const lines = statusResult.stdout.trim().split("\n");
	const summary = lines
		.map((line) => {
			const status = line.substring(0, 2).trim();
			const file = line.substring(3);
			const label = status === "M" ? "modified" : status === "A" ? "added" : status === "D" ? "deleted" : status === "??" ? "untracked" : status;
			return `  ${label}: ${file}`;
		})
		.join("\n");

	ctx.ui.notify(`Local changes found:\n${summary}`, "warning");

	const shouldPush = await ctx.ui.confirm("Local changes", `${lines.length} local change${lines.length === 1 ? "" : "s"} found. Commit and push before pulling?`);
	if (!shouldPush) {
		return true; // User declined, proceed with pull anyway
	}

	// Stage all changes
	const addResult = await pi.exec("git", ["add", "-A"], { cwd: repoRoot, timeout: 10_000 });
	if (addResult.code !== 0) {
		ctx.ui.notify(`Failed to stage changes: ${(addResult.stderr || addResult.stdout).trim()}`, "error");
		return false;
	}

	// Commit
	const commitMsg = `sync: ${lines.length} file${lines.length === 1 ? "" : "s"} changed`;
	const commitResult = await pi.exec("git", ["commit", "-m", commitMsg], { cwd: repoRoot, timeout: 30_000 });
	if (commitResult.code !== 0) {
		ctx.ui.notify(`Commit failed: ${(commitResult.stderr || commitResult.stdout).trim()}`, "error");
		return false;
	}

	// Push
	ctx.ui.notify("Pushing local changes...", "info");
	const pushResult = await pi.exec("git", ["push"], { cwd: repoRoot, timeout: 120_000 });
	if (pushResult.code !== 0) {
		ctx.ui.notify(`Push failed: ${(pushResult.stderr || pushResult.stdout).trim()}`, "error");
		return false;
	}

	ctx.ui.notify("Local changes pushed.", "success");
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

export default function pirotExtension(pi: ExtensionAPI) {
	pi.registerCommand("pirot", {
		description: "Pirot repo commands",
		getArgumentCompletions: syncCompletions,
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "sync") {
				await handleSync(pi, ctx);
				return;
			}

			ctx.ui.notify("Usage: /pirot sync", "info");
		},
	});
}
