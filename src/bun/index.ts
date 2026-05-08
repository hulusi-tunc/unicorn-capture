import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ApplicationMenu,
	BrowserView,
	BrowserWindow,
	Utils,
} from "electrobun/bun";
import type { RnSnapInfo, ScenarioRunnerRPC } from "../lib/rpc";
import { validateDeviceConfig, validateScenario } from "../lib/schemas";
import {
	type CaptureProjectEntry,
	initProject,
	loadCaptureProjects,
} from "./init";
import { captureRect } from "./screencapture";
import {
	createSnapOrchestrator,
	type SnapOrchestrator,
	type SnapRecord,
} from "./snap-orchestrator";
import { startSnapServer } from "./snap-server";
import { resolveSource } from "./sources";
import { uploadSession } from "./upload";

const DBG_LOG = "/tmp/prisma-debug.log";
const dbg = (m: string) => {
	try {
		appendFileSync(DBG_LOG, `[${new Date().toISOString()}] ${m}\n`);
	} catch {}
	console.log(m);
};

process.on("uncaughtException", (e) => dbg(`UNCAUGHT: ${e?.stack || e}`));
process.on("unhandledRejection", (e: any) =>
	dbg(`UNHANDLED: ${e?.stack || e}`),
);

dbg(`prisma starting cwd=${process.cwd()}`);

// Resolve the bundle root so config files work both in dev (cwd=project) and packaged (cwd=.app/MacOS).
function bundleRoot(): string {
	try {
		// In .app: this file lives at Contents/Resources/app/bun/index.js → Resources/app is the right anchor
		const here = dirname(fileURLToPath(import.meta.url));
		const candidates = [
			resolve(here, ".."), // → Resources/app (samples next to bun/)
			resolve(here, "../.."), // → Resources
			process.cwd(),
		];
		for (const c of candidates) {
			if (existsSync(join(c, "samples"))) return c;
		}
		return process.cwd();
	} catch {
		return process.cwd();
	}
}
const ROOT = bundleRoot();
dbg(`ROOT=${ROOT}`);

function screenshotsDir(): string {
	const dir = join(process.cwd(), "screenshots-output");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

// Default RN snap output. Sticks the snaps inside the user's Documents so they
// survive between runs and across app reinstalls.
function snapOutDir(): string {
	const env = process.env.SNAP_OUT;
	if (env && env.length > 0) return resolve(env);
	const dir = join(homedir(), "Documents", "UnicornCapture", "snaps");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

const SNAP_PORT = Number(process.env.SNAP_PORT ?? 9876);
const snapServer = startSnapServer({ port: SNAP_PORT, log: dbg });
let snapOrch: SnapOrchestrator | null = null;
async function ensureOrchestrator(): Promise<SnapOrchestrator> {
	if (!snapOrch) {
		snapOrch = await createSnapOrchestrator({
			server: snapServer,
			outDir: snapOutDir(),
		});
		dbg(`snap session ${snapOrch.sessionId} → ${snapOrch.outDir}`);
	}
	return snapOrch;
}
function findProjectForBridge(projectId: string): CaptureProjectEntry | null {
	if (!projectId) return null;
	const list = loadCaptureProjects();
	return list.find((p) => p.slug === projectId) ?? null;
}

async function autoUpload(
	orch: SnapOrchestrator,
	snap: SnapRecord,
): Promise<RnSnapInfo["uploaded"]> {
	const project = findProjectForBridge(snap.projectId);
	const url = project?.uploadUrl ?? process.env.SNAP_UPLOAD_URL;
	const token = project?.projectToken ?? process.env.SNAP_UPLOAD_TOKEN;
	if (!url || !token) return undefined;
	const session = orch.getSession();
	const partial = { ...session, snaps: [snap] };
	const result = await uploadSession({
		url,
		token,
		outDir: orch.outDir,
		session: partial,
		log: dbg,
	});
	if (result.ok) {
		dbg(`uploaded ${snap.image} → ${url} build ${result.buildId.slice(0, 8)}`);
		return { ok: true, buildId: result.buildId };
	}
	dbg(`upload failed for ${snap.image}: ${result.error}`);
	return { ok: false, error: result.error };
}

function snapToInfo(s: SnapRecord, outDir: string): RnSnapInfo {
	return {
		sequence: s.sequence,
		projectId: s.projectId,
		route: s.route,
		navStack: s.navStack,
		stateHash: s.stateHash,
		capturedAt: s.capturedAt,
		imagePath: join(outDir, s.image),
	};
}
// Boot the orchestrator eagerly so the view's first status poll has a sessionId.
void ensureOrchestrator();

let currentSourceCleanup: (() => void) | null = null;
function freeCurrentSource(): void {
	if (currentSourceCleanup) {
		try {
			currentSourceCleanup();
		} catch (e: any) {
			dbg(`source cleanup err: ${e?.message}`);
		}
		currentSourceCleanup = null;
	}
}

const rpc = BrowserView.defineRPC<ScenarioRunnerRPC>({
	maxRequestTime: 600000,
	handlers: {
		requests: {
			resolveSource: async (input) => {
				freeCurrentSource();
				const r = await resolveSource(input);
				if (!r.ok) return { ok: false, error: r.error };
				currentSourceCleanup = r.value.cleanup;
				return { ok: true, baseUrl: r.value.baseUrl, entry: r.value.entry };
			},
			cleanupSources: async () => {
				freeCurrentSource();
				return { ok: true };
			},
			pickPath: async () => {
				try {
					const paths = await Utils.openFileDialog({
						canChooseFiles: true,
						canChooseDirectory: true,
						allowsMultipleSelection: false,
						allowedFileTypes: "*",
					});
					if (!paths.length || !paths[0])
						return { ok: false, error: "Canceled" };
					const p = paths[0];
					const lower = p.toLowerCase();
					const isArchive =
						lower.endsWith(".zip") ||
						lower.endsWith(".tar") ||
						lower.endsWith(".tar.gz") ||
						lower.endsWith(".tgz");
					return {
						ok: true,
						path: p,
						inferredKind: isArchive ? "archive" : "folder",
					};
				} catch (e: any) {
					return { ok: false, error: e?.message || "Picker failed" };
				}
			},
			validateScenario: async ({ yaml }) => {
				const r = validateScenario(yaml);
				return r.ok
					? { ok: true, value: r.value }
					: { ok: false, error: r.error };
			},
			validateDevices: async ({ yaml }) => {
				const r = validateDeviceConfig(yaml);
				return r.ok
					? { ok: true, value: r.value }
					: { ok: false, error: r.error };
			},
			captureRect: async ({ x, y, width, height, name }) => {
				const r = captureRect({ x, y, width, height }, screenshotsDir(), name);
				return r.ok
					? { ok: true, path: r.path }
					: { ok: false, error: r.error };
			},
			getConfig: async () => {
				const read = (rel: string) => {
					for (const base of [ROOT, process.cwd(), join(ROOT, "Resources")]) {
						try {
							return readFileSync(join(base, rel), "utf-8");
						} catch {}
					}
					return "";
				};
				return {
					devicesYaml: read("samples/devices.yaml"),
					scenarioYaml: read("samples/scenarios.yaml"),
				};
			},
			snapServerStatus: async () => {
				const orch = await ensureOrchestrator();
				return {
					port: SNAP_PORT,
					clientCount: snapServer.clientCount(),
					projects: snapServer
						.clients()
						.map((c) => c.projectId)
						.filter(Boolean),
					sessionId: orch.sessionId,
					snaps: orch.listSnaps().map((s) => snapToInfo(s, orch.outDir)),
				};
			},
			performSnap: async () => {
				const orch = await ensureOrchestrator();
				if (snapServer.clientCount() === 0) {
					return {
						ok: false,
						error:
							"No snap-bridge connected. Start your RN app with @unicorn-studio/snap-bridge installed.",
					};
				}
				const r = await orch.snap();
				if (!r.ok) return { ok: false, error: r.error };
				const info = snapToInfo(r.record, orch.outDir);
				try {
					info.uploaded = await autoUpload(orch, r.record);
				} catch (err) {
					info.uploaded = { ok: false, error: (err as Error).message };
				}
				return { ok: true, snap: info };
			},
			resetSnapSession: async () => {
				snapOrch = null;
				const orch = await ensureOrchestrator();
				return { ok: true, sessionId: orch.sessionId };
			},
			pickRepoPath: async () => {
				try {
					const paths = await Utils.openFileDialog({
						canChooseFiles: false,
						canChooseDirectory: true,
						allowsMultipleSelection: false,
						allowedFileTypes: "*",
					});
					if (!paths.length || !paths[0]) {
						return { ok: false, error: "No folder selected" };
					}
					return { ok: true, path: paths[0] };
				} catch (e: any) {
					return { ok: false, error: e?.message || "Picker failed" };
				}
			},
			listProjects: async () => ({ projects: loadCaptureProjects() }),
			initProject: async (input) => {
				const result = await initProject(input);
				if (!result.ok) {
					return { ok: false, error: result.error, steps: result.steps };
				}
				return {
					ok: true,
					slug: result.slug,
					name: result.name,
					platform: result.platform,
					projectToken: result.projectToken,
					uploadUrl: result.uploadUrl,
					workspaceRoot: result.workspaceRoot,
					rnAppDir: result.rnAppDir,
					layoutPath: result.layoutPath,
					layoutInjection: result.layoutInjection,
					steps: result.steps,
				};
			},
		},
		messages: {},
	},
});

// Standard macOS menu — required for Cmd+C/V/X/Z/A keystrokes to work in inputs.
try {
	ApplicationMenu.setApplicationMenu([
		{
			label: "Prisma",
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "pasteAndMatchStyle" },
				{ role: "delete" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "toggleFullScreen" },
			],
		},
		{
			label: "Window",
			submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
		},
	] as any);
	dbg("ApplicationMenu set");
} catch (e: any) {
	dbg(`ApplicationMenu err: ${e?.message}`);
}

dbg("creating BrowserWindow…");
let _win: BrowserWindow | null = null;
try {
	_win = new BrowserWindow({
		title: "Prisma",
		url: "views://mainview/index.html",
		frame: { x: 0, y: 0, width: 1440, height: 900 },
		rpc,
	});
	dbg(`BrowserWindow created id=${_win?.id}`);
} catch (e: any) {
	dbg(`BrowserWindow FAILED: ${e?.stack || e}`);
}

process.on("exit", () => freeCurrentSource());
