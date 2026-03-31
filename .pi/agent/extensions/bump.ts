import { access, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { complete, getModel, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

const BUMP_KINDS = ["patch", "minor", "major"] as const;
type BumpKind = (typeof BUMP_KINDS)[number];

type ManifestType = "package-json" | "cargo-toml";
type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

interface ManifestInfo {
	path: string;
	relativePath: string;
	type: ManifestType;
	name?: string;
	version: string;
	packageManagerField?: string;
	scripts?: Record<string, string>;
}

interface ParsedArgs {
	kind: BumpKind;
	explicitVersion?: string;
	manifestPath?: string;
}

interface GitStatusEntry {
	xy: string;
	path: string;
	untracked: boolean;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const EXPLICIT_VERSION_RE = VERSION_RE;

function commandCompletions(prefix: string): AutocompleteItem[] | null {
	const trimmed = prefix.trim();
	if (trimmed.includes(" ")) return null;

	const items = BUMP_KINDS.map((kind) => ({ value: kind, label: kind }));
	const filtered = items.filter((item) => item.value.startsWith(trimmed));
	return filtered.length > 0 ? filtered : null;
}

function isBumpKind(value: string): value is BumpKind {
	return (BUMP_KINDS as readonly string[]).includes(value);
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function parseArgs(args: string): ParsedArgs {
	const tokens = args
		.trim()
		.split(/\s+/)
		.filter(Boolean);

	let kind: BumpKind = "patch";
	let explicitVersion: string | undefined;
	let manifestPath: string | undefined;
	let kindSet = false;

	for (const token of tokens) {
		if (isBumpKind(token)) {
			if (kindSet || explicitVersion) throw new Error("Specify either a bump kind or an explicit version, not both.");
			kind = token;
			kindSet = true;
			continue;
		}

		if (EXPLICIT_VERSION_RE.test(token)) {
			if (explicitVersion || kindSet) throw new Error("Specify either a bump kind or an explicit version, not both.");
			explicitVersion = token;
			continue;
		}

		if (manifestPath) throw new Error("Too many arguments. Usage: /bump [patch|minor|major|x.y.z] [path]");
		manifestPath = token;
	}

	return { kind, explicitVersion, manifestPath };
}

function bumpVersion(currentVersion: string, kind: BumpKind): string {
	const match = currentVersion.match(VERSION_RE);
	if (!match) {
		throw new Error(`Unsupported version format: ${currentVersion}. Expected semver like 1.2.3.`);
	}

	let major = Number(match[1]);
	let minor = Number(match[2]);
	let patch = Number(match[3]);

	if (kind === "major") {
		major += 1;
		minor = 0;
		patch = 0;
	} else if (kind === "minor") {
		minor += 1;
		patch = 0;
	} else {
		patch += 1;
	}

	return `${major}.${minor}.${patch}`;
}

function computeNextVersion(currentVersion: string, parsedArgs: ParsedArgs): string {
	if (parsedArgs.explicitVersion) return parsedArgs.explicitVersion;
	return bumpVersion(currentVersion, parsedArgs.kind);
}

async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000 });
	if (result.code !== 0) {
		throw new Error((result.stderr || result.stdout || "Not inside a git repository.").trim());
	}
	return result.stdout.trim();
}

function parseGitStatus(output: string): GitStatusEntry[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.map((line) => {
			const xy = line.slice(0, 2);
			const rawPath = line.slice(3);
			const path = normalizePath(rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() || rawPath : rawPath);
			return {
				xy,
				path,
				untracked: xy === "??",
			};
		});
}

async function getGitStatus(pi: ExtensionAPI, repoRoot: string): Promise<GitStatusEntry[]> {
	const result = await pi.exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot, timeout: 10_000 });
	if (result.code !== 0) {
		throw new Error((result.stderr || result.stdout || "git status failed").trim());
	}
	return parseGitStatus(result.stdout || "");
}

async function listManifestCandidates(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
	const result = await pi.exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
		cwd: repoRoot,
		timeout: 15_000,
	});
	if (result.code !== 0) {
		throw new Error((result.stderr || result.stdout || "git ls-files failed").trim());
	}

	return (result.stdout || "")
		.split(/\r?\n/)
		.map((line) => normalizePath(line.trim()))
		.filter(Boolean)
		.filter((path) => basename(path) === "package.json" || basename(path) === "Cargo.toml")
		.sort((a, b) => a.localeCompare(b));
}

async function readPackageJsonManifest(path: string, repoRoot: string): Promise<ManifestInfo> {
	const raw = await readFile(path, "utf8");
	const parsed = JSON.parse(raw) as {
		name?: string;
		version?: string;
		packageManager?: string;
		scripts?: Record<string, string>;
	};
	if (typeof parsed.version !== "string" || !parsed.version.trim()) {
		throw new Error(`${normalizePath(relative(repoRoot, path))} does not contain a string version field.`);
	}

	return {
		path,
		relativePath: normalizePath(relative(repoRoot, path)),
		type: "package-json",
		name: typeof parsed.name === "string" ? parsed.name : undefined,
		version: parsed.version,
		packageManagerField: typeof parsed.packageManager === "string" ? parsed.packageManager : undefined,
		scripts: parsed.scripts,
	};
}

function readCargoPackageFields(raw: string): { name?: string; version?: string } {
	const lines = raw.split(/\r?\n/);
	let inPackage = false;
	let name: string | undefined;
	let version: string | undefined;

	for (const line of lines) {
		const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
		if (header) {
			inPackage = header[1] === "package";
			continue;
		}
		if (!inPackage) continue;

		if (!name) {
			const nameMatch = line.match(/^\s*name\s*=\s*"([^"]+)"/);
			if (nameMatch) name = nameMatch[1];
		}
		if (!version) {
			const versionMatch = line.match(/^\s*version\s*=\s*"([^"]+)"/);
			if (versionMatch) version = versionMatch[1];
		}
		if (name && version) break;
	}

	return { name, version };
}

async function readCargoManifest(path: string, repoRoot: string): Promise<ManifestInfo> {
	const raw = await readFile(path, "utf8");
	const parsed = readCargoPackageFields(raw);
	if (!parsed.version) {
		throw new Error(`${normalizePath(relative(repoRoot, path))} does not contain package.version in [package].`);
	}

	return {
		path,
		relativePath: normalizePath(relative(repoRoot, path)),
		type: "cargo-toml",
		name: parsed.name,
		version: parsed.version,
	};
}

async function readManifestInfo(path: string, repoRoot: string): Promise<ManifestInfo> {
	const file = basename(path);
	if (file === "package.json") return readPackageJsonManifest(path, repoRoot);
	if (file === "Cargo.toml") return readCargoManifest(path, repoRoot);
	throw new Error(`Unsupported manifest: ${path}`);
}

async function resolveManifestPath(pathArg: string, repoRoot: string, cwd: string): Promise<string> {
	const fromCwd = resolve(cwd, pathArg);
	const fromRepoRoot = resolve(repoRoot, pathArg);
	const initialPath = await pathExists(fromCwd) ? fromCwd : fromRepoRoot;
	const repoRootNormalized = normalizePath(repoRoot);
	let targetPath = initialPath;

	if (!(await pathExists(initialPath))) {
		throw new Error(`Could not find ${pathArg}`);
	}

	const stats = await stat(initialPath);
	if (stats.isDirectory()) {
		const packageJson = join(initialPath, "package.json");
		const cargoToml = join(initialPath, "Cargo.toml");
		const existing: string[] = [];
		for (const option of [packageJson, cargoToml]) {
			if (await pathExists(option)) existing.push(option);
		}
		if (existing.length === 0) throw new Error(`No package.json or Cargo.toml found in ${pathArg}`);
		if (existing.length > 1) throw new Error(`Both package.json and Cargo.toml exist in ${pathArg}; specify one explicitly.`);
		targetPath = existing[0]!;
	}

	const normalizedTarget = normalizePath(targetPath);
	const repoPrefix = repoRootNormalized.endsWith("/") ? repoRootNormalized : `${repoRootNormalized}/`;
	if (!normalizedTarget.startsWith(repoPrefix) && normalizedTarget !== repoRootNormalized) {
		throw new Error(`Manifest path must stay inside the repository: ${pathArg}`);
	}
	return targetPath;
}

async function chooseManifest(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repoRoot: string,
	parsedArgs: ParsedArgs,
): Promise<ManifestInfo> {
	if (parsedArgs.manifestPath) {
		const resolved = await resolveManifestPath(parsedArgs.manifestPath, repoRoot, ctx.cwd);
		return readManifestInfo(resolved, repoRoot);
	}

	const candidates = await listManifestCandidates(pi, repoRoot);
	if (candidates.length === 0) throw new Error("No package.json or Cargo.toml found in the repository.");
	if (candidates.length === 1) return readManifestInfo(join(repoRoot, candidates[0]!), repoRoot);

	const rootCandidates = candidates.filter((candidate) => !candidate.includes("/"));
	if (rootCandidates.length === 1) return readManifestInfo(join(repoRoot, rootCandidates[0]!), repoRoot);

	if (!ctx.hasUI) {
		throw new Error(`Multiple manifests found: ${candidates.join(", ")}. Re-run with an explicit path.`);
	}

	const manifestInfos = await Promise.all(candidates.map((candidate) => readManifestInfo(join(repoRoot, candidate), repoRoot)));
	const options = manifestInfos.map((manifest) => {
		const label = `${manifest.relativePath} (${manifest.name || manifest.type} ${manifest.version})`;
		return { label, manifest };
	});
	const selection = await ctx.ui.select(
		"Choose a manifest to bump",
		options.map((option) => option.label),
	);
	if (!selection) throw new Error("Bump cancelled.");

	const selected = options.find((option) => option.label === selection)?.manifest;
	if (!selected) throw new Error("Could not resolve the selected manifest.");
	return selected;
}

function updatePackageJsonVersion(raw: string, nextVersion: string): string {
	const next = raw.replace(/("version"\s*:\s*")([^"]+)(")/, `$1${nextVersion}$3`);
	if (next === raw) throw new Error("Could not update version in package.json.");
	return next;
}

function updateCargoTomlVersion(raw: string, nextVersion: string): string {
	const lines = raw.split(/\r?\n/);
	let inPackage = false;
	let updated = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
		if (header) {
			inPackage = header[1] === "package";
			continue;
		}
		if (!inPackage) continue;

		const versionMatch = line.match(/^(\s*version\s*=\s*")([^"]+)(".*)$/);
		if (versionMatch) {
			lines[i] = `${versionMatch[1]}${nextVersion}${versionMatch[3]}`;
			updated = true;
			break;
		}
	}

	if (!updated) throw new Error("Could not update package.version in Cargo.toml.");
	return lines.join("\n");
}

async function writeManifestVersion(manifest: ManifestInfo, nextVersion: string): Promise<void> {
	const raw = await readFile(manifest.path, "utf8");
	const updated = manifest.type === "package-json" ? updatePackageJsonVersion(raw, nextVersion) : updateCargoTomlVersion(raw, nextVersion);
	await writeFile(manifest.path, updated, "utf8");
}

async function detectPackageManager(manifest: ManifestInfo, repoRoot: string): Promise<PackageManager> {
	if (manifest.packageManagerField) {
		const explicit = manifest.packageManagerField.split("@")[0]?.trim();
		if (explicit === "bun" || explicit === "npm" || explicit === "pnpm" || explicit === "yarn") return explicit;
	}

	const manifestDir = dirname(manifest.path);
	const lockfileChecks: Array<{ manager: PackageManager; files: string[] }> = [
		{ manager: "bun", files: [join(manifestDir, "bun.lock"), join(manifestDir, "bun.lockb"), join(repoRoot, "bun.lock"), join(repoRoot, "bun.lockb")] },
		{ manager: "pnpm", files: [join(manifestDir, "pnpm-lock.yaml"), join(repoRoot, "pnpm-lock.yaml")] },
		{ manager: "npm", files: [join(manifestDir, "package-lock.json"), join(repoRoot, "package-lock.json")] },
		{ manager: "yarn", files: [join(manifestDir, "yarn.lock"), join(repoRoot, "yarn.lock")] },
	];
	for (const check of lockfileChecks) {
		for (const file of check.files) {
			if (await pathExists(file)) return check.manager;
		}
	}

	if (await pathExists(join(manifestDir, "bunfig.toml")) || await pathExists(join(repoRoot, "bunfig.toml"))) return "bun";
	if (Object.values(manifest.scripts ?? {}).some((script) => /\bbun\b/.test(script))) return "bun";
	return "npm";
}

async function runManifestSync(pi: ExtensionAPI, manifest: ManifestInfo, repoRoot: string, ctx: ExtensionCommandContext): Promise<void> {
	if (manifest.type === "cargo-toml") {
		ctx.ui.notify(`Running cargo check for ${manifest.relativePath}...`, "info");
		const result = await pi.exec("cargo", ["check", "--manifest-path", manifest.path], {
			cwd: repoRoot,
			timeout: 300_000,
		});
		if (result.code !== 0) {
			throw new Error((result.stderr || result.stdout || "cargo check failed").trim());
		}
		return;
	}

	const manager = await detectPackageManager(manifest, repoRoot);
	const manifestDir = dirname(manifest.path);
	const runFromRepoRoot = manager === "bun"
		? (await pathExists(join(repoRoot, "bun.lock"))) || (await pathExists(join(repoRoot, "bun.lockb")))
		: manager === "pnpm"
			? await pathExists(join(repoRoot, "pnpm-lock.yaml"))
			: manager === "npm"
				? await pathExists(join(repoRoot, "package-lock.json"))
				: await pathExists(join(repoRoot, "yarn.lock"));
	const cwd = runFromRepoRoot ? repoRoot : manifestDir;

	let args: string[];
	if (manager === "bun") args = ["install"];
	else if (manager === "pnpm") args = ["install", "--lockfile-only"];
	else if (manager === "yarn") args = ["install"];
	else args = ["install", "--package-lock-only"];

	ctx.ui.notify(`Running ${manager} ${args.join(" ")}...`, "info");
	const result = await pi.exec(manager, args, { cwd, timeout: 300_000 });
	if (result.code !== 0) {
		throw new Error((result.stderr || result.stdout || `${manager} install failed`).trim());
	}
}

function normalizeCommitMessage(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

async function stageAllChanges(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
	const addResult = await pi.exec("git", ["add", "-A"], { cwd: repoRoot, timeout: 30_000 });
	if (addResult.code !== 0) {
		throw new Error((addResult.stderr || addResult.stdout || "git add failed").trim());
	}

	const status = await getGitStatus(pi, repoRoot);
	const changedPaths = [...new Set(status.map((entry) => entry.path))].sort((a, b) => a.localeCompare(b));
	if (changedPaths.length === 0) {
		throw new Error("No changes to commit.");
	}
	return changedPaths;
}

async function getStagedDiff(pi: ExtensionAPI, repoRoot: string): Promise<string> {
	const [statResult, diffResult] = await Promise.all([
		pi.exec("git", ["diff", "--cached", "--stat"], { cwd: repoRoot, timeout: 20_000 }),
		pi.exec("git", ["diff", "--cached"], { cwd: repoRoot, timeout: 20_000 }),
	]);
	if (statResult.code !== 0) {
		throw new Error((statResult.stderr || statResult.stdout || "git diff --cached --stat failed").trim());
	}
	if (diffResult.code !== 0) {
		throw new Error((diffResult.stderr || diffResult.stdout || "git diff --cached failed").trim());
	}
	return `Staged file summary:\n${statResult.stdout.trim()}\n\nStaged diff:\n${diffResult.stdout.trim()}`.trim();
}

interface CommitMessageModelSelection {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	source: string;
}

function scoreCommitMessageModel(model: Model<any>): number {
	const providerScore = model.provider === "anthropic"
		? 1000
		: model.provider === "openai"
			? 800
			: model.provider === "google"
				? 600
				: 400;
	const id = model.id.toLowerCase();
	const sizeScore = id.includes("haiku")
		? 120
		: id.includes("sonnet")
			? 100
			: id.includes("mini") || id.includes("flash")
				? 90
				: id.includes("opus") || id.includes("pro")
					? 70
					: 50;
	return providerScore + sizeScore;
}

async function tryCommitMessageModel(
	ctx: ExtensionCommandContext,
	model: Model<any> | undefined,
	source: string,
): Promise<CommitMessageModelSelection | undefined> {
	if (!model) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return undefined;
	return {
		model,
		apiKey: auth.apiKey,
		headers: auth.headers,
		source,
	};
}

async function resolveCommitMessageModel(ctx: ExtensionCommandContext): Promise<CommitMessageModelSelection | undefined> {
	const preferredAnthropic = await tryCommitMessageModel(
		ctx,
		getModel("anthropic", "claude-haiku-4-5"),
		"preferred anthropic model",
	);
	if (preferredAnthropic) return preferredAnthropic;

	let availableModels: Model<any>[] = [];
	try {
		availableModels = await ctx.modelRegistry.getAvailable();
	} catch {
		availableModels = [];
	}

	const uniqueAvailableModels = [...new Map(availableModels.map((model) => [`${model.provider}/${model.id}`, model] as const)).values()];
	const sortedAvailableModels = uniqueAvailableModels.sort((a, b) => {
		const scoreDelta = scoreCommitMessageModel(b) - scoreCommitMessageModel(a);
		if (scoreDelta !== 0) return scoreDelta;
		return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
	});

	for (const model of sortedAvailableModels) {
		const candidate = await tryCommitMessageModel(
			ctx,
			model,
			model.provider === "anthropic" ? "available anthropic model" : "available model",
		);
		if (candidate) return candidate;
	}

	return tryCommitMessageModel(ctx, ctx.model, "current session model");
}

async function proposeCommitMessage(
	ctx: ExtensionCommandContext,
	manifest: ManifestInfo,
	nextVersion: string,
	diff: string,
): Promise<string> {
	const fallback = normalizeCommitMessage(`Update ${manifest.name || manifest.relativePath} and bump to ${nextVersion}`);
	const selection = await resolveCommitMessageModel(ctx);
	if (!selection) return fallback;

	const truncated = diff.length > 20_000 ? `${diff.slice(0, 20_000)}\n... (truncated)` : diff;
	try {
		ctx.ui.notify(
			`Drafting commit message with ${selection.model.provider}/${selection.model.id} (${selection.source})...`,
			"info",
		);
		const response = await complete(
			selection.model,
			{
				messages: [
					{
						role: "user",
						content: [{
							type: "text",
							text: [
								"Propose a concise git commit subject line for these staged changes.",
								"Requirements:",
								"- imperative mood",
								"- max 72 characters if possible",
								"- mention the version bump when relevant",
								"- no markdown, no quotes, no body, just the subject line",
								`Target version: ${nextVersion}`,
								manifest.name ? `Package name: ${manifest.name}` : `Manifest: ${manifest.relativePath}`,
								"",
								truncated,
							].join("\n"),
						}],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: selection.apiKey, headers: selection.headers },
		);
		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join(" ");
		const normalized = normalizeCommitMessage(text);
		return normalized || fallback;
	} catch {
		return fallback;
	}
}

async function chooseCommitMessage(
	ctx: ExtensionCommandContext,
	proposedMessage: string,
	changedPaths: string[],
): Promise<string> {
	const normalizedProposal = normalizeCommitMessage(proposedMessage);
	if (!ctx.hasUI) return normalizedProposal;

	const preview = changedPaths.slice(0, 8).join(", ");
	const confirmed = await ctx.ui.confirm(
		"Proposed commit message",
		`${normalizedProposal}\n\nFiles: ${preview}${changedPaths.length > 8 ? ", …" : ""}\n\nUse this commit message?`,
	);
	if (confirmed) return normalizedProposal;

	const custom = await ctx.ui.input("Commit message:", normalizedProposal);
	const normalizedCustom = normalizeCommitMessage(custom ?? "");
	if (!normalizedCustom) throw new Error("Bump cancelled.");
	return normalizedCustom;
}

async function commitAndPush(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repoRoot: string,
	commitMessage: string,
): Promise<void> {
	ctx.ui.notify(`Committing: ${commitMessage}`, "info");
	const commitResult = await pi.exec("git", ["commit", "-m", commitMessage], { cwd: repoRoot, timeout: 60_000 });
	if (commitResult.code !== 0) {
		throw new Error((commitResult.stderr || commitResult.stdout || "git commit failed").trim());
	}

	ctx.ui.notify("Pushing...", "info");
	const pushResult = await pi.exec("git", ["push"], { cwd: repoRoot, timeout: 180_000 });
	if (pushResult.code !== 0) {
		throw new Error((pushResult.stderr || pushResult.stdout || "git push failed").trim());
	}
}

export default function bumpExtension(pi: ExtensionAPI) {
	pi.registerCommand("bump", {
		description: "Bump a package.json or Cargo.toml version, refresh lockfiles, commit, and push",
		getArgumentCompletions: commandCompletions,
		handler: async (args, ctx) => {
			try {
				const parsedArgs = parseArgs(args);
				const repoRoot = await getRepoRoot(pi, ctx.cwd);
				const initialStatus = await getGitStatus(pi, repoRoot);
				if (initialStatus.length > 0) {
					const preview = initialStatus.slice(0, 8).map((entry) => entry.path).join(", ");
					ctx.ui.notify(
						`Including existing working tree changes in the bump commit${preview ? ` (${preview}${initialStatus.length > 8 ? ", …" : ""})` : ""}.`,
						"info",
					);
				}

				const manifest = await chooseManifest(pi, ctx, repoRoot, parsedArgs);
				const nextVersion = computeNextVersion(manifest.version, parsedArgs);
				if (nextVersion === manifest.version) {
					throw new Error(`${manifest.relativePath} is already at ${nextVersion}.`);
				}

				if (ctx.hasUI) {
					const confirmed = await ctx.ui.confirm(
						"Confirm bump",
						`${manifest.name || manifest.relativePath}\n\n${manifest.version} → ${nextVersion}\n\nThis will update the manifest, refresh lockfiles/checks, propose a commit message, commit, and push.`,
					);
					if (!confirmed) {
						ctx.ui.notify("Bump cancelled.", "info");
						return;
					}
				}

				await writeManifestVersion(manifest, nextVersion);
				ctx.ui.notify(`Updated ${manifest.relativePath}: ${manifest.version} → ${nextVersion}`, "info");
				await runManifestSync(pi, manifest, repoRoot, ctx);
				const staged = await stageAllChanges(pi, repoRoot);
				const stagedDiff = await getStagedDiff(pi, repoRoot);
				const proposedMessage = await proposeCommitMessage(ctx, manifest, nextVersion, stagedDiff);
				const commitMessage = await chooseCommitMessage(ctx, proposedMessage, staged);
				await commitAndPush(pi, ctx, repoRoot, commitMessage);
				ctx.ui.notify(`Committed and pushed ${staged.length} file${staged.length === 1 ? "" : "s"}.`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`bump failed: ${message}`, "error");
			}
		},
	});
}
