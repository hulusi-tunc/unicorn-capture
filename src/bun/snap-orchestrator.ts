import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureSimulator } from "./simulator";
import type { SnapServer, SnapSnapshot } from "./snap-server";

export interface SnapRecord {
	projectId: string;
	sessionId: string;
	sequence: number;
	platform: "ios";
	route: string;
	navStack?: string[];
	stateHash: string;
	image: string;
	capturedAt: string;
}

export interface SessionRecord {
	sessionId: string;
	startedAt: string;
	snaps: SnapRecord[];
}

export interface Manifest {
	version: 1;
	sessions: SessionRecord[];
}

export interface SnapOrchestrator {
	readonly sessionId: string;
	readonly outDir: string;
	snap(): Promise<
		{ ok: true; record: SnapRecord } | { ok: false; error: string }
	>;
	listSnaps(): SnapRecord[];
	getSession(): SessionRecord;
}

export interface CreateOrchestratorOptions {
	server: SnapServer;
	outDir: string;
	stateRequestTimeoutMs?: number;
}

const SESSION_ID_PREFIX = "session";

function newSessionId(): string {
	const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
	const suffix = Math.random().toString(36).slice(2, 6);
	return `${SESSION_ID_PREFIX}-${ts}-${suffix}`;
}

function sanitize(s: string): string {
	if (s === "/" || s === "") return "home";
	return (
		s
			.replace(/[^a-zA-Z0-9_-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "home"
	);
}

async function loadManifest(path: string): Promise<Manifest> {
	if (!existsSync(path)) return { version: 1, sessions: [] };
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && parsed.version === 1 && Array.isArray(parsed.sessions)) {
			return parsed as Manifest;
		}
		return { version: 1, sessions: [] };
	} catch {
		return { version: 1, sessions: [] };
	}
}

async function saveManifest(path: string, m: Manifest): Promise<void> {
	await writeFile(path, `${JSON.stringify(m, null, 2)}\n`, "utf8");
}

/**
 * Combine snap-server (metadata source) + simctl (pixel source) + manifest
 * (local persistence). Each snap call:
 *   1. asks the connected bridge for current route + state
 *   2. captures the booted iOS Simulator screen
 *   3. appends a SnapRecord to the manifest
 *
 * One orchestrator instance == one session. New session id every time.
 */
export async function createSnapOrchestrator(
	options: CreateOrchestratorOptions,
): Promise<SnapOrchestrator> {
	const sessionId = newSessionId();
	const outDir = options.outDir;
	const manifestPath = join(outDir, "manifest.json");
	const screenshotsDir = join(outDir, "screenshots", sessionId);

	await mkdir(screenshotsDir, { recursive: true });

	const manifest = await loadManifest(manifestPath);
	const session: SessionRecord = {
		sessionId,
		startedAt: new Date().toISOString(),
		snaps: [],
	};
	manifest.sessions.push(session);
	await saveManifest(manifestPath, manifest);

	let sequence = 0;

	async function snap(): Promise<
		{ ok: true; record: SnapRecord } | { ok: false; error: string }
	> {
		sequence += 1;
		const seqStr = String(sequence).padStart(3, "0");

		let state: { projectId: string; snapshot: SnapSnapshot };
		try {
			state = await options.server.requestState({
				timeoutMs: options.stateRequestTimeoutMs,
			});
		} catch (err) {
			sequence -= 1;
			return {
				ok: false,
				error: `metadata: ${(err as Error).message}`,
			};
		}

		const stateHash = state.snapshot.stateHash ?? "default";
		const filename = `${seqStr}-${sanitize(state.snapshot.route)}-${sanitize(stateHash)}.png`;
		const imageRel = join("screenshots", sessionId, filename);
		const imageAbs = join(outDir, imageRel);

		const cap = captureSimulator(imageAbs);
		if (!cap.ok) {
			sequence -= 1;
			return { ok: false, error: `capture: ${cap.error}` };
		}

		const record: SnapRecord = {
			projectId: state.projectId,
			sessionId,
			sequence,
			platform: "ios",
			route: state.snapshot.route,
			navStack: state.snapshot.navStack,
			stateHash,
			image: imageRel,
			capturedAt: new Date().toISOString(),
		};

		session.snaps.push(record);
		await saveManifest(manifestPath, manifest);

		return { ok: true, record };
	}

	return {
		sessionId,
		outDir,
		snap,
		listSnaps: () => [...session.snaps],
		getSession: () => session,
	};
}
