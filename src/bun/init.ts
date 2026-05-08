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

export const SNAP_BRIDGE_INSTALL_REF =
	process.env.SNAP_BRIDGE_GIT ??
	"git+ssh://git@github.com/hulusi-tunc/snap-bridge.git";

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
	const candidates: string[] = [];
	const directApp = join(workspaceRoot, "app");
	if (existsSync(directApp) && statSync(directApp).isDirectory()) {
		candidates.push(workspaceRoot);
	}
	const appsDir = join(workspaceRoot, "apps");
	if (existsSync(appsDir) && statSync(appsDir).isDirectory()) {
		for (const name of readdirSync(appsDir)) {
			const full = join(appsDir, name);
			if (
				statSync(full).isDirectory() &&
				existsSync(join(full, "app")) &&
				existsSync(join(full, "package.json"))
			) {
				candidates.push(full);
			}
		}
	}
	for (const c of candidates) {
		const pkg = readJson(join(c, "package.json"));
		const deps = {
			...(pkg?.dependencies ?? {}),
			...(pkg?.devDependencies ?? {}),
		};
		if (deps.expo || deps["expo-router"]) return c;
	}
	return null;
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
export function addBridgeDep(rootPkgPath: string): {
	changed: boolean;
	ref: string;
} {
	const pkg = readJson(rootPkgPath);
	if (!pkg) throw new Error(`Could not read ${rootPkgPath}`);
	const ref = SNAP_BRIDGE_INSTALL_REF;
	pkg.devDependencies = pkg.devDependencies ?? {};
	const existing = pkg.devDependencies["@unicorn-studio/snap-bridge"];
	if (existing && existing === ref) return { changed: false, ref };
	pkg.devDependencies["@unicorn-studio/snap-bridge"] = ref;
	const sorted: Record<string, string> = {};
	for (const k of Object.keys(pkg.devDependencies).sort()) {
		sorted[k] = pkg.devDependencies[k];
	}
	pkg.devDependencies = sorted;
	writeFileSync(rootPkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
	return { changed: true, ref };
}

const METRO_CONFIG_TEMPLATE = `// Generated/extended by @unicorn-studio/snap-bridge.
const fs = require("fs");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(projectRoot);

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

export function patchMetroConfig(rnAppDir: string): {
	wrote: boolean;
	mode: "created" | "annotated" | "already-configured";
} {
	const target = join(rnAppDir, "metro.config.js");
	if (!existsSync(target)) {
		writeFileSync(target, METRO_CONFIG_TEMPLATE, "utf8");
		return { wrote: true, mode: "created" };
	}
	const cur = readFileSync(target, "utf8");
	if (cur.includes("@unicorn-studio/snap-bridge")) {
		return { wrote: false, mode: "already-configured" };
	}
	const note = `\n\n// snap-bridge: this metro.config.js needs to follow the\n// @unicorn-studio/snap-bridge dep into watchFolders so Metro can resolve it.\n// Reference: https://github.com/hulusi-tunc/snap-bridge/blob/main/examples/metro.config.js\n`;
	writeFileSync(target, cur + note, "utf8");
	return { wrote: true, mode: "annotated" };
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

	const rootPkgPath = join(workspaceRoot, "package.json");
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

	const dep = addBridgeDep(rootPkgPath);
	if (dep.changed)
		log(
			"ok",
			`added @unicorn-studio/snap-bridge to ${relative(workspaceRoot, rootPkgPath)}`,
		);
	else
		log(
			"info",
			`@unicorn-studio/snap-bridge already in ${relative(workspaceRoot, rootPkgPath)}`,
		);

	const metro = patchMetroConfig(rnAppDir);
	const metroRel = relative(workspaceRoot, join(rnAppDir, "metro.config.js"));
	if (metro.mode === "created") log("ok", `wrote ${metroRel}`);
	else if (metro.mode === "annotated")
		log(
			"warn",
			`${metroRel} exists — appended a TODO note. Verify it follows snap-bridge into watchFolders.`,
		);
	else log("info", `${metroRel} already configured`);

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
