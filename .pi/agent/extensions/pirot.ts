import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

interface ActiveSessionRecord {
	pid: number;
	cwd: string;
	sessionFile: string | null;
	sessionId: string;
	sessionName?: string;
	model?: {
		provider: string;
		id: string;
	};
	startedAt: string;
	lastSeenAt: string;
	mode: "interactive" | "rpc" | "json" | "print" | "unknown";
	workSummary?: string;
	workSummaryUpdatedAt?: string;
}

const REGISTRY_DIR = join(getAgentDir(), "runtime", "instances");

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function normalizeTtyPath(value: string): string | undefined {
	const tty = value.trim();
	if (!tty || tty === "?") return undefined;
	return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
}

function isActiveSessionRecord(value: unknown): value is ActiveSessionRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<ActiveSessionRecord>;
	return (
		typeof record.pid === "number" &&
		Number.isFinite(record.pid) &&
		typeof record.cwd === "string" &&
		typeof record.sessionId === "string" &&
		typeof record.startedAt === "string" &&
		typeof record.lastSeenAt === "string" &&
		(record.mode === "interactive" || record.mode === "rpc" || record.mode === "json" || record.mode === "print" || record.mode === "unknown")
	);
}

async function readRegistryEntries(): Promise<ActiveSessionRecord[]> {
	const files = await readdir(REGISTRY_DIR).catch(() => [] as string[]);
	const entries: ActiveSessionRecord[] = [];

	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const path = join(REGISTRY_DIR, file);
		try {
			const raw = await readFile(path, "utf8");
			const parsed = JSON.parse(raw) as unknown;
			if (!isActiveSessionRecord(parsed)) continue;
			if (!isProcessAlive(parsed.pid)) continue;
			entries.push(parsed);
		} catch {
			// Ignore malformed or concurrently rewritten registry entries.
		}
	}

	return entries.sort((a, b) => a.pid - b.pid);
}

async function reloadOtherActiveSessions(pi: ExtensionAPI, currentPid: number): Promise<{ reloadedViaTmux: number; interactiveCount: number; skipped: string[] }> {
	const sessions = await readRegistryEntries();
	const interactiveSessions = sessions.filter((session) => session.mode === "interactive");
	const otherInteractiveSessions = interactiveSessions.filter((session) => session.pid !== currentPid);
	let reloadedViaTmux = 0;
	const skipped: string[] = [];

	if (otherInteractiveSessions.length === 0) {
		return { reloadedViaTmux, interactiveCount: interactiveSessions.length, skipped };
	}

	const paneResult = await pi.exec("tmux", ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_tty}"], { timeout: 5_000 }).catch(() => ({
		stdout: "",
		stderr: "",
		code: 1,
		killed: false,
	}));

	if (paneResult.code !== 0) {
		skipped.push(`${otherInteractiveSessions.length} non-current session${otherInteractiveSessions.length === 1 ? "" : "s"}: tmux is unavailable`);
		return { reloadedViaTmux, interactiveCount: interactiveSessions.length, skipped };
	}

	const paneByTty = new Map<string, string>();
	for (const line of paneResult.stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [paneId, paneTty] = trimmed.split("\t");
		const normalizedTty = normalizeTtyPath(paneTty ?? "");
		if (!paneId || !normalizedTty) continue;
		paneByTty.set(normalizedTty, paneId);
	}

	for (const session of otherInteractiveSessions) {
		const ttyResult = await pi.exec("ps", ["-o", "tty=", "-p", String(session.pid)], { timeout: 5_000 }).catch(() => ({
			stdout: "",
			stderr: "",
			code: 1,
			killed: false,
		}));
		const ttyPath = normalizeTtyPath(ttyResult.stdout);
		if (ttyResult.code !== 0 || !ttyPath) {
			skipped.push(`${session.pid}: tty unavailable`);
			continue;
		}

		const paneId = paneByTty.get(ttyPath);
		if (!paneId) {
			skipped.push(`${session.pid}: not running in tmux`);
			continue;
		}

		const sendResult = await pi.exec("tmux", ["send-keys", "-t", paneId, "/reload", "Enter"], { timeout: 5_000 }).catch(() => ({
			stdout: "",
			stderr: "",
			code: 1,
			killed: false,
		}));
		if (sendResult.code !== 0) {
			skipped.push(`${session.pid}: tmux send-keys failed`);
			continue;
		}

		reloadedViaTmux += 1;
	}

	return { reloadedViaTmux, interactiveCount: interactiveSessions.length, skipped };
}

function syncCompletions(prefix: string): AutocompleteItem[] | null {
	const items: AutocompleteItem[] = [{ value: "sync", label: "sync" }];
	const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
	return filtered.length > 0 ? filtered : null;
}

async function handleSync(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const repoRootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 10_000 });
	if (repoRootResult.code !== 0) {
		ctx.ui.notify("Not inside a git repo.", "error");
		return;
	}

	const repoRoot = repoRootResult.stdout.trim();
	if (!repoRoot.endsWith("/pirot")) {
		ctx.ui.notify(`Refusing to sync non-pirot repo: ${repoRoot}`, "warning");
		return;
	}

	ctx.ui.notify(`Syncing ${repoRoot}...`, "info");
	const pullResult = await pi.exec("git", ["pull", "--ff-only"], { cwd: repoRoot, timeout: 120_000 });
	if (pullResult.code !== 0) {
		const message = (pullResult.stderr || pullResult.stdout || "git pull failed").trim();
		ctx.ui.notify(`Sync failed: ${message}`, "error");
		return;
	}

	const { reloadedViaTmux, interactiveCount, skipped } = await reloadOtherActiveSessions(pi, process.pid);
	ctx.ui.notify(`Synced ${repoRoot}; reloading sessions...`, "info");
	if (skipped.length > 0) {
		ctx.ui.notify(`Skipped: ${skipped.slice(0, 4).join(", ")}${skipped.length > 4 ? ", …" : ""}`, "warning");
	}
	if (interactiveCount === 1) {
		ctx.ui.notify("No other active interactive sessions found.", "info");
	} else if (reloadedViaTmux > 0) {
		ctx.ui.notify(`Requested /reload in ${reloadedViaTmux} other tmux-backed session${reloadedViaTmux === 1 ? "" : "s"}.`, "info");
	}
	await ctx.reload();
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
