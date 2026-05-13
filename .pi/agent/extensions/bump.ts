import { access, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { complete, getModel, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

const BUMP_KINDS = ["patch", "minor", "major"] as const;
type BumpKind = (typeof BUMP_KINDS)[number];

type ManifestType = "package-json" | "cargo-toml";
type PackageManager = "bun" | "npm" | "pnpm" | "yarn";
type CargoVersionSource = "package" | "workspace-package";

interface ManifestInfo {
	path: string;
	relativePath: string;
	type: ManifestType;
	name?: string;
	version: string;
	versionPath: string;
	versionRelativePath: string;
	cargoVersionSource?: CargoVersionSource;
	isVirtualCargoWorkspace?: boolean;
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

interface BumpRunOptions {
	skipConfirmations: boolean;
}

interface PreparedBumpRun {
	repoRoot: string;
	parsedArgs: ParsedArgs;
	manifest?: ManifestInfo;
	initialStatus: GitStatusEntry[];
}

interface BumpRunResult {
	repoRoot: string;
	manifest?: ManifestInfo;
	nextVersion?: string;
}

interface ReleaseConfigInfo {
	path: string;
	relativePath: string;
	cwd: string;
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

function parseArgs(args: string, commandName: string = "bump"): ParsedArgs {
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

		if (manifestPath) throw new Error(`Too many arguments. Usage: /${commandName}[!] [patch|minor|major|x.y.z] [path|package-or-crate-name]`);
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

	const relativePath = normalizePath(relative(repoRoot, path));
	return {
		path,
		relativePath,
		type: "package-json",
		name: typeof parsed.name === "string" ? parsed.name : undefined,
		version: parsed.version,
		versionPath: path,
		versionRelativePath: relativePath,
		packageManagerField: typeof parsed.packageManager === "string" ? parsed.packageManager : undefined,
		scripts: parsed.scripts,
	};
}

interface CargoManifestFields {
	hasPackage: boolean;
	name?: string;
	version?: string;
	versionUsesWorkspace: boolean;
	workspaceVersion?: string;
}

function readCargoManifestFields(raw: string): CargoManifestFields {
	const lines = raw.split(/\r?\n/);
	let section = "";
	let hasPackage = false;
	let name: string | undefined;
	let version: string | undefined;
	let versionUsesWorkspace = false;
	let workspaceVersion: string | undefined;

	for (const line of lines) {
		const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
		if (header) {
			section = header[1]?.trim() || "";
			if (section === "package") hasPackage = true;
			continue;
		}

		if (section === "package") {
			if (!name) {
				const nameMatch = line.match(/^\s*name\s*=\s*"([^"]+)"/);
				if (nameMatch) name = nameMatch[1];
			}
			if (!version && !versionUsesWorkspace) {
				const versionMatch = line.match(/^\s*version\s*=\s*"([^"]+)"/);
				if (versionMatch) {
					version = versionMatch[1];
				} else if (/^\s*version\.workspace\s*=\s*true\b/.test(line) || /^\s*version\s*=\s*\{[^}]*\bworkspace\s*=\s*true\b[^}]*\}/.test(line)) {
					versionUsesWorkspace = true;
				}
			}
			continue;
		}

		if (section === "workspace.package" && !workspaceVersion) {
			const versionMatch = line.match(/^\s*version\s*=\s*"([^"]+)"/);
			if (versionMatch) workspaceVersion = versionMatch[1];
		}
	}

	return { hasPackage, name, version, versionUsesWorkspace, workspaceVersion };
}

async function findWorkspacePackageVersion(repoRoot: string, startDir: string): Promise<{ path: string; version: string } | undefined> {
	const normalizedRepoRoot = normalizePath(repoRoot);
	let currentDir = resolve(startDir);

	while (true) {
		const normalizedCurrentDir = normalizePath(currentDir);
		if (normalizedCurrentDir !== normalizedRepoRoot && !normalizedCurrentDir.startsWith(`${normalizedRepoRoot}/`)) return undefined;

		const candidate = join(currentDir, "Cargo.toml");
		if (await pathExists(candidate)) {
			const raw = await readFile(candidate, "utf8");
			const parsed = readCargoManifestFields(raw);
			if (parsed.workspaceVersion) return { path: candidate, version: parsed.workspaceVersion };
		}

		if (normalizedCurrentDir === normalizedRepoRoot) return undefined;
		const parent = dirname(currentDir);
		if (parent === currentDir) return undefined;
		currentDir = parent;
	}
}

async function readCargoManifest(path: string, repoRoot: string): Promise<ManifestInfo> {
	const raw = await readFile(path, "utf8");
	const parsed = readCargoManifestFields(raw);
	const relativePath = normalizePath(relative(repoRoot, path));

	if (!parsed.hasPackage) {
		if (!parsed.workspaceVersion) {
			throw new Error(`${relativePath} does not contain a bumpable package version.`);
		}
		return {
			path,
			relativePath,
			type: "cargo-toml",
			name: "Cargo workspace",
			version: parsed.workspaceVersion,
			versionPath: path,
			versionRelativePath: relativePath,
			cargoVersionSource: "workspace-package",
			isVirtualCargoWorkspace: true,
		};
	}

	if (parsed.version) {
		return {
			path,
			relativePath,
			type: "cargo-toml",
			name: parsed.name,
			version: parsed.version,
			versionPath: path,
			versionRelativePath: relativePath,
			cargoVersionSource: "package",
		};
	}

	if (parsed.versionUsesWorkspace) {
		const workspaceVersion = await findWorkspacePackageVersion(repoRoot, dirname(path));
		if (!workspaceVersion) {
			throw new Error(`${relativePath} uses workspace version but no [workspace.package] version was found.`);
		}
		return {
			path,
			relativePath,
			type: "cargo-toml",
			name: parsed.name,
			version: workspaceVersion.version,
			versionPath: workspaceVersion.path,
			versionRelativePath: normalizePath(relative(repoRoot, workspaceVersion.path)),
			cargoVersionSource: "workspace-package",
		};
	}

	throw new Error(`${relativePath} does not contain package.version in [package].`);
}

async function readManifestInfo(path: string, repoRoot: string): Promise<ManifestInfo> {
	const file = basename(path);
	if (file === "package.json") return readPackageJsonManifest(path, repoRoot);
	if (file === "Cargo.toml") return readCargoManifest(path, repoRoot);
	throw new Error(`Unsupported manifest: ${path}`);
}

function isUnbumpableManifestCandidate(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("does not contain a bumpable package version.") || message.includes("does not contain a string version field.");
}

async function readManifestCandidateInfo(path: string, repoRoot: string): Promise<ManifestInfo | undefined> {
	try {
		return await readManifestInfo(path, repoRoot);
	} catch (error) {
		if (isUnbumpableManifestCandidate(error)) return undefined;
		throw error;
	}
}

async function listManifestInfos(pi: ExtensionAPI, repoRoot: string): Promise<ManifestInfo[]> {
	const candidates = await listManifestCandidates(pi, repoRoot);
	const infos = await Promise.all(candidates.map((candidate) => readManifestCandidateInfo(join(repoRoot, candidate), repoRoot)));
	return infos
		.filter((manifest): manifest is ManifestInfo => manifest !== undefined)
		.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function resolveExistingManifestPath(pathArg: string, repoRoot: string, cwd: string): Promise<string | undefined> {
	const fromCwd = resolve(cwd, pathArg);
	const fromRepoRoot = resolve(repoRoot, pathArg);
	const initialPath = await pathExists(fromCwd) ? fromCwd : fromRepoRoot;
	const repoRootNormalized = normalizePath(repoRoot);
	let targetPath = initialPath;

	if (!(await pathExists(initialPath))) return undefined;

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

function describeManifest(manifest: ManifestInfo): string {
	const label = `${manifest.relativePath} (${manifest.name || manifest.type} ${manifest.version})`;
	if (manifest.versionRelativePath === manifest.relativePath) return label;
	return `${label}, version in ${manifest.versionRelativePath}`;
}

function describeVersionChange(manifest: ManifestInfo, nextVersion: string): string {
	const lines = [manifest.name || manifest.relativePath, "", `${manifest.version} → ${nextVersion}`];
	if (manifest.versionRelativePath !== manifest.relativePath) {
		lines.push("", `Version source: ${manifest.versionRelativePath}`);
	}
	return lines.join("\n");
}

async function resolveManifestTarget(pi: ExtensionAPI, repoRoot: string, cwd: string, target: string): Promise<ManifestInfo> {
	const resolvedPath = await resolveExistingManifestPath(target, repoRoot, cwd);
	if (resolvedPath) return readManifestInfo(resolvedPath, repoRoot);

	const manifestInfos = await listManifestInfos(pi, repoRoot);
	const matches = manifestInfos.filter((manifest) => manifest.name === target);
	if (matches.length === 0) {
		throw new Error(`Could not find a manifest path or package/crate named ${target}.`);
	}
	if (matches.length > 1) {
		throw new Error(`Multiple manifests named ${target}: ${matches.map((manifest) => manifest.relativePath).join(", ")}. Specify a path instead.`);
	}
	return matches[0]!;
}

async function chooseManifest(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repoRoot: string,
	parsedArgs: ParsedArgs,
): Promise<ManifestInfo | undefined> {
	if (parsedArgs.manifestPath) {
		return resolveManifestTarget(pi, repoRoot, ctx.cwd, parsedArgs.manifestPath);
	}

	const manifestInfos = await listManifestInfos(pi, repoRoot);
	if (manifestInfos.length === 0) return undefined;
	if (manifestInfos.length === 1) return manifestInfos[0];

	const rootCandidates = manifestInfos.filter((manifest) => !manifest.relativePath.includes("/") && !manifest.isVirtualCargoWorkspace);
	if (rootCandidates.length === 1) return rootCandidates[0];

	if (!ctx.hasUI) {
		throw new Error(`Multiple manifests found: ${manifestInfos.map((manifest) => manifest.relativePath).join(", ")}. Re-run with an explicit path or package/crate name.`);
	}

	const options = manifestInfos.map((manifest) => ({ label: describeManifest(manifest), manifest }));
	const selection = await ctx.ui.select(
		"Choose a manifest to bump",
		options.map((option) => option.label),
	);
	if (!selection) throw new Error("Bump cancelled.");

	const selected = options.find((option) => option.label === selection)?.manifest;
	if (!selected) throw new Error("Could not resolve the selected manifest.");
	return selected;
}

function toReleaseConfigInfo(path: string, repoRoot: string): ReleaseConfigInfo {
	return {
		path,
		relativePath: normalizePath(relative(repoRoot, path)),
		cwd: dirname(path),
	};
}

async function listReleasorConfigCandidates(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
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
		.filter((path) => basename(path) === "releasor2000.toml")
		.sort((a, b) => a.localeCompare(b));
}

async function findNearestReleasorConfig(repoRoot: string, startDir: string): Promise<string | undefined> {
	const normalizedRepoRoot = normalizePath(repoRoot);
	let currentDir = resolve(startDir);

	while (true) {
		const normalizedCurrentDir = normalizePath(currentDir);
		if (normalizedCurrentDir === normalizedRepoRoot || normalizedCurrentDir.startsWith(`${normalizedRepoRoot}/`)) {
			const candidate = join(currentDir, "releasor2000.toml");
			if (await pathExists(candidate)) return candidate;
		}
		if (normalizedCurrentDir === normalizedRepoRoot) return undefined;

		const parent = dirname(currentDir);
		if (parent === currentDir) return undefined;
		currentDir = parent;
	}
}

async function chooseReleasorConfig(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repoRoot: string,
	preferredStartDir: string,
): Promise<ReleaseConfigInfo> {
	const nearest = await findNearestReleasorConfig(repoRoot, preferredStartDir);
	if (nearest) return toReleaseConfigInfo(nearest, repoRoot);

	const candidates = await listReleasorConfigCandidates(pi, repoRoot);
	if (candidates.length === 0) {
		throw new Error("No releasor2000.toml found in this repository.");
	}
	if (candidates.length === 1) {
		return toReleaseConfigInfo(join(repoRoot, candidates[0]!), repoRoot);
	}

	const rootCandidates = candidates.filter((candidate) => !candidate.includes("/"));
	if (rootCandidates.length === 1) {
		return toReleaseConfigInfo(join(repoRoot, rootCandidates[0]!), repoRoot);
	}

	if (!ctx.hasUI) {
		throw new Error(`Multiple releasor2000.toml files found: ${candidates.join(", ")}. Re-run from the intended directory.`);
	}

	const options = candidates.map((candidate) => toReleaseConfigInfo(join(repoRoot, candidate), repoRoot));
	const selection = await ctx.ui.select(
		"Choose a releasor2000 config",
		options.map((option) => option.relativePath),
	);
	if (!selection) throw new Error("Release cancelled.");

	const selected = options.find((option) => option.relativePath === selection);
	if (!selected) throw new Error("Could not resolve the selected releasor2000 config.");
	return selected;
}

function updatePackageJsonVersion(raw: string, nextVersion: string): string {
	const next = raw.replace(/("version"\s*:\s*")([^"]+)(")/, `$1${nextVersion}$3`);
	if (next === raw) throw new Error("Could not update version in package.json.");
	return next;
}

function updateCargoTomlVersion(raw: string, nextVersion: string, source: CargoVersionSource): string {
	const lines = raw.split(/\r?\n/);
	let inTargetSection = false;
	let updated = false;
	const targetSection = source === "workspace-package" ? "workspace.package" : "package";

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
		if (header) {
			inTargetSection = header[1] === targetSection;
			continue;
		}
		if (!inTargetSection) continue;

		const versionMatch = line.match(/^(\s*version\s*=\s*")([^"]+)(".*)$/);
		if (versionMatch) {
			lines[i] = `${versionMatch[1]}${nextVersion}${versionMatch[3]}`;
			updated = true;
			break;
		}
	}

	if (!updated) throw new Error(`Could not update ${targetSection}.version in Cargo.toml.`);
	return lines.join("\n");
}

async function writeManifestVersion(manifest: ManifestInfo, nextVersion: string): Promise<void> {
	const raw = await readFile(manifest.versionPath, "utf8");
	const updated = manifest.type === "package-json"
		? updatePackageJsonVersion(raw, nextVersion)
		: updateCargoTomlVersion(raw, nextVersion, manifest.cargoVersionSource ?? "package");
	await writeFile(manifest.versionPath, updated, "utf8");
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

function isCancellationMessage(message: string): boolean {
	return message === "Bump cancelled." || message === "Release cancelled." || message === "Commit cancelled.";
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
	diff: string,
	manifest?: ManifestInfo,
	nextVersion?: string,
): Promise<string> {
	const fallback = manifest && nextVersion
		? normalizeCommitMessage(`Update ${manifest.name || manifest.relativePath} and bump to ${nextVersion}`)
		: "Update files";
	const selection = await resolveCommitMessageModel(ctx);
	if (!selection) return fallback;

	const truncated = diff.length > 20_000 ? `${diff.slice(0, 20_000)}\n... (truncated)` : diff;
	const contextLines: string[] = [];
	if (nextVersion) contextLines.push(`Target version: ${nextVersion}`);
	if (manifest) contextLines.push(manifest.name ? `Package name: ${manifest.name}` : `Manifest: ${manifest.relativePath}`);
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
								nextVersion ? "- mention the version bump when relevant" : "",
								"- no markdown, no quotes, no body, just the subject line",
								...contextLines,
								"",
								truncated,
							].filter(Boolean).join("\n"),
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
	options: BumpRunOptions,
	cancelMessage: string,
): Promise<string> {
	const normalizedProposal = normalizeCommitMessage(proposedMessage);
	if (!ctx.hasUI || options.skipConfirmations) return normalizedProposal;

	const preview = changedPaths.slice(0, 8).join(", ");
	const confirmed = await ctx.ui.confirm(
		"Proposed commit message",
		`${normalizedProposal}\n\nFiles: ${preview}${changedPaths.length > 8 ? ", …" : ""}\n\nUse this commit message?`,
	);
	if (confirmed) return normalizedProposal;

	const custom = await ctx.ui.input("Commit message:", normalizedProposal);
	const normalizedCustom = normalizeCommitMessage(custom ?? "");
	if (!normalizedCustom) throw new Error(cancelMessage);
	return normalizedCustom;
}

async function prepareBumpRun(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	commandName: string = "bump",
): Promise<PreparedBumpRun> {
	const parsedArgs = parseArgs(args, commandName);
	const repoRoot = await getRepoRoot(pi, ctx.cwd);
	const initialStatus = await getGitStatus(pi, repoRoot);
	const manifest = await chooseManifest(pi, ctx, repoRoot, parsedArgs);
	return { repoRoot, parsedArgs, manifest, initialStatus };
}

async function executePreparedBump(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	prepared: PreparedBumpRun,
	options: BumpRunOptions,
): Promise<BumpRunResult> {
	const { repoRoot, parsedArgs, manifest, initialStatus } = prepared;
	if (initialStatus.length > 0) {
		const preview = initialStatus.slice(0, 8).map((entry) => entry.path).join(", ");
		ctx.ui.notify(
			`Including existing working tree changes in the bump commit${preview ? ` (${preview}${initialStatus.length > 8 ? ", …" : ""})` : ""}.`,
			"info",
		);
	}

	if (options.skipConfirmations) {
		ctx.ui.notify("Skipping bump confirmations and using the proposed commit message.", "info");
	}

	let nextVersion: string | undefined;
	if (manifest) {
		nextVersion = computeNextVersion(manifest.version, parsedArgs);
		if (nextVersion === manifest.version) {
			throw new Error(`${manifest.relativePath} is already at ${nextVersion}.`);
		}

		if (ctx.hasUI && !options.skipConfirmations) {
			const confirmed = await ctx.ui.confirm(
				"Confirm bump",
				`${describeVersionChange(manifest, nextVersion)}\n\nThis will update the manifest, refresh lockfiles/checks, propose a commit message, commit, and push.`,
			);
			if (!confirmed) {
				throw new Error("Bump cancelled.");
			}
		}

		await writeManifestVersion(manifest, nextVersion);
		ctx.ui.notify(`Updated ${manifest.versionRelativePath}: ${manifest.version} → ${nextVersion}`, "info");
		await runManifestSync(pi, manifest, repoRoot, ctx);
	} else {
		ctx.ui.notify("No manifest found, committing and pushing changes as-is.", "info");
	}

	const staged = await stageAllChanges(pi, repoRoot);
	const stagedDiff = await getStagedDiff(pi, repoRoot);
	const proposedMessage = await proposeCommitMessage(ctx, stagedDiff, manifest, nextVersion);
	const commitMessage = await chooseCommitMessage(ctx, proposedMessage, staged, options, "Bump cancelled.");
	await commitAndPush(pi, ctx, repoRoot, commitMessage);
	ctx.ui.notify(`Committed and pushed ${staged.length} file${staged.length === 1 ? "" : "s"}.`, "info");
	return { repoRoot, manifest, nextVersion };
}

async function runBump(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
	options: BumpRunOptions,
): Promise<BumpRunResult | undefined> {
	try {
		const prepared = await prepareBumpRun(pi, ctx, args, "bump");
		return await executePreparedBump(pi, ctx, prepared, options);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isCancellationMessage(message)) {
			ctx.ui.notify(message, "info");
			return undefined;
		}
		ctx.ui.notify(`bump failed: ${message}`, "error");
		return undefined;
	}
}

async function runReleasor2000Release(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: ReleaseConfigInfo,
): Promise<void> {
	ctx.ui.notify(`Running releasor2000 release from ${config.relativePath}...`, "info");
	const result = await pi.exec("releasor2000", ["release"], {
		cwd: config.cwd,
		timeout: 600_000,
	});
	if (result.code !== 0) {
		throw new Error((result.stderr || result.stdout || "releasor2000 release failed").trim());
	}
	ctx.ui.notify("Release completed.", "info");
}

async function runRelease(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
	options: BumpRunOptions,
): Promise<void> {
	try {
		const prepared = await prepareBumpRun(pi, ctx, args, "release");
		const preferredStartDir = prepared.manifest ? dirname(prepared.manifest.path) : ctx.cwd;
		const config = await chooseReleasorConfig(pi, ctx, prepared.repoRoot, preferredStartDir);

		if (ctx.hasUI && !options.skipConfirmations) {
			const releaseSummary = prepared.manifest
				? describeVersionChange(prepared.manifest, computeNextVersion(prepared.manifest.version, prepared.parsedArgs))
				: "No manifest found; the bump step will commit and push existing changes as-is.";
			const confirmed = await ctx.ui.confirm(
				"Confirm release",
				`${releaseSummary}\n\nConfig: ${config.relativePath}\n\nThis will run the bump workflow, then releasor2000 release.`,
			);
			if (!confirmed) {
				ctx.ui.notify("Release cancelled.", "info");
				return;
			}
		}

		const bumpResult = await executePreparedBump(pi, ctx, prepared, options);
		await runReleasor2000Release(pi, ctx, config);
		if (bumpResult.nextVersion && bumpResult.manifest) {
			ctx.ui.notify(
				`Released ${bumpResult.manifest.name || bumpResult.manifest.relativePath} at ${bumpResult.nextVersion}.`,
				"info",
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isCancellationMessage(message)) {
			ctx.ui.notify(message, "info");
			return;
		}
		ctx.ui.notify(`release failed: ${message}`, "error");
	}
}

async function commitOnly(
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
}

async function runCommit(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
	options: BumpRunOptions,
): Promise<void> {
	try {
		if (args.trim()) {
			throw new Error("Usage: /commit[!]");
		}

		const repoRoot = await getRepoRoot(pi, ctx.cwd);
		const initialStatus = await getGitStatus(pi, repoRoot);
		if (initialStatus.length === 0) {
			throw new Error("No changes to commit.");
		}

		const preview = initialStatus.slice(0, 8).map((entry) => entry.path).join(", ");
		ctx.ui.notify(
			`Including existing working tree changes in the commit${preview ? ` (${preview}${initialStatus.length > 8 ? ", …" : ""})` : ""}.`,
			"info",
		);

		if (options.skipConfirmations) {
			ctx.ui.notify("Skipping commit confirmation and using the proposed commit message.", "info");
		}

		const staged = await stageAllChanges(pi, repoRoot);
		const stagedDiff = await getStagedDiff(pi, repoRoot);
		const proposedMessage = await proposeCommitMessage(ctx, stagedDiff);
		const commitMessage = await chooseCommitMessage(ctx, proposedMessage, staged, options, "Commit cancelled.");
		await commitOnly(pi, ctx, repoRoot, commitMessage);
		ctx.ui.notify(`Committed ${staged.length} file${staged.length === 1 ? "" : "s"}.`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isCancellationMessage(message)) {
			ctx.ui.notify(message, "info");
			return;
		}
		ctx.ui.notify(`commit failed: ${message}`, "error");
	}
}

async function commitAndPush(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repoRoot: string,
	commitMessage: string,
): Promise<void> {
	await commitOnly(pi, ctx, repoRoot, commitMessage);

	ctx.ui.notify("Pushing...", "info");
	const pushResult = await pi.exec("git", ["push"], { cwd: repoRoot, timeout: 180_000 });
	if (pushResult.code !== 0) {
		throw new Error((pushResult.stderr || pushResult.stdout || "git push failed").trim());
	}
}

export default function bumpExtension(pi: ExtensionAPI) {
	pi.registerCommand("bump", {
		description: "Bump a package.json or Cargo.toml version by path or package/crate name, refresh lockfiles, commit, and push",
		getArgumentCompletions: commandCompletions,
		handler: async (args, ctx) => {
			await runBump(pi, args, ctx, { skipConfirmations: false });
		},
	});

	pi.registerCommand("bump!", {
		description: "Same as /bump, but skips confirmation prompts and commits immediately",
		getArgumentCompletions: commandCompletions,
		handler: async (args, ctx) => {
			await runBump(pi, args, ctx, { skipConfirmations: true });
		},
	});

	pi.registerCommand("commit", {
		description: "Stage all changes, generate a commit message, and commit locally",
		handler: async (args, ctx) => runCommit(pi, args, ctx, { skipConfirmations: false }),
	});

	pi.registerCommand("commit!", {
		description: "Same as /commit, but skips confirmation prompts and commits immediately",
		handler: async (args, ctx) => runCommit(pi, args, ctx, { skipConfirmations: true }),
	});

	pi.registerCommand("release", {
		description: "Run /bump by path or package/crate name, then releasor2000 release when a releasor2000.toml exists",
		getArgumentCompletions: commandCompletions,
		handler: async (args, ctx) => runRelease(pi, args, ctx, { skipConfirmations: false }),
	});

	pi.registerCommand("release!", {
		description: "Same as /release, but skips confirmation prompts and runs immediately",
		getArgumentCompletions: commandCompletions,
		handler: async (args, ctx) => runRelease(pi, args, ctx, { skipConfirmations: true }),
	});
}
