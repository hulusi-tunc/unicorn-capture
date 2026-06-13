import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ApplicationMenu,
	BrowserView,
	BrowserWindow,
	Updater,
	Utils,
} from "electrobun/bun";
import type {
	RnSnapInfo,
	ScenarioRunnerRPC,
	UpdateReadyMessage,
} from "../lib/rpc";
import { validateDeviceConfig, validateScenario } from "../lib/schemas";
import { probeExpoDevServer, probeSimulatorBooted, runDoctor } from "./doctor";
import {
	type CaptureProjectEntry,
	createProjectOnPlatform,
	findProjectForBridge,
	getAugmentedSpawnEnv,
	initProject,
	loadCaptureProjects,
	registerWithCapture,
	removeCaptureProject,
} from "./init";
import {
	type InstallOutcome,
	type InstallPlan,
	runInstaller,
} from "./installer";
import { assembleCoreSteps } from "./installer-steps";
import { fingerprintRepo } from "./repo-fingerprint";
import { captureRect } from "./screencapture";
import { bootDevice, forwardTap, listDevices, mirrorSimulator } from "./simulator";
import {
	buildImprovePrompt,
	buildWebImprovePrompt,
} from "./snap-flows-improver";
import {
	createSnapOrchestrator,
	type SnapOrchestrator,
	type SnapRecord,
} from "./snap-orchestrator";
import { startSnapServer } from "./snap-server";
import { resolveSource } from "./sources";
import { frameIdFromSnap, uploadSession } from "./upload";
import { buildVerifyStep } from "./verifier";
import { discoverWebRoutes } from "./web-route-discovery";

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

// Default RN snap output. ~/Library/Application Support is the standard macOS
// per-user app data location — survives reinstalls, NOT iCloud-synced. The
// old default at ~/Documents/UnicornCapture caused EPERM races on
// manifest.json because iCloud Drive's FileProvider kept locking the file
// during sync (and gave "Operation not permitted" on shell reads, broke
// snap-server's image streaming, etc.). If the legacy ~/Documents path is
// present and the Library path is empty, the legacy path is preferred so
// existing sessions stay visible after the upgrade — move the contents to
// Library/Application Support/UnicornCapture/ to fully escape iCloud.
function snapOutDir(): string {
	const env = process.env.SNAP_OUT;
	if (env && env.length > 0) return resolve(env);
	const libraryPath = join(
		homedir(),
		"Library",
		"Application Support",
		"UnicornCapture",
		"snaps",
	);
	const legacyPath = join(homedir(), "Documents", "UnicornCapture", "snaps");
	// Prefer legacy iff the new location is empty and legacy has data — gives
	// the user one warm-up run after upgrade without losing their gallery.
	if (existsSync(legacyPath) && !existsSync(libraryPath)) {
		dbg(
			`snapOutDir: using legacy path ${legacyPath} — move to ${libraryPath} to escape iCloud`,
		);
		return legacyPath;
	}
	if (!existsSync(libraryPath)) mkdirSync(libraryPath, { recursive: true });
	return libraryPath;
}

const SNAP_PORT = Number(process.env.SNAP_PORT ?? 9876);
let snapOrch: SnapOrchestrator | null = null;
const snapServer = startSnapServer({
	port: SNAP_PORT,
	log: dbg,
	// /tour/snap routes through the orchestrator. We always return a non-
	// null backend so the first tour snap auto-initialises the orchestrator
	// — otherwise the tour would have to wait for the user to manually
	// open iossim mode before the orchestrator exists.
	tourBackend: () => ({
		snap: async (opts) => {
			const orch = await ensureOrchestrator();
			const r = await orch.snap({
				projectId: opts?.projectId,
				forceFlowId: opts?.flowId,
			});
			if (!r.ok) return { ok: false, error: r.error };
			return {
				ok: true,
				record: r.record as unknown as Record<string, unknown>,
			};
		},
	}),
	webExtBackend: () => ({
		listWebProjects: async () => {
			return loadCaptureProjects()
				.filter((p) => p.platform === "web")
				.map((p) => ({
					slug: p.slug,
					name: p.name ?? p.slug,
					baseUrl: p.baseUrl,
				}));
		},
		listFlowsForProject: async (projectId) => {
			const orch = await ensureOrchestrator();
			return orch
				.listFlows()
				.filter((f) => f.projectId === projectId)
				.map((f) => ({
					id: f.id,
					name: f.name,
					parentFlowId: f.parentFlowId,
				}));
		},
		recordSnap: async (opts) => {
			const orch = await ensureOrchestrator();
			try {
				const r = await orch.recordWebSnap({
					projectId: opts.projectId,
					url: opts.url,
					title: opts.title,
					fullPage: opts.fullPage,
					flowId: opts.flowId,
					pngBytes: opts.pngBytes,
				});
				return {
					ok: true,
					record: r.record as unknown as Record<string, unknown>,
					placement: r.placement as unknown as Record<string, unknown>,
				};
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},
	}),
});
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
					dbg(
						`ingestDeclaration(${projectId}) failed: ${(err as Error).message}`,
					),
				);
		});
	}
	return snapOrch;
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
	return resolveLocalBridgeBin(rnAppDir, repoRoot, "snap-flows-scan");
}

function resolveLocalBridgeBin(
	rnAppDir: string,
	repoRoot: string,
	binName: string,
): string | null {
	const candidates = [
		join(rnAppDir, "node_modules", ".bin", binName),
		join(repoRoot, "node_modules", ".bin", binName),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

/**
 * Run `snap-bridge-wrap-screen <route>` (or --unwrap) in the customer
 * repo. Pairs with the dashboard's "Enable long-page capture" button so
 * designers can opt a single screen into full-page snap mode without
 * hand-editing app/.
 */
async function runWrapScreenForProject(
	slug: string,
	route: string,
	mode: "wrap" | "unwrap" | "list",
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
	const project = findProjectForBridge(slug);
	if (!project) return { ok: false, error: `No project with slug "${slug}"` };
	const rnAppDir = project.rnAppDir;
	if (!rnAppDir || !existsSync(rnAppDir)) {
		return {
			ok: false,
			error: `RN app dir "${rnAppDir ?? "<unset>"}" doesn't exist on disk.`,
		};
	}
	const pmRoot =
		project.repoPath && existsSync(project.repoPath)
			? project.repoPath
			: rnAppDir;
	const localBin = resolveLocalBridgeBin(
		rnAppDir,
		pmRoot,
		"snap-bridge-wrap-screen",
	);
	const cmd = localBin ?? "npx";
	const baseArgs = localBin
		? []
		: [
				"-y",
				"github:hulusi-tunc/snap-bridge#v0.9.0",
				"snap-bridge-wrap-screen",
			];
	const cliArgs: string[] = [];
	if (mode === "list") cliArgs.push("--list");
	else cliArgs.push(route);
	if (mode === "unwrap") cliArgs.push("--unwrap");
	const args = [...baseArgs, ...cliArgs];

	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			cwd: rnAppDir,
			env: getAugmentedSpawnEnv(),
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
			resolve({ ok: false, error: `Failed to spawn ${cmd}: ${err.message}` });
		});
		child.on("close", (code: number | null) => {
			if (code !== 0) {
				resolve({
					ok: false,
					error: (stderr || stdout || `Exited with code ${code}`).trim(),
				});
				return;
			}
			resolve({ ok: true, output: stdout.trim() });
		});
	});
}

/**
 * Run an npm/pnpm/yarn install (or arbitrary command) in the customer
 * repo's package-manager root. Used by Doctor's auto-fix actions to
 * bump snap-bridge, install react-native-view-shot, etc. without
 * dropping the designer into a terminal.
 *
 * Picks `pm` from .unicorn/project.json fingerprint when present;
 * otherwise falls back to `npm` (works for npm/pnpm/yarn lockfiles
 * since `npm install` isn't strictly the right tool but the existing
 * lockfile usually catches the lookup).
 */
async function runPmCommand(
	project: CaptureProjectEntry,
	args: string[],
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
	const pmRoot =
		project.repoPath && existsSync(project.repoPath)
			? project.repoPath
			: project.rnAppDir;
	if (!pmRoot) {
		return {
			ok: false,
			error: `No package manager root for "${project.slug}"`,
		};
	}
	// Pick package manager from lockfile presence — quick + correct enough
	// for the common cases. `bun` projects keep bun.lock, pnpm has
	// pnpm-lock.yaml, yarn has yarn.lock; default to npm.
	const pm = existsSync(join(pmRoot, "bun.lock"))
		? "bun"
		: existsSync(join(pmRoot, "pnpm-lock.yaml"))
			? "pnpm"
			: existsSync(join(pmRoot, "yarn.lock"))
				? "yarn"
				: "npm";
	return new Promise((resolve) => {
		const child = spawn(pm, args, { cwd: pmRoot, env: getAugmentedSpawnEnv() });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", (err: Error) => {
			resolve({ ok: false, error: `Failed to spawn ${pm}: ${err.message}` });
		});
		child.on("close", (code: number | null) => {
			if (code !== 0) {
				resolve({
					ok: false,
					error: (stderr || stdout || `Exited with code ${code}`).trim(),
				});
				return;
			}
			resolve({ ok: true, output: stdout.trim() });
		});
	});
}

/**
 * Boot the iOS Simulator app — opens Simulator.app, which restores the
 * last-used device. Equivalent to clicking the dock icon, but
 * triggerable from Capture's Doctor panel so the user doesn't have to
 * leave the app. Returns quickly; `open` is fire-and-forget.
 */
async function bootSimulator(): Promise<
	{ ok: true; output: string } | { ok: false; error: string }
> {
	return new Promise((resolve) => {
		const child = spawn("open", ["-a", "Simulator"], { env: getAugmentedSpawnEnv() });
		let stderr = "";
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", (err: Error) => {
			resolve({ ok: false, error: `Failed to open Simulator: ${err.message}` });
		});
		child.on("close", (code: number | null) => {
			if (code !== 0) {
				resolve({
					ok: false,
					error: (stderr || `Exited with code ${code}`).trim(),
				});
				return;
			}
			resolve({
				ok: true,
				output:
					"Opening Simulator. Your last-used device should boot in a few seconds.",
			});
		});
	});
}

/**
 * Spawn `<pm> expo start` inside the project's RN app directory.
 * Detaches the child so killing Capture doesn't kill the dev server,
 * and waits briefly to confirm the process didn't die immediately
 * (which would indicate a missing dep or wrong cwd). Logs are written
 * to the captured project's debug stream so the Doctor panel can hint
 * "see Console for output" without us building a log viewer in v1.
 */
async function launchExpoForProject(
	slug: string,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
	const project = findProjectForBridge(slug);
	if (!project) {
		return { ok: false, error: `No project with slug "${slug}"` };
	}
	const cwd =
		project.rnAppDir && existsSync(project.rnAppDir)
			? project.rnAppDir
			: project.repoPath;
	if (!cwd || !existsSync(cwd)) {
		return {
			ok: false,
			error: `No workspace on disk for "${slug}" (looked for ${project.rnAppDir ?? project.repoPath})`,
		};
	}
	// Pick package manager the same way runPmCommand does so `npx expo`
	// goes through the project's own toolchain (avoids "expo not found"
	// when the global is missing).
	const pm = existsSync(join(cwd, "bun.lock"))
		? "bun"
		: existsSync(join(cwd, "pnpm-lock.yaml"))
			? "pnpm"
			: existsSync(join(cwd, "yarn.lock"))
				? "yarn"
				: "npm";
	const execArgs =
		pm === "npm" || pm === "yarn" ? ["expo", "start"] : ["expo", "start"];
	const launcher = pm === "npm" ? "npx" : pm;
	const args = pm === "npm" ? execArgs : ["x", ...execArgs];
	return new Promise((resolve) => {
		try {
			const child = spawn(launcher, args, {
				cwd,
				env: { ...getAugmentedSpawnEnv(), FORCE_COLOR: "0" },
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let earlyStderr = "";
			child.stderr.on("data", (d: Buffer) => {
				earlyStderr += d.toString();
				dbg(`[expo] ${d.toString().trimEnd()}`);
			});
			child.stdout.on("data", (d: Buffer) => {
				dbg(`[expo] ${d.toString().trimEnd()}`);
			});
			child.on("error", (err: Error) => {
				resolve({
					ok: false,
					error: `Failed to spawn ${launcher}: ${err.message}`,
				});
			});
			// Hold the RPC for 2.5s — long enough to catch immediate
			// failures (wrong cwd, expo not installed) but short enough
			// that the user gets a snappy ack when it works. After that
			// we unref so Capture can exit without killing Expo.
			const settle = setTimeout(() => {
				if (child.exitCode !== null) {
					resolve({
						ok: false,
						error:
							earlyStderr.trim() ||
							`expo exited with code ${child.exitCode}`,
					});
					return;
				}
				try {
					child.unref();
				} catch {}
				resolve({
					ok: true,
					output: `Started \`${launcher} ${args.join(" ")}\` in ${cwd}. Bridge should connect once the app loads.`,
				});
			}, 2500);
			child.once("exit", () => {
				clearTimeout(settle);
				// If we got here before the settle fired, it's a fast
				// failure; the timer handler also covers this but we
				// race-resolve to surface the error sooner.
				resolve({
					ok: false,
					error:
						earlyStderr.trim() ||
						`expo exited with code ${child.exitCode ?? "unknown"}`,
				});
			});
		} catch (err) {
			resolve({
				ok: false,
				error: `Failed to launch Expo: ${(err as Error).message}`,
			});
		}
	});
}

/**
 * Run `<pm> exec snap-flows-scan` inside a project's RN app directory
 * and report what came back. Used by the "↻ Refresh flows" button so
 * the user doesn't have to drop into a terminal after every route
 * change.
 */
async function runSnapFlowsScanForProject(
	slug: string,
	mode: "merge" | "regenerate" = "merge",
): Promise<
	| {
			ok: true;
			output: string;
			flowsFound?: number;
			screensFound?: number;
			mode: "merge" | "regenerate";
	  }
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
	const pmRoot =
		project.repoPath && existsSync(project.repoPath)
			? project.repoPath
			: rnAppDir;
	// Pick the right invocation. Prefer the locally-installed bin (no
	// network). Fall back to `npx -y github:...` so an outdated/missing
	// snap-bridge install doesn't error the user out — they get a working
	// scan even with a stale dependency pin.
	const localBin = resolveLocalSnapFlowsBin(rnAppDir, pmRoot);
	const cmd = localBin ?? "npx";
	const baseArgs = localBin
		? []
		: ["-y", "github:hulusi-tunc/snap-bridge#v0.9.0", "snap-flows-scan"];
	const args = mode === "merge" ? [...baseArgs, "--merge"] : baseArgs;

	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			cwd: rnAppDir,
			env: getAugmentedSpawnEnv(),
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
					error: (stderr || stdout || `Exited with code ${code}`).trim(),
				});
				return;
			}
			// Pull the "N flow(s), M screen(s)" tally out of the output
			// (regenerate mode) or the "Merged N new route" line (merge mode).
			const m = stdout.match(/(\d+)\s+flow\(s\),\s+(\d+)\s+screen\(s\)/);
			resolve({
				ok: true,
				output: stdout.trim(),
				flowsFound: m ? Number(m[1]) : undefined,
				screensFound: m ? Number(m[2]) : undefined,
				mode,
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
/** One skipped frame surfaced back to the UI summary modal. */
export interface PushSkipped {
	projectId: string;
	image: string;
	reason: "missing-file" | "read-error";
}

async function pushAll(
	orch: SnapOrchestrator,
	projectSlug?: string,
	message?: string,
): Promise<{
	synced: number;
	failed: number;
	errors: string[];
	skipped: PushSkipped[];
}> {
	const allSnaps = orch.listAllSnaps();
	// Scope to a single project when a slug is provided — keeps replace=true
	// from accidentally wiping a different app's frames.
	const all = projectSlug
		? allSnaps.filter((s) => s.projectId === projectSlug)
		: allSnaps;
	if (all.length === 0) return { synced: 0, failed: 0, errors: [], skipped: [] };

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
	const skipped: PushSkipped[] = [];

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
		// Tag each skipped image with its project so the summary modal
		// can group by project when the user has multiple onboarded.
		for (const s of result.skipped) {
			skipped.push({ projectId, image: s.image, reason: s.reason });
		}
		const now = new Date().toISOString();
		if (result.ok) {
			synced += snaps.length;
			// Map gallery-returned `frameId → url` so we can hand each snap
			// its own `remoteImageUrl`. The lookup is by frameIdFromSnap
			// to match the same id the upload manifest used.
			const urlByFrameId = new Map<string, string>();
			for (const f of result.frames) urlByFrameId.set(f.frameId, f.url);
			for (const s of snaps) {
				const remoteImageUrl = urlByFrameId.get(frameIdFromSnap(s));
				await orch.markUploaded(
					s.sessionId,
					s.sequence,
					{
						ok: true,
						buildId: result.buildId,
						uploadedAt: now,
					},
					remoteImageUrl ? { remoteImageUrl } : undefined,
				);
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

	// Catch-up prune: snaps from prior sessions whose 7-day cache window
	// has passed get their local PNGs reclaimed now. Snaps marked uploaded
	// in THIS push have evictAt = now + 7d so they're safe. Best-effort —
	// any error is logged but doesn't fail the push.
	try {
		const { deleted, freedBytes } = await orch.pruneEvicted({
			projectId: projectSlug,
		});
		if (deleted > 0) {
			const mb = (freedBytes / (1024 * 1024)).toFixed(1);
			dbg(`prune-evicted: reclaimed ${deleted} local PNG(s) (${mb}MB)`);
		}
	} catch (err) {
		dbg(`prune-evicted failed: ${(err as Error).message}`);
	}

	return { synced, failed, errors, skipped };
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
		displayName: s.displayName,
		navStack: s.navStack,
		stateHash: s.stateHash,
		capturedAt: s.capturedAt,
		// Empty `s.image` = remote-only snap (pulled from gallery, never
		// downloaded). Pass an empty path so the view knows to fall back
		// to `remoteImageUrl`.
		imagePath: s.image ? join(outDir, s.image) : "",
		remoteImageUrl: s.remoteImageUrl,
		uploaded: s.uploaded
			? s.uploaded.ok
				? {
						ok: true,
						buildId: s.uploaded.buildId ?? "",
						uploadedAt: s.uploaded.uploadedAt,
					}
				: {
						ok: false,
						error: s.uploaded.error ?? "unknown",
						uploadedAt: s.uploaded.uploadedAt,
					}
			: undefined,
		position: s.position,
		flowId: s.flowId,
		versions: s.versions?.map((v) => ({
			imagePath: v.image ? join(outDir, v.image) : "",
			capturedAt: v.capturedAt,
			navStack: v.navStack,
		})),
		fullPage: s.fullPage,
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

// Holds an update that finished downloading, so the view can pull it via
// `getPendingUpdate` if it wasn't yet listening when the one-shot push fired.
let pendingUpdate: UpdateReadyMessage | null = null;

const rpc = BrowserView.defineRPC<ScenarioRunnerRPC>({
	maxRequestTime: 600000,
	handlers: {
		requests: {
			applyUpdate: async () => {
				try {
					// Manual API: extracts the new bundle, swaps the .app,
					// relaunches, then quit()s — on REAL success this never
					// returns (the process exits). So reaching the line after it
					// means it did NOT apply (e.g. a newer build was published
					// mid-session, so the downloaded tar no longer matches the
					// latest hash). Report that as failure so the view re-enables
					// the button instead of hanging on "Restarting…".
					await Updater.applyUpdate();
					return {
						ok: false,
						error: "Update is no longer ready — relaunch to retry.",
					};
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			getPendingUpdate: async () => ({ update: pendingUpdate }),
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
			getBridgeRoute: async ({ projectSlug }) => {
				// Lightweight pull of the connected bridge's current
				// route. Powers the topbar "Bridge sees: /foo" live
				// indicator so designers know what would be captured
				// before they click Snap. Returns null when no bridge
				// is connected for that project.
				if (snapServer.clientCount() === 0) return { ok: true, route: null };
				try {
					const resp = await snapServer.requestState({
						projectId: projectSlug,
						timeoutMs: 1500,
					});
					return {
						ok: true,
						route: resp.snapshot.route,
						stateHash: resp.snapshot.stateHash ?? "",
					};
				} catch {
					// Bridge dropped between polls or didn't reply in time —
					// non-fatal, just report null so the indicator dims.
					return { ok: true, route: null };
				}
			},
			runProjectTour: async ({ projectSlug }) => {
				// Drive a declarative tour through every declared screen for
				// this project: navigate → wait for ready → snap → repeat.
				// Returns aggregated results. Reuses snapServer's existing
				// goto/ready WS protocol via requestNavigate. Skips flows
				// without declared screens (auto-flows have no canonical
				// route list to walk).
				const orch = await ensureOrchestrator();
				if (snapServer.clientCount() === 0) {
					return {
						ok: false,
						error:
							"No snap-bridge connected. Boot your app first, then re-run the tour.",
					};
				}
				const flows = orch
					.listFlows()
					.filter(
						(f) => f.projectId === projectSlug && f.screens && f.screens.length > 0,
					);
				const visits: Array<{
					flowName: string;
					screenName: string;
					route: string;
					ok: boolean;
					error?: string;
				}> = [];
				for (const flow of flows) {
					for (const screen of flow.screens ?? []) {
						if (screen.hidden) continue;
						try {
							await snapServer.requestNavigate({
								route: screen.route,
								projectId: projectSlug,
								timeoutMs: 20000,
							});
							const snap = await orch.snap({
								projectId: projectSlug,
								mode: "auto",
								forceFlowId: flow.id,
							});
							if (!snap.ok) {
								visits.push({
									flowName: flow.name,
									screenName: screen.name,
									route: screen.route,
									ok: false,
									error: snap.error,
								});
							} else {
								visits.push({
									flowName: flow.name,
									screenName: screen.name,
									route: screen.route,
									ok: true,
								});
							}
						} catch (err) {
							visits.push({
								flowName: flow.name,
								screenName: screen.name,
								route: screen.route,
								ok: false,
								error: (err as Error).message,
							});
						}
					}
				}
				const succeeded = visits.filter((v) => v.ok).length;
				return {
					ok: true,
					total: visits.length,
					succeeded,
					failed: visits.length - succeeded,
					visits,
				};
			},
			performSnap: async ({ projectSlug, mode, forceFlowId, forceScreen }) => {
				const orch = await ensureOrchestrator();
				if (snapServer.clientCount() === 0) {
					return {
						ok: false,
						error:
							"No snap-bridge connected. Start your RN app with @unicorn-studio/snap-bridge installed.",
					};
				}
				// `projectSlug` pins the request to the bridge of the project
				// currently selected in the sidebar — necessary when multiple
				// RN apps are running at once (folleli + ovria). `mode` chooses
				// between replace-existing-slot ("auto") and force-new-card
				// ("variant"); see RPC type for details. `forceFlowId` /
				// `forceScreen` override placement when the user captures from
				// a flow or focused-screen context.
				const r = await orch.snap({
					projectId: projectSlug,
					mode: mode ?? "auto",
					forceFlowId,
					forceScreen,
				});
				if (!r.ok) return { ok: false, error: r.error };
				// Manual upload only — the user pushes when they're ready.
				return {
					ok: true,
					snap: snapToInfo(r.record, orch.outDir),
					recordKind: r.recordKind,
					placement: r.placement,
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
			reparentFlow: async ({ flowId, newParentId }) => {
				const orch = await ensureOrchestrator();
				const ok = await orch.reparentFlow(flowId, newParentId);
				return ok
					? { ok: true }
					: {
							ok: false,
							error: "Invalid reparent (cycle, missing flow, or cross-project)",
						};
			},
			renameScreen: async ({ flowId, declaredId, name }) => {
				const orch = await ensureOrchestrator();
				const ok = await orch.renameScreen(flowId, declaredId, name);
				return ok ? { ok: true } : { ok: false, error: "Screen not found" };
			},
			hideScreen: async ({ flowId, declaredId }) => {
				const orch = await ensureOrchestrator();
				const ok = await orch.hideScreen(flowId, declaredId);
				return ok ? { ok: true } : { ok: false, error: "Screen not found" };
			},
			renameSnap: async ({ sessionId, sequence, name }) => {
				const orch = await ensureOrchestrator();
				const ok = await orch.renameSnap(sessionId, sequence, name);
				return ok ? { ok: true } : { ok: false, error: "Snap not found" };
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
			deleteSnapVersion: async ({ sessionId, sequence, versionIdx }) => {
				const orch = await ensureOrchestrator();
				const outcome = await orch.deleteSnapVersion(
					sessionId,
					sequence,
					versionIdx,
				);
				if (outcome === false) {
					return {
						ok: false,
						error: `No snap with sessionId=${sessionId} sequence=${sequence} versionIdx=${versionIdx}`,
					};
				}
				return { ok: true, outcome };
			},
			pushAll: async ({ projectSlug, message }) => {
				const orch = await ensureOrchestrator();
				return pushAll(orch, projectSlug, message);
			},
			clearPushedSnaps: async ({ projectSlug }) => {
				const orch = await ensureOrchestrator();
				const r = await orch.pruneEvicted({
					force: true,
					projectId: projectSlug,
				});
				return { ok: true, deleted: r.deleted, freedBytes: r.freedBytes };
			},
			syncFromGallery: async ({ projectSlug }) => {
				const project = findProjectForBridge(projectSlug);
				const uploadUrl = project?.uploadUrl ?? process.env.SNAP_UPLOAD_URL;
				const token = project?.projectToken ?? process.env.SNAP_UPLOAD_TOKEN;
				if (!uploadUrl || !token) {
					return {
						ok: false,
						error: `No gallery target configured for "${projectSlug}".`,
					};
				}
				// Derive manifest endpoint from the upload endpoint we already
				// have on file. They live as siblings under /api/captures/.
				const manifestUrl = uploadUrl.replace(/\/upload(\?.*)?$/, "/manifest");
				try {
					const res = await fetch(manifestUrl, {
						headers: { authorization: `Bearer ${token}` },
					});
					if (!res.ok) {
						const txt = await res.text().catch(() => "");
						return {
							ok: false,
							error: `Gallery returned ${res.status}: ${txt.slice(0, 240)}`,
						};
					}
					const body = (await res.json()) as {
						app: { id: string; slug: string };
						flows: Array<{
							id: string;
							name: string;
							parentFlowId?: string;
							position?: number;
						}>;
						frames: Array<{
							id: string;
							flow_id: string;
							flow_name: string;
							frame_name: string;
							latest_image_url: string | null;
							flow_position?: number | null;
							frame_position?: number | null;
							created_at: string;
						}>;
					};
					const orch = await ensureOrchestrator();
					const result = await orch.mergeRemoteManifest({
						projectId: body.app.slug,
						flows: body.flows,
						frames: body.frames,
					});
					return {
						ok: true,
						flowsAdded: result.flowsAdded,
						flowsRemoved: result.flowsRemoved,
						framesAdded: result.framesAdded,
						framesSkipped: result.framesSkipped,
					};
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			uploadPending: async ({ force }) => {
				const orch = await ensureOrchestrator();
				// `force` re-pushes every snap regardless of its previous
				// uploaded state — useful after wiping the platform side.
				const pending = force ? orch.listAllSnaps() : orch.listPendingUploads();
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
						const errMsg =
							result?.ok === false
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
			detectRepo: async ({ repoPath }) => {
				try {
					const fingerprint = fingerprintRepo(repoPath);
					return { ok: true, fingerprint };
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			runInstaller: async ({ plan: planInput }) => {
				// Fingerprint comes over the wire; re-validate that the picked
				// rnAppDir still exists on disk before we touch anything.
				const installPlan: InstallPlan = {
					slug: planInput.slug,
					name: planInput.name,
					platform: planInput.platform,
					platformUrl: planInput.platformUrl,
					setupToken: planInput.setupToken,
					projectToken: planInput.projectToken,
					fingerprint: planInput.fingerprint as InstallPlan["fingerprint"],
					options: planInput.options,
				};
				const steps = assembleCoreSteps();
				if (planInput.options.verifyAfterInstall) {
					steps.push(buildVerifyStep(snapServer));
				}
				const outcome: InstallOutcome = await runInstaller({
					plan: installPlan,
					steps,
					send: (msg) => {
						try {
							// Pipe each step transition out to the wizard's
							// stepper UI. The proxy is typed via the `messages`
							// channel in lib/rpc.ts.
							(
								rpc.send as unknown as {
									onInitProgress: (m: typeof msg) => void;
								}
							).onInitProgress(msg);
						} catch (err) {
							dbg(`onInitProgress send failed: ${(err as Error).message}`);
						}
					},
				});
				if (outcome.ok) {
					// Refresh the projects list so the new project shows up
					// in the sidebar without a manual reload.
					try {
						loadCaptureProjects();
					} catch {}
				}
				return outcome;
			},
			improveSnapFlows: async ({ slug }) => {
				try {
					const project = findProjectForBridge(slug);
					if (!project) throw new Error(`No project "${slug}"`);
					let r: ReturnType<typeof buildImprovePrompt>;
					if (project.platform === "web") {
						// Web projects have no snap-flows.ts — the improver source
						// is the orchestrator's flow tree + the routes captured so
						// far. Walk the manifest, build a WebFlowGroup list, and
						// hand it to the web-flavor prompt builder.
						const orch = await ensureOrchestrator();
						const flows = orch.listFlows().filter((f) => f.projectId === slug);
						const allSnaps = orch
							.listAllSnaps()
							.filter((s) => s.projectId === slug);
						const routesByFlow = new Map<string, Set<string>>();
						for (const s of allSnaps) {
							const set = routesByFlow.get(s.flowId) ?? new Set<string>();
							set.add(s.route);
							routesByFlow.set(s.flowId, set);
						}
						const groups = flows.map((f) => ({
							id: f.id,
							name: f.name,
							routes: [...(routesByFlow.get(f.id) ?? [])].sort(),
						}));
						r = buildWebImprovePrompt(slug, groups);
					} else {
						r = buildImprovePrompt(slug);
					}
					try {
						Utils.clipboardWriteText(r.clipboardPayload);
					} catch (clipErr) {
						return {
							ok: false,
							error: `Built prompt but native clipboard write failed: ${(clipErr as Error).message}`,
						};
					}
					return { ok: true, ...r };
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			listProjects: async () => {
				// Sync archive status with platform on every list call. If the
				// gallery archived a project (web UI or by another desktop),
				// drop it locally so the dashboard doesn't show ghost cards.
				// Best-effort: platform unreachable → keep local list as-is.
				const local = loadCaptureProjects();
				const archivedSlugs: string[] = [];
				await Promise.all(
					local.map(async (entry) => {
						try {
							const baseUrl = entry.uploadUrl.replace(
								/\/api\/captures\/upload$/,
								"",
							);
							const statusUrl = `${baseUrl}/api/projects/${encodeURIComponent(entry.slug)}/archive`;
							const resp = await fetch(statusUrl, {
								method: "GET",
								headers: {
									authorization: `Bearer ${entry.projectToken}`,
								},
							});
							if (!resp.ok) return; // 401/403/404/network → leave entry alone
							const json = (await resp.json()) as {
								archived_at?: string | null;
							};
							if (json.archived_at) {
								archivedSlugs.push(entry.slug);
							}
						} catch {
							// silent — platform may be down, we'll catch it next poll
						}
					}),
				);
				for (const slug of archivedSlugs) {
					removeCaptureProject(slug);
				}
				return { projects: loadCaptureProjects() };
			},
			removeProject: async ({ slug }) => {
				// Capture's "Remove" button is now a soft-delete: archive the
				// project on the gallery (90-day grace) AND drop it from the
				// local registry. The user can /restore on web within the
				// grace window if they change their mind. We don't have a
				// desktop-side "undo archive" — once it's gone from the
				// dashboard, they have to go to web → archived view → restore.
				const entry = findProjectForBridge(slug);
				if (!entry) {
					// No registry entry — nothing to do remotely. Treat as
					// success so the UI's optimistic remove doesn't bounce.
					return { ok: true };
				}
				try {
					const baseUrl = entry.uploadUrl.replace(
						/\/api\/captures\/upload$/,
						"",
					);
					const archiveUrl = `${baseUrl}/api/projects/${encodeURIComponent(slug)}/archive`;
					const resp = await fetch(archiveUrl, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${entry.projectToken}`,
						},
						body: JSON.stringify({ reason: "user_initiated_desktop" }),
					});
					if (!resp.ok && resp.status !== 404) {
						// 404 = the gallery already lost track of this app;
						// treat that as fine (drop the local entry anyway).
						const text = await resp.text();
						return {
							ok: false,
							error: `Archive on platform failed (${resp.status}): ${text.slice(0, 200)}`,
						};
					}
				} catch (err) {
					return {
						ok: false,
						error: `Couldn't reach platform: ${(err as Error).message}`,
					};
				}
				const ok = removeCaptureProject(slug);
				if (!ok) return { ok: false, error: `No project with slug "${slug}"` };
				return { ok: true };
			},
			refreshProjectFlows: async ({ slug, mode }) => {
				return runSnapFlowsScanForProject(slug, mode ?? "merge");
			},
			wrapScreenForFullPage: async ({ slug, route, mode }) => {
				return runWrapScreenForProject(slug, route, mode);
			},
			runDoctor: async ({ slug }) => {
				const bridgeConnected = snapServer
					.clients()
					.some((c) => c.projectId === slug);
				const [simulator, expoDevServer] = await Promise.all([
					Promise.resolve(probeSimulatorBooted()),
					probeExpoDevServer(),
				]);
				const r = runDoctor(slug, {
					bridgeConnected,
					simulator,
					expoDevServer,
				});
				return r;
			},
			doctorAutoFix: async ({ slug, kind }) => {
				const project = findProjectForBridge(slug);
				if (!project)
					return { ok: false, error: `No project with slug "${slug}"` };
				const rnAppDir = project.rnAppDir;
				if (!rnAppDir || !existsSync(rnAppDir)) {
					return {
						ok: false,
						error: `RN app dir doesn't exist on disk: ${rnAppDir ?? "<unset>"}`,
					};
				}
				if (kind === "regenerate-flows") {
					const r = await runSnapFlowsScanForProject(slug, "regenerate");
					if (r.ok) return { ok: true, output: r.output };
					return { ok: false, error: r.error };
				}
				if (kind === "merge-flows") {
					const r = await runSnapFlowsScanForProject(slug, "merge");
					if (r.ok) return { ok: true, output: r.output };
					return { ok: false, error: r.error };
				}
				if (kind === "bump-snap-bridge") {
					return runPmCommand(project, [
						"install",
						"--save-dev",
						`github:hulusi-tunc/snap-bridge#v0.7.0`,
					]);
				}
				if (kind === "install-view-shot") {
					return runPmCommand(project, [
						"install",
						"--save-dev",
						"react-native-view-shot",
					]);
				}
				if (kind === "boot-simulator") {
					return bootSimulator();
				}
				if (kind === "launch-expo") {
					return launchExpoForProject(slug);
				}
				if (kind === "reconnect-bridge") {
					snapServer.forceReconnect();
					return {
						ok: true,
						output:
							"Closed existing bridge connections. Your app should reconnect within ~3 seconds.",
					};
				}
				return { ok: false, error: `Unknown fix: ${kind}` };
			},
			launchExpo: async ({ slug }) => launchExpoForProject(slug),
			reconnectBridge: async () => {
				snapServer.forceReconnect();
				return { ok: true };
			},
			bootSimulator: async () => bootSimulator(),
			listDevices: async () => listDevices(),
			bootDevice: async ({ udid }) => bootDevice(udid),
			deviceSnap: async ({ projectSlug, deviceUdid, displayName, forceFlowId }) => {
				// Bridge-less snap: NO clientCount gate. Captures whatever is on
				// the booted (or specified) simulator via simctl and files it
				// under the selected project — works for Flutter / native / iPad
				// and any RN app whose bridge isn't connected.
				const orch = await ensureOrchestrator();
				const r = await orch.recordDeviceSnap({
					projectId: projectSlug,
					deviceUdid,
					displayName,
					flowId: forceFlowId,
				});
				if (!r.ok) return { ok: false, error: r.error };
				return {
					ok: true,
					snap: snapToInfo(r.record, orch.outDir),
					placement: r.placement,
					captureMethod: "simctl" as const,
				};
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
			createWebProject: async (input: {
				name: string;
				slug?: string;
				baseUrl: string;
				platformUrl: string;
				setupToken: string;
				seedFlows?: Array<{ id: string; name: string; routes: string[] }>;
			}) => {
				const { name, slug, baseUrl, platformUrl, setupToken, seedFlows } =
					input;
				const slugify = (s: string): string =>
					s
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "-")
						.replace(/^-|-$/g, "")
						.slice(0, 48);
				const trimmedName = name.trim();
				const trimmedBaseUrl = baseUrl.trim();
				if (!trimmedName) return { ok: false, error: "Name is required." };
				if (!trimmedBaseUrl)
					return { ok: false, error: "Base URL is required." };
				try {
					new URL(trimmedBaseUrl);
				} catch {
					return { ok: false, error: "Base URL is not a valid URL." };
				}
				const computedSlug =
					slug?.trim() ||
					slugify(trimmedName) ||
					`web-${Date.now().toString(36).slice(-6)}`;
				if (!/^[a-z0-9][a-z0-9-]*$/.test(computedSlug)) {
					return {
						ok: false,
						error: "Slug must be lowercase kebab-case (a–z, 0–9, hyphen).",
					};
				}
				try {
					const platform = await createProjectOnPlatform({
						url: platformUrl,
						setupToken,
						slug: computedSlug,
						name: trimmedName,
						platform: "web",
					});
					const uploadUrl = `${platformUrl.replace(/\/$/, "")}/api/captures/upload`;
					registerWithCapture({
						slug: platform.slug,
						name: platform.name,
						platform: "web",
						projectToken: platform.projectToken,
						uploadUrl,
						baseUrl: trimmedBaseUrl,
						registeredAt: new Date().toISOString(),
					});
					// Seed the orchestrator with the wizard's auto-grouped
					// flows so the sidebar shows a populated tree on first
					// entry. Snaps captured later auto-match into these
					// flows by route, so the user's first snap on /sign-in
					// lands in "Auth" instead of triggering a new flow.
					let seededFlows: number | undefined;
					if (seedFlows && seedFlows.length > 0) {
						try {
							const orch = await ensureOrchestrator();
							const r = await orch.applyFlowGrouping(platform.slug, seedFlows);
							seededFlows = r.flowsApplied;
						} catch (err) {
							// Best-effort: failure here just means the project
							// starts with an empty flow tree, snaps auto-create
							// flows lazily. Surface in the response so the UI
							// can show a non-fatal warning if it cares.
							console.error(
								`createWebProject seed flows failed: ${(err as Error).message}`,
							);
						}
					}
					return {
						ok: true,
						slug: platform.slug,
						projectToken: platform.projectToken,
						restored: platform.restored,
						reused: platform.reused,
						seededFlows,
					};
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			performWebSnap: async ({ slug, url, tempImagePath, title }) => {
				const project = findProjectForBridge(slug);
				if (!project) return { ok: false, error: `No project "${slug}"` };
				try {
					const orch = await ensureOrchestrator();
					const r = await orch.recordWebSnap({
						projectId: slug,
						url,
						tempImagePath,
						title,
					});
					return {
						ok: true,
						snap: snapToInfo(r.record, orch.outDir),
						route: r.route,
						placement: r.placement,
					};
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			applyFlowGrouping: async ({ slug, groups }) => {
				const project = findProjectForBridge(slug);
				if (!project) return { ok: false, error: `No project "${slug}"` };
				try {
					const orch = await ensureOrchestrator();
					const r = await orch.applyFlowGrouping(slug, groups);
					return { ok: true, ...r };
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
			discoverWebRoutes: async ({ baseUrl, limit }) => {
				dbg(`discoverWebRoutes start: ${baseUrl} (limit=${limit ?? 50})`);
				try {
					const r = await discoverWebRoutes(baseUrl, limit ?? 50);
					dbg(
						`discoverWebRoutes done: hint=${r.hint} routes=${r.routes.length} skipped=${r.skipped}`,
					);
					return { ok: true, ...r };
				} catch (err) {
					dbg(`discoverWebRoutes failed: ${(err as Error).message}`);
					return { ok: false, error: (err as Error).message };
				}
			},
			cleanupUnsyncedProjects: async ({
				platformUrl,
				setupToken,
				platform,
				mode,
			}) => {
				try {
					const base = platformUrl.replace(/\/$/, "");
					const listUrl = platform
						? `${base}/api/projects?platform=${encodeURIComponent(platform)}`
						: `${base}/api/projects`;
					const res = await fetch(listUrl, {
						headers: { authorization: `Bearer ${setupToken}` },
					});
					if (!res.ok) {
						const txt = await res.text().catch(() => "");
						return {
							ok: false,
							error: `Gallery returned ${res.status}: ${txt.slice(0, 240)}`,
						};
					}
					const body = (await res.json()) as {
						projects: Array<{
							slug: string;
							name: string;
							platform: string;
							archived_at: string | null;
						}>;
					};
					const local = loadCaptureProjects();
					const localSlugs = new Set(local.map((p) => p.slug));
					// Skip already-archived rows — they're effectively gone from
					// the user's perspective and re-archiving is a no-op anyway.
					const galleryOnly = body.projects.filter(
						(p) => !p.archived_at && !localSlugs.has(p.slug),
					);
					if (mode === "preview") {
						return {
							ok: true,
							galleryOnly: galleryOnly.map((p) => ({
								slug: p.slug,
								name: p.name,
								platform: p.platform,
							})),
							archived: [],
							errors: [],
						};
					}
					const archived: string[] = [];
					const errors: Array<{ slug: string; error: string }> = [];
					// Archive endpoint is per-project-token authed. Since the
					// local registry doesn't have tokens for gallery-only
					// projects, we use the setup-token-authed admin route
					// pattern instead. There isn't a bulk archive endpoint —
					// it's per-slug DELETE on the [slug]/archive route via
					// per-project token. We can't archive without that token.
					//
					// Workaround: re-create the project locally first (idempotent
					// — POST /api/projects with the same slug returns the
					// existing token), then archive via that token, then remove
					// locally to keep the user's desktop clean.
					for (const p of galleryOnly) {
						try {
							// Re-fetch token via idempotent POST.
							const tokenRes = await fetch(`${base}/api/projects`, {
								method: "POST",
								headers: {
									authorization: `Bearer ${setupToken}`,
									"content-type": "application/json",
								},
								body: JSON.stringify({
									slug: p.slug,
									name: p.name,
									platform: p.platform,
								}),
							});
							if (!tokenRes.ok) {
								const txt = await tokenRes.text().catch(() => "");
								errors.push({
									slug: p.slug,
									error: `Token fetch ${tokenRes.status}: ${txt.slice(0, 120)}`,
								});
								continue;
							}
							const tokenBody = (await tokenRes.json()) as {
								projectToken: string;
							};
							const archiveRes = await fetch(
								`${base}/api/projects/${encodeURIComponent(p.slug)}/archive`,
								{
									method: "POST",
									headers: {
										authorization: `Bearer ${tokenBody.projectToken}`,
									},
								},
							);
							if (!archiveRes.ok) {
								const txt = await archiveRes.text().catch(() => "");
								errors.push({
									slug: p.slug,
									error: `Archive ${archiveRes.status}: ${txt.slice(0, 120)}`,
								});
								continue;
							}
							archived.push(p.slug);
						} catch (err) {
							errors.push({
								slug: p.slug,
								error: (err as Error).message,
							});
						}
					}
					return {
						ok: true,
						galleryOnly: galleryOnly.map((p) => ({
							slug: p.slug,
							name: p.name,
							platform: p.platform,
						})),
						archived,
						errors,
					};
				} catch (err) {
					return { ok: false, error: (err as Error).message };
				}
			},
		},
		messages: {},
	},
});

// Standard macOS menu — required for Cmd+C/V/X/Z/A keystrokes to work in inputs.
try {
	ApplicationMenu.setApplicationMenu([
		{
			label: "Unicorn Studio",
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
		title: "Unicorn Studio",
		url: "views://mainview/index.html",
		frame: { x: 0, y: 0, width: 1440, height: 900 },
		rpc,
	});
	dbg(`BrowserWindow created id=${_win?.id}`);
} catch (e: any) {
	dbg(`BrowserWindow FAILED: ${e?.stack || e}`);
}

// ── Auto-update (prompt-to-restart) ──────────────────────────────────────
// On launch only: check → download in the background → push a "ready" event
// so the view can show a non-blocking "Restart to update" banner. The actual
// apply+relaunch happens when the user clicks it (applyUpdate rpc handler).
// The Updater is a manual API — nothing self-triggers — so this is the wiring.
// Dev-gated: `electrobun dev` ships version.json {channel:"dev", baseUrl:""},
// and an unconfigured build has an empty baseUrl; both skip cleanly.
async function maybeAutoUpdate(): Promise<void> {
	try {
		const local = await Updater.getLocalInfo();
		if (local.channel === "dev" || !local.baseUrl) {
			dbg(
				`updater: skip (channel=${local.channel || "<empty>"} baseUrl=${local.baseUrl || "<empty>"})`,
			);
			return;
		}
		const info = await Updater.checkForUpdate();
		if (info.error) {
			dbg(`updater: check error: ${info.error}`);
			return;
		}
		if (!info.updateAvailable) {
			dbg("updater: up to date");
			return;
		}
		dbg(`updater: downloading ${info.hash?.slice(0, 8)}…`);
		await Updater.downloadUpdate();
		if (Updater.updateInfo()?.updateReady) {
			// Retain it so a view that wasn't listening yet can pull it via
			// getPendingUpdate; the push below is best-effort on top of that.
			pendingUpdate = { version: info.version, hash: info.hash };
			(
				rpc.send as unknown as {
					onUpdateReady: (m: UpdateReadyMessage) => void;
				}
			).onUpdateReady(pendingUpdate);
			dbg("updater: download complete — restart banner pushed");
		} else {
			dbg("updater: download did not complete (no updateReady)");
		}
	} catch (err) {
		// Never let an update check crash or block launch.
		dbg(`updater error: ${(err as Error).message}`);
	}
}
void maybeAutoUpdate();

process.on("exit", () => freeCurrentSource());
