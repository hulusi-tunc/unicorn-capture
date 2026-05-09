import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

/**
 * Onboarding helpers — used by both the snap-bridge CLI (`snap-bridge-init`)
 * and Capture's in-app wizard. Pure file/HTTP operations, no UI.
 */

/**
 * @deprecated Use `getSnapBridgeRef()` from `./snap-bridge-version`
 * instead. Kept as a re-export for any external imports of the old name.
 */
export { getSnapBridgeRef as SNAP_BRIDGE_INSTALL_REF_FN } from "./snap-bridge-version";
import { getSnapBridgeRef } from "./snap-bridge-version";

export interface InitInputs {
	repoPath: string;
	slug: string;
	name?: string;
	platform: "ios" | "android" | "web";
	platformUrl: string;
	setupToken?: string;
	token?: string;
}

export interface InitStep {
	kind: "info" | "ok" | "warn" | "error";
	message: string;
}

export interface InitResult {
	ok: true;
	slug: string;
	name: string;
	platform: string;
	projectId?: string;
	projectToken: string;
	uploadUrl: string;
	workspaceRoot: string;
	rnAppDir: string;
	layoutPath: string;
	layoutInjection:
		| { mode: "injected"; backupPath: string }
		| { mode: "already" }
		| { mode: "manual"; snippet: string; reason: string };
	steps: InitStep[];
}

export type InitOutcome =
	| InitResult
	| { ok: false; error: string; steps: InitStep[] };

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// ── Detection ──────────────────────────────────────────────────────────────
function readJson(path: string): any | null {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

export function findWorkspaceRoot(start: string): string {
	let cur = start;
	while (cur !== "/" && cur !== "") {
		const pkgPath = join(cur, "package.json");
		if (existsSync(pkgPath)) {
			const pkg = readJson(pkgPath);
			if (pkg && (pkg.workspaces || pkg.private)) return cur;
		}
		cur = dirname(cur);
	}
	return start;
}

export function findRnAppDir(workspaceRoot: string): string | null {
	const isRnDir = (dir: string): boolean => {
		const pkgPath = join(dir, "package.json");
		if (!existsSync(pkgPath)) return false;
		const pkg = readJson(pkgPath);
		const deps = {
			...(pkg?.dependencies ?? {}),
			...(pkg?.devDependencies ?? {}),
		};
		return Boolean(
			deps.expo || deps["expo-router"] || deps["react-native"],
		);
	};

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

	const candidates: string[] = [];

	// 1. Root itself (covers a single-package repo where `mobile/` IS the root).
	if (existsSync(join(workspaceRoot, "package.json"))) {
		candidates.push(workspaceRoot);
	}

	// 2. Scan every direct child directory — covers both monorepo conventions
	//    (apps/, packages/) AND ad-hoc layouts (mobile/, app/, client/) without
	//    hardcoding folder names.
	let topEntries: string[] = [];
	try {
		topEntries = readdirSync(workspaceRoot);
	} catch {
		// unreadable
	}
	for (const name of topEntries) {
		if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
		const full = join(workspaceRoot, name);
		try {
			if (!statSync(full).isDirectory()) continue;
		} catch {
			continue;
		}
		// Direct child with its own package.json
		if (existsSync(join(full, "package.json"))) {
			candidates.push(full);
		}
		// One level deeper for monorepo conventions (apps/<x>, packages/<x>, …)
		try {
			for (const inner of readdirSync(full)) {
				if (inner.startsWith(".") || SKIP_DIRS.has(inner)) continue;
				const innerFull = join(full, inner);
				try {
					if (
						statSync(innerFull).isDirectory() &&
						existsSync(join(innerFull, "package.json"))
					) {
						candidates.push(innerFull);
					}
				} catch {
					// skip
				}
			}
		} catch {
			// skip
		}
	}

	// Prefer dirs that look like expo-router (have an `app/` folder).
	const withAppDir: string[] = [];
	const withoutAppDir: string[] = [];
	const seen = new Set<string>();
	for (const c of candidates) {
		if (seen.has(c)) continue;
		seen.add(c);
		if (!isRnDir(c)) continue;
		if (existsSync(join(c, "app"))) withAppDir.push(c);
		else withoutAppDir.push(c);
	}
	return withAppDir[0] ?? withoutAppDir[0] ?? null;
}

export function findRootLayoutPath(rnAppDir: string): string {
	const candidates = ["app/_layout.tsx", "app/_layout.ts", "app/_layout.jsx"];
	for (const c of candidates) {
		const full = join(rnAppDir, c);
		if (existsSync(full)) return full;
	}
	return join(rnAppDir, "app/_layout.tsx");
}

// ── Edits ──────────────────────────────────────────────────────────────────

/**
 * Add (or update) the `@unicorn-studio/snap-bridge` devDependency in the
 * given package.json. `ref` is the install spec — caller is responsible
 * for sourcing it (typically from `getSnapBridgeRef()` so every install
 * pins to the same tag).
 *
 * Returns `{ previousRef }` so the caller can implement a clean rollback
 * by passing the old ref back through this function.
 */
export function addBridgeDep(
	rootPkgPath: string,
	ref: string,
): { changed: boolean; ref: string; previousRef: string | null } {
	const pkg = readJson(rootPkgPath);
	if (!pkg) throw new Error(`Could not read ${rootPkgPath}`);
	pkg.devDependencies = pkg.devDependencies ?? {};
	const existing = pkg.devDependencies["@unicorn-studio/snap-bridge"];
	const previousRef = typeof existing === "string" ? existing : null;
	if (previousRef === ref) {
		return { changed: false, ref, previousRef };
	}
	pkg.devDependencies["@unicorn-studio/snap-bridge"] = ref;
	const sorted: Record<string, string> = {};
	for (const k of Object.keys(pkg.devDependencies).sort()) {
		sorted[k] = pkg.devDependencies[k];
	}
	pkg.devDependencies = sorted;
	writeFileSync(rootPkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
	return { changed: true, ref, previousRef };
}

/**
 * Remove (or restore) the snap-bridge devDependency. If `restoreRef` is
 * provided, sets the dep back to that string instead of deleting it —
 * used by the installer's rollback path so we never leave the package
 * in an in-between state.
 */
export function removeBridgeDep(
	rootPkgPath: string,
	restoreRef: string | null,
): void {
	const pkg = readJson(rootPkgPath);
	if (!pkg) return;
	pkg.devDependencies = pkg.devDependencies ?? {};
	if (restoreRef) {
		pkg.devDependencies["@unicorn-studio/snap-bridge"] = restoreRef;
	} else {
		delete pkg.devDependencies["@unicorn-studio/snap-bridge"];
	}
	const sorted: Record<string, string> = {};
	for (const k of Object.keys(pkg.devDependencies).sort()) {
		sorted[k] = pkg.devDependencies[k];
	}
	pkg.devDependencies = sorted;
	writeFileSync(rootPkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

/**
 * Compute the relative path from the RN app dir to the workspace root.
 * Handles every layout we care about:
 *   - mobile/ at repo root → ".." (1 level)
 *   - apps/mobile/ in monorepo → "../.." (2 levels)
 *   - apps/web/mobile/ → "../../.." (3 levels)
 *   - workspace IS the rn app → "." (no monorepo)
 *
 * The old code hardcoded `path.resolve(projectRoot, "../..")` and broke
 * on the `mobile/` (one-level) layout — the bug ovria hit.
 */
export function metroWorkspaceRelativePath(
	rnAppDir: string,
	workspaceRoot: string,
): string {
	if (rnAppDir === workspaceRoot) return ".";
	const rel = rnAppDir.startsWith(workspaceRoot + "/")
		? rnAppDir.slice(workspaceRoot.length + 1)
		: rnAppDir;
	const depth = rel.split("/").filter(Boolean).length;
	return Array.from({ length: depth }, () => "..").join("/");
}

/**
 * Build the metro.config.js source for a project. `workspaceRelative` is
 * the dotdot path from `__dirname` (the rnAppDir) up to the workspace
 * root, computed by `metroWorkspaceRelativePath`. `flavor` decides
 * whether we use Expo's default config or the bare RN one.
 */
export function metroConfigTemplate(opts: {
	workspaceRelative: string;
	flavor: "expo" | "rn-cli";
}): string {
	const defaultConfigImport =
		opts.flavor === "expo"
			? `const { getDefaultConfig } = require("expo/metro-config");\n\nconst config = getDefaultConfig(projectRoot);`
			: `const { getDefaultConfig } = require("@react-native/metro-config");\n\nconst config = getDefaultConfig(projectRoot);`;

	return `// Generated/extended by @unicorn-studio/snap-bridge.
const fs = require("fs");
const path = require("path");

const projectRoot = __dirname;
// Relative path from this file's directory up to the workspace root —
// where snap-bridge lives in node_modules. Computed at install time
// so it's correct for any monorepo layout.
const workspaceRoot = path.resolve(projectRoot, ${JSON.stringify(opts.workspaceRelative)});

${defaultConfigImport}

const externalLinkedPackages = ["@unicorn-studio/snap-bridge"];
const externalRealPaths = externalLinkedPackages
  .map((pkg) => {
    try {
      return fs.realpathSync(path.join(workspaceRoot, "node_modules", pkg));
    } catch {
      return null;
    }
  })
  .filter(Boolean);

config.watchFolders = [workspaceRoot, ...externalRealPaths];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
`;
}

/**
 * Write or annotate the project's metro.config.js so Metro can follow
 * the snap-bridge dep across the workspace boundary. Caller passes the
 * fingerprint-derived `workspaceRoot` + `flavor` so the template gets
 * the correct relative path.
 *
 * Returns the previous file contents (or `null` if there was none) so
 * the installer's rollback step can restore on failure.
 */
export function patchMetroConfig(opts: {
	rnAppDir: string;
	workspaceRoot: string;
	flavor: "expo" | "rn-cli";
}): {
	wrote: boolean;
	mode: "created" | "annotated" | "already-configured";
	previousContents: string | null;
} {
	const target = join(opts.rnAppDir, "metro.config.js");
	const workspaceRelative = metroWorkspaceRelativePath(
		opts.rnAppDir,
		opts.workspaceRoot,
	);
	if (!existsSync(target)) {
		writeFileSync(
			target,
			metroConfigTemplate({ workspaceRelative, flavor: opts.flavor }),
			"utf8",
		);
		return { wrote: true, mode: "created", previousContents: null };
	}
	const cur = readFileSync(target, "utf8");
	if (cur.includes("@unicorn-studio/snap-bridge")) {
		return {
			wrote: false,
			mode: "already-configured",
			previousContents: cur,
		};
	}
	const note = `\n\n// snap-bridge: this metro.config.js needs to follow the\n// @unicorn-studio/snap-bridge dep into watchFolders so Metro can resolve it.\n// Reference: https://github.com/hulusi-tunc/snap-bridge/blob/main/examples/metro.config.js\n`;
	writeFileSync(target, cur + note, "utf8");
	return { wrote: true, mode: "annotated", previousContents: cur };
}

// ── _layout.tsx auto-injection (regex heuristic, conservative) ─────────────
export function layoutSnippet(slug: string): string {
	return `// ── @unicorn-studio/snap-bridge wiring ──────────────────────────────────
import { useEffect } from "react";
import { usePathname, useSegments } from "expo-router";
import { installSnapBridge, setSnapState } from "@unicorn-studio/snap-bridge";

installSnapBridge({ projectId: ${JSON.stringify(slug)} });

// Inside your root component, after any \`useFonts\` calls:
const pathname = usePathname();
const segments = useSegments();
useEffect(() => {
  setSnapState({ route: pathname, navStack: segments });
}, [pathname, segments]);
`;
}

export function injectLayoutSnippet(
	layoutPath: string,
	slug: string,
):
	| {
			mode: "injected";
			backupPath: string;
	  }
	| {
			mode: "already";
	  }
	| {
			mode: "manual";
			snippet: string;
			reason: string;
	  } {
	if (!existsSync(layoutPath)) {
		return {
			mode: "manual",
			snippet: layoutSnippet(slug),
			reason: `Couldn't find ${layoutPath}.`,
		};
	}
	let src = readFileSync(layoutPath, "utf8");
	if (src.includes("@unicorn-studio/snap-bridge")) {
		return { mode: "already" };
	}

	// Find a good place to inject imports: after the last top-level import line.
	const importLineRe = /^import [^;]+;[ \t]*$/gm;
	let lastImportEnd = -1;
	for (const match of src.matchAll(importLineRe)) {
		if (match.index === undefined) continue;
		lastImportEnd = match.index + match[0].length;
	}

	const importBlock =
		`\nimport { useEffect } from "react";\n` +
		`import { usePathname, useSegments } from "expo-router";\n` +
		`import { installSnapBridge, setSnapState } from "@unicorn-studio/snap-bridge";\n` +
		`\ninstallSnapBridge({ projectId: ${JSON.stringify(slug)} });\n`;

	if (lastImportEnd === -1) {
		return {
			mode: "manual",
			snippet: layoutSnippet(slug),
			reason:
				"No import statements found at the top of the file — refusing to auto-edit.",
		};
	}

	// Find `export default function ...(...) {` and insert hooks just inside the body.
	const exportDefaultRe =
		/export\s+default\s+function\s+\w+\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/;
	const exp = exportDefaultRe.exec(src);
	if (!exp) {
		return {
			mode: "manual",
			snippet: layoutSnippet(slug),
			reason:
				"Couldn't locate `export default function ...() {` — refusing to auto-edit.",
		};
	}
	const afterFnBrace = exp.index + exp[0].length;

	const hookBlock =
		`\n  // ── @unicorn-studio/snap-bridge route tracking ──\n` +
		`  const __snapPathname = usePathname();\n` +
		`  const __snapSegments = useSegments();\n` +
		`  useEffect(() => {\n` +
		`    setSnapState({ route: __snapPathname, navStack: __snapSegments });\n` +
		`  }, [__snapPathname, __snapSegments]);\n`;

	// Backup before edit.
	const backupPath = `${layoutPath}.snap-bridge.bak`;
	writeFileSync(backupPath, src, "utf8");

	// Splice imports first, then hooks (afterFnBrace shifts by importBlock length).
	const beforeImports = src.slice(0, lastImportEnd);
	const afterImports = src.slice(lastImportEnd);
	src = beforeImports + importBlock + afterImports;
	const newAfterFnBrace = afterFnBrace + importBlock.length;
	src = src.slice(0, newAfterFnBrace) + hookBlock + src.slice(newAfterFnBrace);
	writeFileSync(layoutPath, src, "utf8");

	return { mode: "injected", backupPath };
}

// ── Local config + Capture registration ───────────────────────────────────
export function writeUnicornDir(
	rnAppDir: string,
	payload: Record<string, unknown>,
): void {
	const dir = join(rnAppDir, ".unicorn");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "project.json"),
		`${JSON.stringify(payload, null, 2)}\n`,
		"utf8",
	);
	const ignorePath = join(dir, ".gitignore");
	if (!existsSync(ignorePath)) {
		writeFileSync(ignorePath, "project.json\n", "utf8");
	}
}

export function captureProjectsPath(): string {
	return join(
		homedir(),
		"Library",
		"Application Support",
		"UnicornCapture",
		"projects.json",
	);
}

export interface CaptureProjectEntry {
	slug: string;
	name?: string;
	platform: string;
	projectToken: string;
	uploadUrl: string;
	repoPath?: string;
	rnAppDir?: string;
	registeredAt: string;
}

export function loadCaptureProjects(): CaptureProjectEntry[] {
	const path = captureProjectsPath();
	if (!existsSync(path)) return [];
	try {
		const list = JSON.parse(readFileSync(path, "utf8"));
		return Array.isArray(list) ? (list as CaptureProjectEntry[]) : [];
	} catch {
		return [];
	}
}

export function registerWithCapture(payload: CaptureProjectEntry): string {
	const path = captureProjectsPath();
	mkdirSync(dirname(path), { recursive: true });
	const list = loadCaptureProjects();
	const idx = list.findIndex((p) => p.slug === payload.slug);
	if (idx >= 0) list[idx] = { ...list[idx], ...payload };
	else list.push(payload);
	writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`, "utf8");
	return path;
}

/**
 * Look up a registered project by its slug. Returns null when not found.
 * Used by RPC handlers + the snap-flows improver to resolve `slug` →
 * upload URL + token + on-disk paths.
 */
export function findProjectForBridge(
	projectId: string,
): CaptureProjectEntry | null {
	if (!projectId) return null;
	const list = loadCaptureProjects();
	return list.find((p) => p.slug === projectId) ?? null;
}

/**
 * Remove a project from the local capture registry. Returns true if a
 * matching slug was found + deleted. Doesn't touch anything on the
 * platform side or in the user's repo.
 */
export function removeCaptureProject(slug: string): boolean {
	const path = captureProjectsPath();
	if (!existsSync(path)) return false;
	const list = loadCaptureProjects();
	const idx = list.findIndex((p) => p.slug === slug);
	if (idx === -1) return false;
	list.splice(idx, 1);
	writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`, "utf8");
	return true;
}

// ── Platform call ──────────────────────────────────────────────────────────
export async function createProjectOnPlatform(args: {
	url: string;
	setupToken: string;
	slug: string;
	name: string;
	platform: string;
}): Promise<{
	id: string;
	slug: string;
	name: string;
	platform: string;
	projectToken: string;
}> {
	let resp: Response;
	try {
		resp = await fetch(`${args.url.replace(/\/$/, "")}/api/projects`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${args.setupToken}`,
			},
			body: JSON.stringify({
				slug: args.slug,
				name: args.name,
				platform: args.platform,
			}),
		});
	} catch (err) {
		throw new Error(
			`Could not reach platform at ${args.url}: ${(err as Error).message}`,
		);
	}
	const text = await resp.text();
	let json: any;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(
			`Platform returned non-JSON (${resp.status}): ${text.slice(0, 200)}`,
		);
	}
	if (!resp.ok) {
		throw new Error(`${resp.status} ${json.error ?? text}`);
	}
	return json;
}

// ── End-to-end driver ──────────────────────────────────────────────────────
export async function initProject(input: InitInputs): Promise<InitOutcome> {
	const steps: InitStep[] = [];
	const log = (kind: InitStep["kind"], message: string) => {
		steps.push({ kind, message });
	};

	const slug = input.slug.trim();
	if (!SLUG_RE.test(slug)) {
		return {
			ok: false,
			error: `Invalid slug "${slug}" — use lowercase kebab-case.`,
			steps,
		};
	}
	if (!["ios", "android", "web"].includes(input.platform)) {
		return { ok: false, error: `Invalid platform "${input.platform}".`, steps };
	}

	const repoPath = input.repoPath;
	if (!existsSync(repoPath)) {
		return { ok: false, error: `Repo path does not exist: ${repoPath}`, steps };
	}

	const workspaceRoot = findWorkspaceRoot(repoPath);
	const rnAppDir = findRnAppDir(workspaceRoot);
	if (!rnAppDir) {
		return {
			ok: false,
			error:
				"Couldn't find an Expo / RN app under this workspace. Looked for `app/` + expo dependency under `.` and `apps/*`.",
			steps,
		};
	}
	log("ok", `workspace root: ${workspaceRoot}`);
	log("ok", `RN app dir: ${rnAppDir}`);

	// In a monorepo (root package.json with workspaces), the snap-bridge dep
	// goes on the root and Metro needs watchFolders to follow it across the
	// workspace boundary. In a single-package layout (no root package.json),
	// the RN app dir IS effectively the root — install + Metro both work
	// with default Expo config and no metro.config.js patching is needed.
	const isMonorepo = existsSync(join(workspaceRoot, "package.json"));
	const installTargetPkg = isMonorepo
		? join(workspaceRoot, "package.json")
		: join(rnAppDir, "package.json");
	const layoutPath = findRootLayoutPath(rnAppDir);
	const name = (input.name?.trim() || slug).trim();
	const platformUrl = input.platformUrl.replace(/\/$/, "");

	let projectToken = input.token?.trim();
	let projectId: string | undefined;
	if (!projectToken) {
		if (!input.setupToken) {
			return {
				ok: false,
				error: "Either token or setupToken is required.",
				steps,
			};
		}
		try {
			const r = await createProjectOnPlatform({
				url: platformUrl,
				setupToken: input.setupToken,
				slug,
				name,
				platform: input.platform,
			});
			projectToken = r.projectToken;
			projectId = r.id;
			log("ok", `created app on platform: ${r.slug} (id ${r.id})`);
		} catch (err) {
			return {
				ok: false,
				error: `Platform call failed: ${(err as Error).message}`,
				steps,
			};
		}
	} else {
		if (!projectToken.startsWith("pgt_")) {
			return {
				ok: false,
				error: "Project token should start with 'pgt_'.",
				steps,
			};
		}
		log("info", "reusing supplied project token");
	}

	const dep = addBridgeDep(installTargetPkg, getSnapBridgeRef());
	if (dep.changed)
		log(
			"ok",
			`added @unicorn-studio/snap-bridge to ${relative(workspaceRoot, installTargetPkg)}`,
		);
	else
		log(
			"info",
			`@unicorn-studio/snap-bridge already in ${relative(workspaceRoot, installTargetPkg)}`,
		);

	if (isMonorepo) {
		const metro = patchMetroConfig({
			rnAppDir,
			workspaceRoot,
			flavor: "expo",
		});
		const metroRel = relative(workspaceRoot, join(rnAppDir, "metro.config.js"));
		if (metro.mode === "created") log("ok", `wrote ${metroRel}`);
		else if (metro.mode === "annotated")
			log(
				"warn",
				`${metroRel} exists — appended a TODO note. Verify it follows snap-bridge into watchFolders.`,
			);
		else log("info", `${metroRel} already configured`);
	} else {
		log(
			"info",
			"single-package layout — default Metro config is sufficient (snap-bridge installs into local node_modules)",
		);
	}

	const inj = injectLayoutSnippet(layoutPath, slug);
	if (inj.mode === "injected")
		log(
			"ok",
			`injected snap-bridge wiring into ${relative(workspaceRoot, layoutPath)} (backup at .snap-bridge.bak)`,
		);
	else if (inj.mode === "already")
		log("info", `${relative(workspaceRoot, layoutPath)} already wired`);
	else
		log(
			"warn",
			`couldn't auto-edit ${relative(workspaceRoot, layoutPath)}: ${inj.reason}`,
		);

	const uploadUrl = `${platformUrl}/api/captures/upload`;

	writeUnicornDir(rnAppDir, {
		slug,
		name,
		platform: input.platform,
		projectToken,
		uploadUrl,
		createdAt: new Date().toISOString(),
	});
	log(
		"ok",
		`wrote ${relative(workspaceRoot, join(rnAppDir, ".unicorn/project.json"))} (gitignored)`,
	);

	registerWithCapture({
		slug,
		name,
		platform: input.platform,
		projectToken: projectToken!,
		uploadUrl,
		repoPath: workspaceRoot,
		rnAppDir,
		registeredAt: new Date().toISOString(),
	});
	log("ok", "registered with Unicorn Capture");

	return {
		ok: true,
		slug,
		name,
		platform: input.platform,
		projectId,
		projectToken: projectToken!,
		uploadUrl,
		workspaceRoot,
		rnAppDir,
		layoutPath,
		layoutInjection: inj,
		steps,
	};
}
