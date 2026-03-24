import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

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
}

const REGISTRY_DIR = join(getAgentDir(), "runtime", "instances");
const HEARTBEAT_MS = 15_000;
const STALE_GRACE_MS = 5 * 60_000;

function detectMode(argv: string[]): ActiveSessionRecord["mode"] {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-p" || arg === "--print") return "print";
		if (arg === "--mode") {
			const next = argv[i + 1];
			if (next === "rpc" || next === "json") return next;
		}
		if (arg === "--mode=rpc") return "rpc";
		if (arg === "--mode=json") return "json";
	}

	return process.stdout.isTTY ? "interactive" : "unknown";
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function ensureRegistryDir(): Promise<void> {
	await mkdir(REGISTRY_DIR, { recursive: true });
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const tempPath = `${path}.${process.pid}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tempPath, path);
}

export default function activeSessionRegistryExtension(pi: ExtensionAPI) {
	const pid = process.pid;
	const startedAt = new Date().toISOString();
	const mode = detectMode(process.argv);
	const instanceFile = join(REGISTRY_DIR, `${pid}.json`);
	let heartbeat: NodeJS.Timeout | undefined;
	let latestContext: ExtensionContext | undefined;
	let lastKnownModel: ActiveSessionRecord["model"];

	function buildRecord(ctx: ExtensionContext): ActiveSessionRecord {
		return {
			pid,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionName: pi.getSessionName() ?? undefined,
			model: ctx.model
				? {
					provider: ctx.model.provider,
					id: ctx.model.id,
				}
				: lastKnownModel,
			startedAt,
			lastSeenAt: new Date().toISOString(),
			mode,
		};
	}

	async function publish(ctx: ExtensionContext): Promise<void> {
		await ensureRegistryDir();
		await writeJsonAtomic(instanceFile, buildRecord(ctx));
	}

	async function cleanupStaleEntries(): Promise<void> {
		await ensureRegistryDir();
		const files = await readdir(REGISTRY_DIR).catch(() => [] as string[]);
		const now = Date.now();

		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const fullPath = join(REGISTRY_DIR, file);
			const pidPart = file.slice(0, -5);
			const otherPid = Number.parseInt(pidPart, 10);
			if (!Number.isFinite(otherPid) || otherPid === pid) continue;

			if (isProcessAlive(otherPid)) continue;

			try {
				const info = await stat(fullPath);
				if (now - info.mtimeMs < STALE_GRACE_MS) continue;
				await rm(fullPath, { force: true });
			} catch {
				// Ignore races or permission issues.
			}
		}
	}

	async function removeInstanceFile(): Promise<void> {
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = undefined;
		}
		await rm(instanceFile, { force: true }).catch(() => undefined);
	}

	function startHeartbeat(ctx: ExtensionContext): void {
		latestContext = ctx;
		if (heartbeat) return;
		heartbeat = setInterval(() => {
			if (latestContext) {
				void publish(latestContext);
			}
		}, HEARTBEAT_MS);
	}

	pi.registerCommand("active-sessions-path", {
		description: "Show the directory where the active pi session registry is written",
		handler: async (_args, ctx) => {
			await ensureRegistryDir();
			ctx.ui.notify(`Active pi session registry: ${REGISTRY_DIR}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestContext = ctx;
		lastKnownModel = ctx.model
			? {
				provider: ctx.model.provider,
				id: ctx.model.id,
			}
			: undefined;
		await cleanupStaleEntries();
		await publish(ctx);
		startHeartbeat(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		latestContext = ctx;
		await publish(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		latestContext = ctx;
		await publish(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		latestContext = ctx;
		lastKnownModel = {
			provider: event.model.provider,
			id: event.model.id,
		};
		await publish(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		latestContext = ctx;
		await publish(ctx);
	});

	pi.on("session_shutdown", async () => {
		await removeInstanceFile();
	});
}
