import { spawn } from "node:child_process";
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
	removeCaptureProject,
} from "./init";
import { captureRect } from "./screencapture";
import { forwardTap, mirrorSimulator } from "./simulator";
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
		// Subscribe to bridge-pushed flow declarations and ingest them.
		// The server replays last-known decls on subscribe, so this also
		// catches up clients that connected before the orchestrator existed.
		snapServer.onDeclaredFlows((projectId, decl) => {
			void snapOrch!
				.ingestDeclaration(projectId, decl)
				.catch((err) =>
					dbg(`ingestDeclaration(${projectId}) failed: ${(err as Error).message}`),
				);
		});
	}
	return snapOrch;
}
function findProjectForBridge(projectId: string): CaptureProjectEntry | null {
	if (!projectId) return null;
	const list = loadCaptureProjects();
	return list.find((p) => p.slug === projectId) ?? null;
}

/**
 * Walk up from `rnAppDir` looking for `node_modules/.bin/snap-flows-scan`.
 * In a monorepo the bin can live at the repo root (workspace install) or
 * in the package itself (per-package install) — we check both.
 */
function resolveLocalSnapFlowsBin(
	rnAppDir: string,
	repoRoot: string,
): string | null {
	const candidates = [
		join(rnAppDir, "node_modules", ".bin", "snap-flows-scan"),
		join(repoRoot, "node_modules", ".bin", "snap-flows-scan"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

/**
 * Run `<pm> exec snap-flows-scan` inside a project's RN app directory
 * and report what came back. Used by the "↻ Refresh flows" button so
 * the user doesn't have to drop into a terminal after every route
 * change.
 */
async function runSnapFlowsScanForProject(
	slug: string,
): Promise<
	| { ok: true; output: string; flowsFound?: number; screensFound?: number }
	| { ok: false; error: string }
> {
	const project = findProjectForBridge(slug);
	if (!project) return { ok: false, error: `No project with slug "${slug}"` };
	const rnAppDir = project.rnAppDir;
	if (!rnAppDir || !existsSync(rnAppDir)) {
		return {
			ok: false,
			error: `RN app dir "${rnAppDir ?? "<unset>"}" doesn't exist on disk.`,
		};
	}
	// Lockfile + `packageManager` field usually live at the repo root,
	// not inside `apps/mobile/`. Fall back to rnAppDir if no repo path.
	const pmRoot = project.repoPath && existsSync(project.repoPath)
		? project.repoPath
		: rnAppDir;
	// Pick the right invocation. Prefer the locally-installed bin (no
	// network). Fall back to `npx -y github:...` so an outdated/missing
	// snap-bridge install doesn't error the user out — they get a working
	// scan even with a stale dependency pin.
	const localBin = resolveLocalSnapFlowsBin(rnAppDir, pmRoot);
	const cmd = localBin ?? "npx";
	const args = localBin
		? []
		: ["-y", "github:hulusi-tunc/snap-bridge#v0.2.1", "snap-flows-scan"];

	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			cwd: rnAppDir,
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", (err: Error) => {
			resolve({
				ok: false,
				error: `Failed to spawn ${cmd}: ${err.message}`,
			});
		});
		child.on("close", (code: number | null) => {
			if (code !== 0) {
				resolve({
					ok: false,
					error:
						(stderr || stdout || `Exited with code ${code}`).trim(),
				});
				return;
			}
			// Pull the "N flow(s), M screen(s)" tally out of the output.
			const m = stdout.match(/(\d+)\s+flow\(s\),\s+(\d+)\s+screen\(s\)/);
			resolve({
				ok: true,
				output: stdout.trim(),
				flowsFound: m ? Number(m[1]) : undefined,
				screensFound: m ? Number(m[2]) : undefined,
			});
		});
	});
}

/**
 * Sync the entire local state to web in one shot. Groups snaps by their
 * project (each project has its own upload URL + token), then for each
 * project sends one batched upload with `replace=true` — the server wipes
 * existing frames + builds for that app first. Local snap.uploaded is
 * updated to reflect each frame's outcome.
 *
 * Returns counts so the UI can show "synced N, failed M".
 */
async function pushAll(
	orch: SnapOrchestrator,
	projectSlug?: string,
	message?: string,
): Promise<{ synced: number; failed: number; errors: string[] }> {
	const allSnaps = orch.listAllSnaps();
	// Scope to a single project when a slug is provided — keeps replace=true
	// from accidentally wiping a different app's frames.
	const all = projectSlug
		? allSnaps.filter((s) => s.projectId === projectSlug)
		: allSnaps;
	if (all.length === 0) return { synced: 0, failed: 0, errors: [] };

	const flows = orch.listFlows();
	const byProject = new Map<string, SnapRecord[]>();
	for (const s of all) {
		const list = byProject.get(s.projectId) ?? [];
		list.push(s);
		byProject.set(s.projectId, list);
	}

	let synced = 0;
	let failed = 0;
	const errors: string[] = [];

	for (const [projectId, snaps] of byProject) {
		const project = findProjectForBridge(projectId);
		const url = project?.uploadUrl ?? process.env.SNAP_UPLOAD_URL;
		const token = project?.projectToken ?? process.env.SNAP_UPLOAD_TOKEN;
		if (!url || !token) {
			const msg = `No upload target for project "${projectId}"`;
			errors.push(msg);
			failed += snaps.length;
			continue;
		}
		const session = {
			sessionId: `sync-${Date.now()}`,
			startedAt: new Date().toISOString(),
			snaps,
		};
		const result = await uploadSession({
			url,
			token,
			outDir: orch.outDir,
			session,
			flows,
			allSnaps: all,
			replace: true,
			message: message?.trim() || undefined,
			log: dbg,
		});
		const now = new Date().toISOString();
		if (result.ok) {
			synced += snaps.length;
			for (const s of snaps) {
				await orch.markUploaded(s.sessionId, s.sequence, {
					ok: true,
					buildId: result.buildId,
					uploadedAt: now,
				});
			}
		} else {
			failed += snaps.length;
			errors.push(`Project ${projectId}: ${result.error}`);
			for (const s of snaps) {
				await orch.markUploaded(s.sessionId, s.sequence, {
					ok: false,
					error: result.error,
					uploadedAt: now,
				});
			}
		}
	}

	return { synced, failed, errors };
}

async function uploadOne(
	orch: SnapOrchestrator,
	snap: SnapRecord,
): Promise<RnSnapInfo["uploaded"]> {
	const project = findProjectForBridge(snap.projectId);
	const url = project?.uploadUrl ?? process.env.SNAP_UPLOAD_URL;
	const token = project?.projectToken ?? process.env.SNAP_UPLOAD_TOKEN;
	if (!url || !token) {
		return {
			ok: false,
			error: `No upload target for project "${snap.projectId}". Onboard via + Add to register one.`,
		};
	}
	// Synthesize a single-snap session for the upload — works for any snap,
	// even ones from previous app launches.
	const partial = {
		sessionId: snap.sessionId,
		startedAt: snap.capturedAt,
		snaps: [snap],
	};
	const result = await uploadSession({
		url,
		token,
		outDir: orch.outDir,
		session: partial,
		flows: orch.listFlows(),
		allSnaps: orch.listAllSnaps(),
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
		sessionId: s.sessionId,
		sequence: s.sequence,
		projectId: s.projectId,
		route: s.route,
		navStack: s.navStack,
		stateHash: s.stateHash,
		capturedAt: s.capturedAt,
		imagePath: join(outDir, s.image),
		uploaded: s.uploaded
			? s.uploaded.ok
				? { ok: true, buildId: s.uploaded.buildId ?? "" }
				: { ok: false, error: s.uploaded.error ?? "unknown" }
			: undefined,
		position: s.position,
		flowId: s.flowId,
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
				const all = orch.listAllSnaps();
				const pending = all.filter((s) => !s.uploaded || !s.uploaded.ok).length;
				return {
					port: SNAP_PORT,
					clientCount: snapServer.clientCount(),
					projects: snapServer
						.clients()
						.map((c) => c.projectId)
						.filter(Boolean),
					sessionId: orch.sessionId,
					pendingUploads: pending,
					snaps: all.map((s) => snapToInfo(s, orch.outDir)),
					flows: orch.listFlows(),
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
				// Manual upload only — the user pushes when they're ready.
				return {
					ok: true,
					snap: snapToInfo(r.record, orch.outDir),
					captureMethod: r.captureMethod,
					captureNote: r.captureNote,
				};
			},
			reorderSnaps: async ({ flowId, ordered }) => {
				const orch = await ensureOrchestrator();
				await orch.reorderFlow(flowId, ordered);
				return { ok: true };
			},
			createFlow: async ({ name, projectId, parentFlowId }) => {
				const orch = await ensureOrchestrator();
				const flow = await orch.createFlow(name, projectId, parentFlowId);
				return { ok: true, flow };
			},
			renameFlow: async ({ flowId, name }) => {
				const orch = await ensureOrchestrator();
				const ok = await orch.renameFlow(flowId, name);
				return ok ? { ok: true } : { ok: false, error: "Flow not found" };
			},
			moveSnapsToFlow: async ({ snapIds, toFlowId }) => {
				const orch = await ensureOrchestrator();
				const moved = await orch.moveSnapsToFlow(snapIds, toFlowId);
				return { ok: true, moved };
			},
			deleteFlow: async ({ flowId }) => {
				const orch = await ensureOrchestrator();
				const ok = await orch.deleteFlow(flowId);
				return ok ? { ok: true } : { ok: false, error: "Flow not found" };
			},
			reorderFlows: async ({ orderedIds }) => {
				const orch = await ensureOrchestrator();
				await orch.reorderFlows(orderedIds);
				return { ok: true };
			},
			deleteSnap: async ({ sessionId, sequence }) => {
				const orch = await ensureOrchestrator();
				const ok = await orch.deleteSnap(sessionId, sequence);
				if (!ok) {
					return {
						ok: false,
						error: `No snap with sessionId=${sessionId} sequence=${sequence}`,
					};
				}
				return { ok: true };
			},
			pushAll: async ({ projectSlug, message }) => {
				const orch = await ensureOrchestrator();
				return pushAll(orch, projectSlug, message);
			},
			uploadPending: async ({ force }) => {
				const orch = await ensureOrchestrator();
				// `force` re-pushes every snap regardless of its previous
				// uploaded state — useful after wiping the platform side.
				const pending = force
					? orch.listAllSnaps()
					: orch.listPendingUploads();
				if (pending.length === 0) {
					return { ok: true, uploaded: 0, failed: 0, errors: [] };
				}
				let uploaded = 0;
				let failed = 0;
				const errors: string[] = [];
				for (const snap of pending) {
					const result = await uploadOne(orch, snap);
					const now = new Date().toISOString();
					if (result?.ok) {
						uploaded += 1;
						await orch.markUploaded(snap.sessionId, snap.sequence, {
							ok: true,
							buildId: result.buildId,
							uploadedAt: now,
						});
					} else {
						failed += 1;
						const errMsg = result?.ok === false
							? result.error
							: "no upload target configured";
						errors.push(`#${snap.sequence} ${snap.route}: ${errMsg}`);
						await orch.markUploaded(snap.sessionId, snap.sequence, {
							ok: false,
							error: errMsg,
							uploadedAt: now,
						});
					}
				}
				return { ok: true, uploaded, failed, errors };
			},
			resetSnapSession: async () => {
				snapOrch = null;
				const orch = await ensureOrchestrator();
				return { ok: true, sessionId: orch.sessionId };
			},
			mirrorSimulator: async () => mirrorSimulator(),
			forwardTap: async (p) =>
				forwardTap(p.mirrorX, p.mirrorY, p.mirrorWidth, p.mirrorHeight),
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
			removeProject: async ({ slug }) => {
				const ok = removeCaptureProject(slug);
				if (!ok) return { ok: false, error: `No project with slug "${slug}"` };
				return { ok: true };
			},
			refreshProjectFlows: async ({ slug }) => {
				return runSnapFlowsScanForProject(slug);
			},
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
