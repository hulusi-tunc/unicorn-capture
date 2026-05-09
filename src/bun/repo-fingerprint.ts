/**
 * Pure detection module: takes a repo path, returns everything Capture
 * needs to know about it before touching any files. No edits, no spawns.
 *
 * Result drives the wizard's Phase 1 (Detect) UI and Phase 3 (Install)
 * step planning. Doctor mode (future) re-runs this on existing projects
 * to surface drift.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { findRnAppDir, findRootLayoutPath, findWorkspaceRoot } from "./init";
import { getSnapBridgeVersion } from "./snap-bridge-version";

// ── Public types ──────────────────────────────────────────────────────────

export type RnLayout =
	| "expo-router"
	| "rn-cli"
	| "expo-classic"
	| "unknown";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface RnCandidate {
	rnAppDir: string;
	relativeFromRepo: string;
	hasAppFolder: boolean;
	packageJsonName: string | null;
}

export type SnapBridgeState =
	| { state: "missing" }
	| { state: "floating"; current: string }
	| { state: "pinned"; current: string; matchesSuggested: boolean };

export type LayoutWiringState = "absent" | "wired" | "ast-unsupported";

export type ComponentShape =
	| "function-decl"
	| "memo-arrow"
	| "forwardRef"
	| "default-export-only"
	| "unknown";

export interface RepoFingerprint {
	repoPath: string;
	workspaceRoot: string;
	isMonorepo: boolean;
	packageManager: PackageManager;
	candidates: RnCandidate[];
	picked: RnCandidate | null;
	pickedNotFoundReason?: string;
	rnLayout: RnLayout;
	snapBridge: SnapBridgeState & { suggested: string };
	viewShot: { installed: boolean; podsInstalled: boolean };
	layoutFile: {
		path: string | null;
		wiringState: LayoutWiringState;
		componentShape: ComponentShape;
	};
	flowsFile: { path: string | null; lastModified: string | null };
	hookFile: { path: string | null };
	iosWorkspace: { exists: boolean; podfileLockExists: boolean };
}

// ── Top-level entrypoint ─────────────────────────────────────────────────

export function fingerprintRepo(repoPath: string): RepoFingerprint {
	if (!existsSync(repoPath)) {
		throw new Error(`Repo path does not exist: ${repoPath}`);
	}

	const workspaceRoot = findWorkspaceRoot(repoPath);
	const rootPkg = readPkgJson(join(workspaceRoot, "package.json"));
	const isMonorepo = Boolean(rootPkg?.workspaces);
	const packageManager = detectPackageManager(workspaceRoot, rootPkg);

	const candidates = rankRnCandidates(workspaceRoot);
	const picked = candidates[0] ?? null;

	const rnAppDir = picked?.rnAppDir ?? null;
	const rnLayout = rnAppDir ? detectRnLayout(rnAppDir) : "unknown";
	const snapBridge = detectSnapBridge(workspaceRoot, rnAppDir);
	const viewShot = rnAppDir
		? detectViewShot(rnAppDir, workspaceRoot)
		: { installed: false, podsInstalled: false };
	const layoutFile = rnAppDir
		? detectLayoutWiring(rnAppDir)
		: { path: null, wiringState: "absent" as const, componentShape: "unknown" as const };
	const flowsFile = rnAppDir
		? detectFlowsFile(rnAppDir)
		: { path: null, lastModified: null };
	const hookFile = rnAppDir
		? detectHookFile(rnAppDir)
		: { path: null };
	const iosWorkspace = rnAppDir
		? detectIosWorkspace(rnAppDir)
		: { exists: false, podfileLockExists: false };

	return {
		repoPath,
		workspaceRoot,
		isMonorepo,
		packageManager,
		candidates,
		picked,
		pickedNotFoundReason: picked
			? undefined
			: "Couldn't find an Expo / React Native package. Looked for `expo`, `expo-router`, or `react-native` in package.json under the repo, its direct children, and one level into apps/, packages/.",
		rnLayout,
		snapBridge,
		viewShot,
		layoutFile,
		flowsFile,
		hookFile,
		iosWorkspace,
	};
}

// ── RN candidate ranking ─────────────────────────────────────────────────

function rankRnCandidates(workspaceRoot: string): RnCandidate[] {
	// Reuse `findRnAppDir`'s scan logic but collect every match instead of the
	// first. Pasted here because findRnAppDir's internal `candidates` list
	// isn't exposed — and rewriting against a public API also lets us add
	// proper ranking signals (apps/ prefix, app/ folder presence, etc.).
	const SKIP_DIRS = new Set([
		"node_modules",
		".git",
		".github",
		"dist",
		"build",
		"out",
		".expo",
		".next",
		".turbo",
		".cache",
	]);

	const seen = new Set<string>();
	const out: RnCandidate[] = [];

	const tryAdd = (dir: string) => {
		if (seen.has(dir)) return;
		seen.add(dir);
		const pkg = readPkgJson(join(dir, "package.json"));
		if (!pkg) return;
		const deps = {
			...((pkg.dependencies as Record<string, unknown> | undefined) ?? {}),
			...((pkg.devDependencies as Record<string, unknown> | undefined) ?? {}),
		};
		const isRn = Boolean(
			deps["expo"] || deps["expo-router"] || deps["react-native"],
		);
		if (!isRn) return;
		out.push({
			rnAppDir: dir,
			relativeFromRepo: dir.startsWith(workspaceRoot)
				? dir.slice(workspaceRoot.length + 1) || "."
				: dir,
			hasAppFolder: existsSync(join(dir, "app")),
			packageJsonName:
				typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : null,
		});
	};

	// 1. Workspace root itself.
	tryAdd(workspaceRoot);

	// 2. Direct children.
	let topEntries: string[] = [];
	try {
		topEntries = readdirSync(workspaceRoot);
	} catch {}
	for (const name of topEntries) {
		if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
		const full = join(workspaceRoot, name);
		if (!safeIsDir(full)) continue;
		tryAdd(full);
		// 3. One level deeper for apps/<x>, packages/<x>, ad-hoc nests.
		let inner: string[] = [];
		try {
			inner = readdirSync(full);
		} catch {}
		for (const subname of inner) {
			if (subname.startsWith(".") || SKIP_DIRS.has(subname)) continue;
			const innerFull = join(full, subname);
			if (!safeIsDir(innerFull)) continue;
			tryAdd(innerFull);
		}
	}

	// Rank: apps/* > app/-having dirs > shorter paths > everything else.
	out.sort((a, b) => {
		const aApps = /(^|\/)apps\//.test(a.relativeFromRepo);
		const bApps = /(^|\/)apps\//.test(b.relativeFromRepo);
		if (aApps !== bApps) return aApps ? -1 : 1;
		if (a.hasAppFolder !== b.hasAppFolder) return a.hasAppFolder ? -1 : 1;
		return a.relativeFromRepo.length - b.relativeFromRepo.length;
	});
	return out;
}

// ── Per-aspect detectors ─────────────────────────────────────────────────

function detectPackageManager(
	root: string,
	rootPkg: Record<string, unknown> | null,
): PackageManager {
	const pmField = rootPkg?.packageManager;
	if (typeof pmField === "string") {
		if (pmField.startsWith("pnpm")) return "pnpm";
		if (pmField.startsWith("yarn")) return "yarn";
		if (pmField.startsWith("npm")) return "npm";
		if (pmField.startsWith("bun")) return "bun";
	}
	if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(root, "yarn.lock"))) return "yarn";
	if (existsSync(join(root, "bun.lockb"))) return "bun";
	return "npm";
}

function detectRnLayout(rnAppDir: string): RnLayout {
	if (existsSync(join(rnAppDir, "app", "_layout.tsx"))) return "expo-router";
	if (existsSync(join(rnAppDir, "app", "_layout.ts"))) return "expo-router";
	if (existsSync(join(rnAppDir, "app", "_layout.jsx"))) return "expo-router";
	const pkg = readPkgJson(join(rnAppDir, "package.json"));
	const deps: Record<string, unknown> = {
		...((pkg?.dependencies as Record<string, unknown> | undefined) ?? {}),
		...((pkg?.devDependencies as Record<string, unknown> | undefined) ?? {}),
	};
	if (deps["expo"]) return "expo-classic";
	if (deps["react-native"]) return "rn-cli";
	return "unknown";
}

function detectSnapBridge(
	workspaceRoot: string,
	rnAppDir: string | null,
): SnapBridgeState & { suggested: string } {
	const suggested = getSnapBridgeVersion();
	const matchPkg = (pkgPath: string): SnapBridgeState | null => {
		const pkg = readPkgJson(pkgPath);
		if (!pkg) return null;
		const all = {
			...(pkg.dependencies ?? {}),
			...(pkg.devDependencies ?? {}),
			...(pkg.peerDependencies ?? {}),
		};
		const ref = all["@unicorn-studio/snap-bridge"];
		if (typeof ref !== "string") return null;
		// Pinned: contains "#vX.Y" or "#X.Y" tag suffix
		const tagMatch = ref.match(/#(v?\d[\w.-]*)\s*$/);
		if (tagMatch) {
			const current = tagMatch[1]!;
			return {
				state: "pinned",
				current,
				matchesSuggested:
					current === suggested ||
					current === suggested.replace(/^v/, "") ||
					`v${current}` === suggested,
			};
		}
		return { state: "floating", current: ref };
	};

	if (rnAppDir) {
		const m = matchPkg(join(rnAppDir, "package.json"));
		if (m) return { ...m, suggested };
	}
	if (workspaceRoot !== rnAppDir) {
		const m = matchPkg(join(workspaceRoot, "package.json"));
		if (m) return { ...m, suggested };
	}
	return { state: "missing", suggested };
}

function detectViewShot(
	rnAppDir: string,
	workspaceRoot: string,
): { installed: boolean; podsInstalled: boolean } {
	const isInstalled = (pkgPath: string): boolean => {
		const pkg = readPkgJson(pkgPath);
		if (!pkg) return false;
		const all = {
			...(pkg.dependencies ?? {}),
			...(pkg.devDependencies ?? {}),
		};
		return Boolean(all["react-native-view-shot"]);
	};
	const installed =
		isInstalled(join(rnAppDir, "package.json")) ||
		(rnAppDir !== workspaceRoot &&
			isInstalled(join(workspaceRoot, "package.json")));

	// Pods are only meaningful if there's an iOS workspace. We grep
	// Podfile.lock for "RNViewShot" — cheap and reliable.
	const podLock = join(rnAppDir, "ios", "Podfile.lock");
	let podsInstalled = false;
	try {
		if (existsSync(podLock)) {
			podsInstalled = readFileSync(podLock, "utf8").includes("RNViewShot");
		}
	} catch {}
	return { installed, podsInstalled };
}

function detectLayoutWiring(rnAppDir: string): {
	path: string | null;
	wiringState: LayoutWiringState;
	componentShape: ComponentShape;
} {
	const expected = findRootLayoutPath(rnAppDir);
	if (!existsSync(expected)) {
		return { path: null, wiringState: "absent", componentShape: "unknown" };
	}
	let src = "";
	try {
		src = readFileSync(expected, "utf8");
	} catch {
		return { path: expected, wiringState: "absent", componentShape: "unknown" };
	}
	const wired = /installSnapBridge\s*\(/.test(src);
	const shape = guessComponentShape(src);
	if (wired) return { path: expected, wiringState: "wired", componentShape: shape };
	if (shape === "unknown") {
		return { path: expected, wiringState: "ast-unsupported", componentShape: shape };
	}
	return { path: expected, wiringState: "absent", componentShape: shape };
}

function guessComponentShape(src: string): ComponentShape {
	if (/export\s+default\s+function\s+\w+\s*\(/.test(src)) return "function-decl";
	if (/export\s+default\s+memo\s*\(/.test(src)) return "memo-arrow";
	if (/export\s+default\s+forwardRef\s*\(/.test(src)) return "forwardRef";
	if (/export\s+default\s+\w+\s*;?\s*$/m.test(src)) return "default-export-only";
	if (/const\s+\w+\s*[:=][\s\S]*?=>\s*\{/.test(src)) return "memo-arrow";
	return "unknown";
}

function detectFlowsFile(rnAppDir: string): {
	path: string | null;
	lastModified: string | null;
} {
	const candidates = ["snap-flows.ts", "snap-flows.tsx"];
	for (const name of candidates) {
		const full = join(rnAppDir, name);
		if (existsSync(full)) {
			let lastModified: string | null = null;
			try {
				lastModified = statSync(full).mtime.toISOString();
			} catch {}
			return { path: full, lastModified };
		}
	}
	return { path: null, lastModified: null };
}

function detectHookFile(rnAppDir: string): { path: string | null } {
	const candidates = [
		"hooks/useSnapTarget.ts",
		"src/hooks/useSnapTarget.ts",
		"hooks/useSnapTarget.tsx",
	];
	for (const rel of candidates) {
		const full = join(rnAppDir, rel);
		if (existsSync(full)) return { path: full };
	}
	return { path: null };
}

function detectIosWorkspace(rnAppDir: string): {
	exists: boolean;
	podfileLockExists: boolean;
} {
	const iosDir = join(rnAppDir, "ios");
	if (!safeIsDir(iosDir)) {
		return { exists: false, podfileLockExists: false };
	}
	return {
		exists: true,
		podfileLockExists: existsSync(join(iosDir, "Podfile.lock")),
	};
}

// ── small utils ──────────────────────────────────────────────────────────

function readPkgJson(path: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function safeIsDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
