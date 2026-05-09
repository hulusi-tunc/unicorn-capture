import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureSimulator } from "./simulator";
import type { SnapServer, SnapSnapshot } from "./snap-server";

export interface UploadInfo {
	ok: boolean;
	buildId?: string;
	error?: string;
	uploadedAt: string;
}

/**
 * A user-visible flow (a section in the gallery view). Auto-created the
 * first time we see a route, but the user can rename it, create empty
 * flows, and drag snaps between flows.
 */
/**
 * One expected screen inside a flow declaration. The view renders one
 * placeholder card per spec; matching captured snaps fill in the slot.
 */
export interface FlowScreenSpec {
	/** Stable id from the bridge declaration (slug of route by default). */
	declaredId: string;
	name: string;
	route: string;
	stateHash?: string;
}

export interface Flow {
	id: string;
	name: string;
	/**
	 * Which project (slug) this flow belongs to. Always set after migration —
	 * flows are scoped per-project so renaming "Home" in folleli doesn't
	 * touch ovria's "Home". Empty string means orphan (no snaps to infer
	 * project from); usually transient.
	 */
	projectId: string;
	/**
	 * The route that auto-spawns into this flow. New snaps from this
	 * project's bridge with this route are auto-assigned here. Undefined
	 * for user-created flows that aren't tied to any single route.
	 */
	autoRoute?: string;
	/**
	 * If set, this flow is a sub-flow rendered nested inside its parent.
	 * The parent must belong to the same project.
	 */
	parentFlowId?: string;
	/**
	 * Stable id from the bridge's snap-flows.ts declaration. Lets us
	 * upsert the same flow across re-declarations even if our internal
	 * `id` was generated. Only set on declared flows.
	 */
	declaredId?: string;
	/**
	 * Expected screens for this flow — rendered as placeholder cards
	 * until a captured snap matches their route. Only set on declared
	 * flows.
	 */
	screens?: FlowScreenSpec[];
}

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
	uploaded?: UploadInfo;
	/**
	 * User-assigned sort order within its flow. Set by drag-and-drop.
	 * Undefined = no manual order (sort by capturedAt). Lower = earlier.
	 */
	position?: number;
	/**
	 * Which flow this snap belongs to. Always set after migration — we
	 * auto-assign on capture and the user can re-assign by drag.
	 */
	flowId: string;
}

export interface SessionRecord {
	sessionId: string;
	startedAt: string;
	snaps: SnapRecord[];
}

export interface Manifest {
	version: 1;
	sessions: SessionRecord[];
	flows: Flow[];
}

export interface SnapOrchestrator {
	readonly sessionId: string;
	readonly outDir: string;
	snap(): Promise<
		| {
				ok: true;
				record: SnapRecord;
				/**
				 * Which capture path produced the image. Useful for the UI
				 * to surface why a snap is viewport-only ("bridge: <reason>").
				 */
				captureMethod: "full-page" | "simctl";
				captureNote?: string;
		  }
		| { ok: false; error: string }
	>;
	/** Snaps captured during the current session only. */
	listSnaps(): SnapRecord[];
	/** Every snap from every session in the manifest, oldest first by capturedAt. */
	listAllSnaps(): SnapRecord[];
	getSession(): SessionRecord;
	/**
	 * Mark a snap (identified by sessionId + sequence) as uploaded and persist
	 * the manifest so the status survives app restarts.
	 */
	markUploaded(
		sessionId: string,
		sequence: number,
		info: UploadInfo,
	): Promise<void>;
	/** All snaps that have not yet been successfully uploaded. */
	listPendingUploads(): SnapRecord[];
	/**
	 * Permanently delete a single snap (manifest entry + PNG on disk).
	 * Resolves with `false` if no matching snap was found.
	 */
	deleteSnap(sessionId: string, sequence: number): Promise<boolean>;
	/**
	 * Persist a user-assigned order for one flow. `ordered` is the new
	 * left-to-right ordering of (sessionId, sequence) pairs. Snaps in the
	 * flow but not in `ordered` keep their position cleared.
	 */
	reorderFlow(
		flowId: string,
		ordered: Array<{ sessionId: string; sequence: number }>,
	): Promise<void>;

	/** Snapshot of every flow, in display order. */
	listFlows(): Flow[];
	/**
	 * Create a new empty flow. `projectId` scopes the flow to one project
	 * (folleli vs ovria etc.) so renames and deletes don't bleed across.
	 * If `parentFlowId` is provided, the new flow is rendered nested
	 * inside its parent (must belong to the same project).
	 */
	createFlow(
		name: string,
		projectId: string,
		parentFlowId?: string,
	): Promise<Flow>;
	/** Rename an existing flow. Returns true if found. */
	renameFlow(flowId: string, name: string): Promise<boolean>;
	/**
	 * Re-assign one or more snaps to a different flow. Each moved snap's
	 * `position` is cleared so it appends at the end of the destination's
	 * fallback (capturedAt) order.
	 */
	moveSnapsToFlow(
		snapIds: Array<{ sessionId: string; sequence: number }>,
		toFlowId: string,
	): Promise<number>;
	/**
	 * Delete a flow. If it has snaps, they get auto-reassigned back to
	 * route-based flows (creating new ones if needed). Returns true if
	 * the flow existed and was removed.
	 */
	deleteFlow(flowId: string): Promise<boolean>;
	/**
	 * Reorder the top-level flow display order. `orderedIds` defines the
	 * new top-to-bottom sequence; flows not in the list keep their relative
	 * order at the end.
	 */
	reorderFlows(orderedIds: string[]): Promise<void>;
	/**
	 * Ingest a bridge-declared flow tree for a project. Idempotent: same
	 * declaration re-imports cleanly, preserving any user-edited names
	 * already in the manifest. New declared screens become placeholder
	 * cards; removed-from-declaration screens stay in the manifest if
	 * they already have captured snaps (so user work isn't lost).
	 */
	ingestDeclaration(
		projectId: string,
		decl: { flows: DeclaredFlowInput[] },
	): Promise<void>;
}

/**
 * Shape we accept from the snap-server's parsed bridge payload. Mirrors
 * snap-flows.ts's `FlowNode` (subset we use here).
 */
export interface DeclaredFlowInput {
	id: string;
	name?: string;
	screens?: Array<{
		id?: string;
		name?: string;
		route: string;
		stateHash?: string;
	}>;
	flows?: DeclaredFlowInput[];
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

/**
 * Match a declared screen pattern (`/booking/:id`) against an actual
 * snap route (`/booking/abc123`). Literal-equal first, then regex with
 * `:param` segments treated as `[^/]+`.
 */
function orchRouteMatches(pattern: string, actual: string): boolean {
	if (pattern === actual) return true;
	if (!pattern.includes(":")) return false;
	const re = new RegExp(
		`^${pattern
			.split("/")
			.map((seg) =>
				seg.startsWith(":")
					? "[^/]+"
					: seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
			)
			.join("/")}$`,
	);
	return re.test(actual);
}

function newFlowId(): string {
	const r = Math.random().toString(36).slice(2, 10);
	return `flow-${r}`;
}

/**
 * Resolve the longest existing route-prefix flow within the SAME project
 * that should be the parent of a new auto-flow. e.g. `/booking/payment/details`
 * finds `/booking/payment`, which itself may already be a sub-flow of
 * `/booking` — sub-flows can nest arbitrarily deep within a project.
 */
function findAutoParent(
	route: string,
	projectId: string,
	flows: readonly Flow[],
): Flow | undefined {
	if (!route || route === "/") return undefined;
	const segs = route.split("/").filter(Boolean);
	if (segs.length < 2) return undefined;
	for (let i = segs.length - 1; i >= 1; i--) {
		const prefix = `/${segs.slice(0, i).join("/")}`;
		const candidate = flows.find(
			(f) => f.autoRoute === prefix && f.projectId === projectId,
		);
		if (candidate) return candidate;
	}
	return undefined;
}

function deriveFlowName(route: string): string {
	if (!route || route === "/") return "Home";
	const trimmed = route.replace(/^\/+/, "").replace(/\/+$/, "");
	if (!trimmed) return "Home";
	// Walk the full path so /booking/payment → "Booking · Payment".
	// Skip Expo route groups like `(tabs)` and dynamic params like `[id]` /
	// `[...catchAll]` — they're plumbing, not user-facing names.
	const parts = trimmed
		.split("/")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.filter((s) => !/^\(.+\)$/.test(s))
		.filter((s) => !/^\[.+\]$/.test(s));
	if (parts.length === 0) return "Home";
	const titleCased = parts.map((p) =>
		p
			.replace(/[-_]+/g, " ")
			.replace(/\b\w/g, (c) => c.toUpperCase())
			.trim(),
	);
	return titleCased.join(" · ");
}

async function loadManifest(path: string): Promise<Manifest> {
	const empty: Manifest = { version: 1, sessions: [], flows: [] };
	if (!existsSync(path)) return empty;
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && parsed.version === 1 && Array.isArray(parsed.sessions)) {
			return {
				version: 1,
				sessions: parsed.sessions,
				flows: Array.isArray(parsed.flows) ? parsed.flows : [],
			};
		}
		return empty;
	} catch {
		return empty;
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
	// Drop empty sessions that previous app launches left behind. Keeps the
	// manifest small and avoids cluttering the UI's session count.
	const beforePrune = manifest.sessions.length;
	manifest.sessions = manifest.sessions.filter((s) => s.snaps.length > 0);
	let manifestDirty = manifest.sessions.length !== beforePrune;

	// Auto-create or fetch the flow that owns this (route, projectId) pair.
	// Each project gets its own flow tree — folleli's "Home" and ovria's
	// "Home" are separate rows even though they share `autoRoute: "/"`.
	function ensureAutoFlow(route: string, projectId: string): Flow {
		// 1. Declared flows: if any flow's `screens` contains a route that
		//    matches (literal or `:param`), the snap belongs there. This
		//    is what makes "snap → fills a declared placeholder" work.
		for (const f of manifest.flows) {
			if (f.projectId !== projectId) continue;
			if (!f.screens || f.screens.length === 0) continue;
			if (f.screens.some((s) => orchRouteMatches(s.route, route))) {
				return f;
			}
		}
		// 2. autoRoute lookup: existing auto-created flows.
		let flow = manifest.flows.find(
			(f) => f.autoRoute === route && f.projectId === projectId,
		);
		if (!flow) {
			const parent = findAutoParent(route, projectId, manifest.flows);
			flow = {
				id: newFlowId(),
				name: deriveFlowName(route),
				autoRoute: route,
				projectId,
			};
			if (parent) flow.parentFlowId = parent.id;
			manifest.flows.push(flow);
			manifestDirty = true;
		}
		return flow;
	}

	// ── Migration: scope existing flows + snaps by project ────────────
	// Old format had flow.projectId undefined, and flows were shared
	// across projects. We split shared flows so each project gets its own
	// copy with the same name + structure, then reassign snaps to the
	// project-matching copy.
	{
		// Index: flowId → set of projectIds that own at least one snap
		const flowProjects = new Map<string, Set<string>>();
		for (const s of manifest.sessions) {
			for (const r of s.snaps) {
				if (!r.flowId) continue;
				const set = flowProjects.get(r.flowId) ?? new Set<string>();
				if (r.projectId) set.add(r.projectId);
				flowProjects.set(r.flowId, set);
			}
		}

		// For each shared/old flow, decide its fate
		const splitMap = new Map<string, string>(); // `${oldId}::${projectId}` → new flowId
		const newFlows: Flow[] = [];
		for (const flow of manifest.flows) {
			if (flow.projectId) {
				// Already migrated — keep as-is.
				newFlows.push(flow);
				continue;
			}
			const projects = [...(flowProjects.get(flow.id) ?? new Set())];
			if (projects.length === 0) {
				// Orphan flow with no snaps. Drop projectId="" placeholder;
				// it'll attach to the first project that grabs its autoRoute.
				newFlows.push({ ...flow, projectId: "" });
				manifestDirty = true;
			} else if (projects.length === 1) {
				const pid = projects[0]!;
				newFlows.push({ ...flow, projectId: pid });
				splitMap.set(`${flow.id}::${pid}`, flow.id);
				manifestDirty = true;
			} else {
				// Shared across projects — split. First project keeps the
				// original id (so its UI history & comments line up); the
				// rest get fresh ids cloned from the original.
				for (let i = 0; i < projects.length; i++) {
					const pid = projects[i]!;
					const id = i === 0 ? flow.id : newFlowId();
					newFlows.push({ ...flow, id, projectId: pid });
					splitMap.set(`${flow.id}::${pid}`, id);
				}
				manifestDirty = true;
			}
		}
		manifest.flows = newFlows;

		// Reassign snap.flowId to the per-project copy.
		for (const s of manifest.sessions) {
			for (const r of s.snaps) {
				if (!r.flowId) continue;
				const newId = splitMap.get(`${r.flowId}::${r.projectId}`);
				if (newId && newId !== r.flowId) {
					r.flowId = newId;
					manifestDirty = true;
				}
			}
		}

		// Fix parentFlowId references that may still point at split flows.
		for (const f of manifest.flows) {
			if (!f.parentFlowId || !f.projectId) continue;
			const repointed = splitMap.get(`${f.parentFlowId}::${f.projectId}`);
			if (repointed && repointed !== f.parentFlowId) {
				f.parentFlowId = repointed;
				manifestDirty = true;
			}
		}
	}

	// Snaps that pre-date the flow model: assign each to its (route, projectId) flow.
	for (const s of manifest.sessions) {
		for (const r of s.snaps) {
			if (!r.flowId) {
				r.flowId = ensureAutoFlow(r.route, r.projectId).id;
				manifestDirty = true;
			}
		}
	}

	// Re-parent auto-flows by route hierarchy (per-project). Sort by
	// segment count so parents are set before children in the chain.
	const orphanAutoFlows = manifest.flows
		.filter((f) => f.autoRoute && !f.parentFlowId && f.projectId)
		.sort(
			(a, b) =>
				a.autoRoute!.split("/").filter(Boolean).length -
				b.autoRoute!.split("/").filter(Boolean).length,
		);
	for (const f of orphanAutoFlows) {
		const parent = findAutoParent(f.autoRoute!, f.projectId, manifest.flows);
		if (parent && parent.id !== f.id) {
			f.parentFlowId = parent.id;
			manifestDirty = true;
		}
	}

	if (manifestDirty) {
		await saveManifest(manifestPath, manifest);
	}
	const session: SessionRecord = {
		sessionId,
		startedAt: new Date().toISOString(),
		snaps: [],
	};
	// Don't push the empty session yet — only when its first snap lands.
	let sessionAttached = false;

	let sequence = 0;

	async function snap(): Promise<
		| {
				ok: true;
				record: SnapRecord;
				captureMethod: "full-page" | "simctl";
				captureNote?: string;
		  }
		| { ok: false; error: string }
	> {
		sequence += 1;
		const seqStr = String(sequence).padStart(3, "0");

		// Run the screenshot and the bridge state request in parallel — the
		// final filename only depends on the metadata, so we capture to a
		// temp path first and rename once both finish. Cuts perceived snap
		// latency roughly in half (simctl ~600-1200ms || ws ~50-300ms).
		const tmpAbs = join(
			outDir,
			"screenshots",
			sessionId,
			`.tmp-${seqStr}-${Date.now()}.png`,
		);

		const capPromise = captureSimulator(tmpAbs);
		const statePromise = options.server.requestState({
			timeoutMs: options.stateRequestTimeoutMs,
		});
		// Bridge-side full-page capture (react-native-view-shot). If the host
		// app registered a SnapTarget AND has the lib installed, we get the
		// full content (off-screen too); else this rejects and we fall back
		// to the simctl viewport screenshot. Runs in parallel so the cost
		// is hidden behind whichever wins.
		const fullPagePromise = options.server
			.requestFullPageCapture({ timeoutMs: 15000 })
			.then((r) => ({ ok: true as const, image: r.image }))
			.catch((err: Error) => ({ ok: false as const, error: err.message }));

		const [cap, stateResult, fullPage] = await Promise.allSettled([
			capPromise,
			statePromise,
			fullPagePromise,
		]);

		if (stateResult.status === "rejected") {
			if (cap.status === "fulfilled" && cap.value.ok) {
				try {
					await unlink(tmpAbs);
				} catch {}
			}
			sequence -= 1;
			return {
				ok: false,
				error: `metadata: ${(stateResult.reason as Error).message}`,
			};
		}
		const state = stateResult.value;

		const fullPageOk =
			fullPage.status === "fulfilled" && fullPage.value.ok === true;
		const simctlOk = cap.status === "fulfilled" && cap.value.ok === true;

		if (!fullPageOk && !simctlOk) {
			sequence -= 1;
			const err =
				cap.status === "rejected"
					? (cap.reason as Error).message
					: cap.status === "fulfilled" && !cap.value.ok
						? cap.value.error
						: "unknown";
			return { ok: false, error: `capture: ${err}` };
		}

		const stateHash = state.snapshot.stateHash ?? "default";
		const filename = `${seqStr}-${sanitize(state.snapshot.route)}-${sanitize(stateHash)}.png`;
		const imageRel = join("screenshots", sessionId, filename);
		const imageAbs = join(outDir, imageRel);

		try {
			if (fullPageOk) {
				// Decode bridge's base64 PNG and write to disk. Discard the
				// (unused) simctl temp file if we got both.
				const fpResult = (
					fullPage as PromiseFulfilledResult<{
						ok: true;
						image: string;
					}>
				).value;
				const bytes = Buffer.from(fpResult.image, "base64");
				await writeFile(imageAbs, bytes);
				if (simctlOk) {
					try {
						await unlink(tmpAbs);
					} catch {}
				}
			} else {
				await rename(tmpAbs, imageAbs);
			}
		} catch (err) {
			sequence -= 1;
			return {
				ok: false,
				error: `write: ${(err as Error).message}`,
			};
		}

		const flow = ensureAutoFlow(state.snapshot.route, state.projectId);
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
			flowId: flow.id,
		};

		session.snaps.push(record);
		if (!sessionAttached) {
			manifest.sessions.push(session);
			sessionAttached = true;
		}
		// Don't await — the manifest write is purely for crash-recovery; the
		// in-memory session is the source of truth for the running app.
		void saveManifest(manifestPath, manifest);

		// Diagnostic: tell the caller which capture path produced the PNG so
		// the UI can surface "viewport-only because bridge said X" toasts.
		const captureMethod: "full-page" | "simctl" = fullPageOk
			? "full-page"
			: "simctl";
		const captureNote =
			!fullPageOk && fullPage.status === "fulfilled" && fullPage.value.ok === false
				? fullPage.value.error
				: !fullPageOk && fullPage.status === "rejected"
					? (fullPage.reason as Error)?.message
					: undefined;
		return { ok: true, record, captureMethod, captureNote };
	}

	function listAllSnaps(): SnapRecord[] {
		const all: SnapRecord[] = [];
		for (const s of manifest.sessions) all.push(...s.snaps);
		all.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
		return all;
	}

	async function markUploaded(
		sId: string,
		seq: number,
		info: UploadInfo,
	): Promise<void> {
		for (const s of manifest.sessions) {
			if (s.sessionId !== sId) continue;
			const rec = s.snaps.find((r) => r.sequence === seq);
			if (rec) {
				rec.uploaded = info;
				await saveManifest(manifestPath, manifest);
				return;
			}
		}
	}

	function listPendingUploads(): SnapRecord[] {
		return listAllSnaps().filter((r) => !r.uploaded || !r.uploaded.ok);
	}

	async function reorderFlow(
		flowId: string,
		ordered: Array<{ sessionId: string; sequence: number }>,
	): Promise<void> {
		const orderIndex = new Map<string, number>();
		ordered.forEach((id, i) => {
			orderIndex.set(`${id.sessionId}#${id.sequence}`, i + 1);
		});
		for (const s of manifest.sessions) {
			for (const r of s.snaps) {
				if (r.flowId !== flowId) continue;
				const key = `${r.sessionId}#${r.sequence}`;
				const pos = orderIndex.get(key);
				if (pos !== undefined) {
					r.position = pos;
				} else {
					// Card wasn't in the ordered list — clear any previous
					// position so it sorts by capturedAt again.
					delete r.position;
				}
			}
		}
		await saveManifest(manifestPath, manifest);
	}

	async function createFlow(
		name: string,
		projectId: string,
		parentFlowId?: string,
	): Promise<Flow> {
		const flow: Flow = {
			id: newFlowId(),
			name: name.trim() || "Untitled flow",
			projectId,
		};
		// Only attach a parent if it exists AND is in the same project.
		if (parentFlowId) {
			const parent = manifest.flows.find((f) => f.id === parentFlowId);
			if (parent && parent.projectId === projectId) {
				flow.parentFlowId = parentFlowId;
			}
		}
		manifest.flows.push(flow);
		await saveManifest(manifestPath, manifest);
		return flow;
	}

	async function renameFlow(flowId: string, name: string): Promise<boolean> {
		const f = manifest.flows.find((x) => x.id === flowId);
		if (!f) return false;
		f.name = name.trim() || f.name;
		await saveManifest(manifestPath, manifest);
		return true;
	}

	async function moveSnapsToFlow(
		snapIds: Array<{ sessionId: string; sequence: number }>,
		toFlowId: string,
	): Promise<number> {
		const target = manifest.flows.find((f) => f.id === toFlowId);
		if (!target) return 0;
		let moved = 0;
		for (const id of snapIds) {
			for (const s of manifest.sessions) {
				if (s.sessionId !== id.sessionId) continue;
				const rec = s.snaps.find((r) => r.sequence === id.sequence);
				if (rec && rec.flowId !== toFlowId) {
					rec.flowId = toFlowId;
					// Reset position so it appends at the end of the destination
					// (and the source flow gets renumbered on its next reorder).
					delete rec.position;
					moved += 1;
				}
			}
		}
		if (moved > 0) await saveManifest(manifestPath, manifest);
		return moved;
	}

	function slugify(s: string, fallback: string): string {
		const out = s
			.replace(/[^a-zA-Z0-9_-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.toLowerCase();
		return out || fallback;
	}

	function declaredScreenId(
		raw: { id?: string; route: string },
		fallbackRoute: string,
	): string {
		if (raw.id) return raw.id;
		return slugify(raw.route, slugify(fallbackRoute, "screen"));
	}

	function declaredScreenName(raw: {
		id?: string;
		name?: string;
		route: string;
	}): string {
		if (raw.name) return raw.name;
		const segs = raw.route.split("/").filter(Boolean);
		const last = segs[segs.length - 1] ?? "Home";
		if (last.startsWith(":") && segs.length >= 2) {
			const parent = segs[segs.length - 2]!;
			return `${titleizeRoute(parent)} Detail`;
		}
		if (raw.route === "/") return "Home";
		return titleizeRoute(last);
	}

	function titleizeRoute(s: string): string {
		return s
			.replace(/^:/, "")
			.replace(/[-_]+/g, " ")
			.split(/\s+/)
			.filter(Boolean)
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ");
	}

	async function ingestDeclaration(
		projectId: string,
		decl: { flows: DeclaredFlowInput[] },
	): Promise<void> {
		if (!projectId) return;
		let dirty = false;

		// Index existing project-scoped flows by their declaredId so
		// re-declarations update in place rather than creating duplicates.
		const byDeclaredId = new Map<string, Flow>();
		for (const f of manifest.flows) {
			if (f.projectId === projectId && f.declaredId) {
				byDeclaredId.set(f.declaredId, f);
			}
		}

		const visit = (
			node: DeclaredFlowInput,
			parentInternalId: string | undefined,
		) => {
			let flow = byDeclaredId.get(node.id);
			const desiredName = node.name ?? titleizeRoute(node.id);
			if (!flow) {
				flow = {
					id: newFlowId(),
					name: desiredName,
					projectId,
					declaredId: node.id,
				};
				if (parentInternalId) flow.parentFlowId = parentInternalId;
				manifest.flows.push(flow);
				byDeclaredId.set(node.id, flow);
				dirty = true;
			} else {
				// Re-parent if declaration moved this flow under a new parent.
				if (parentInternalId && flow.parentFlowId !== parentInternalId) {
					flow.parentFlowId = parentInternalId;
					dirty = true;
				} else if (!parentInternalId && flow.parentFlowId) {
					delete flow.parentFlowId;
					dirty = true;
				}
				// Don't clobber user-edited names; only fill if the flow has
				// the auto-derived default still.
				if (!flow.name || flow.name === titleizeRoute(node.id)) {
					if (flow.name !== desiredName) {
						flow.name = desiredName;
						dirty = true;
					}
				}
			}

			// Sync screens. Match by declared screen id so user-renames stick.
			const newScreens: FlowScreenSpec[] = [];
			for (const s of node.screens ?? []) {
				if (!s.route) continue;
				const sid = declaredScreenId(s, s.route);
				const existing = (flow.screens ?? []).find(
					(x) => x.declaredId === sid,
				);
				const spec: FlowScreenSpec = {
					declaredId: sid,
					name: existing?.name ?? declaredScreenName(s),
					route: s.route,
				};
				if (s.stateHash) spec.stateHash = s.stateHash;
				newScreens.push(spec);
			}
			const before = JSON.stringify(flow.screens ?? []);
			const after = JSON.stringify(newScreens);
			if (before !== after) {
				if (newScreens.length > 0) flow.screens = newScreens;
				else delete flow.screens;
				dirty = true;
			}

			for (const child of node.flows ?? []) visit(child, flow.id);
		};

		for (const root of decl.flows) visit(root, undefined);

		if (dirty) await saveManifest(manifestPath, manifest);
	}

	async function reorderFlows(orderedIds: string[]): Promise<void> {
		const idx = new Map<string, number>();
		orderedIds.forEach((id, i) => idx.set(id, i));
		manifest.flows.sort((a, b) => {
			const ai = idx.get(a.id) ?? Number.POSITIVE_INFINITY;
			const bi = idx.get(b.id) ?? Number.POSITIVE_INFINITY;
			return ai - bi;
		});
		await saveManifest(manifestPath, manifest);
	}

	async function deleteFlow(flowId: string): Promise<boolean> {
		const idx = manifest.flows.findIndex((f) => f.id === flowId);
		if (idx === -1) return false;
		const deletedParent = manifest.flows[idx]!.parentFlowId;
		manifest.flows.splice(idx, 1);
		// Re-parent the deleted flow's direct children up one level — they
		// inherit the grandparent (or become top-level if there was none).
		// Keeps the rest of the tree intact when a middle node is removed.
		for (const f of manifest.flows) {
			if (f.parentFlowId === flowId) {
				if (deletedParent) {
					f.parentFlowId = deletedParent;
				} else {
					delete f.parentFlowId;
				}
			}
		}
		// Reassign any snaps that lived directly in this flow back to their
		// route's auto-flow so nothing falls off the grid. Scope by the
		// snap's own projectId — so a folleli snap doesn't accidentally
		// land in an ovria auto-flow with the same route.
		for (const s of manifest.sessions) {
			for (const r of s.snaps) {
				if (r.flowId === flowId) {
					r.flowId = ensureAutoFlow(r.route, r.projectId).id;
					delete r.position;
				}
			}
		}
		await saveManifest(manifestPath, manifest);
		return true;
	}

	async function deleteSnap(sId: string, seq: number): Promise<boolean> {
		for (const s of manifest.sessions) {
			if (s.sessionId !== sId) continue;
			const idx = s.snaps.findIndex((r) => r.sequence === seq);
			if (idx === -1) continue;
			const rec = s.snaps[idx]!;
			s.snaps.splice(idx, 1);
			// Drop the empty session if this was its last snap. Keeps the
			// manifest tidy + matches the lazy-attach behavior on snap.
			if (s.snaps.length === 0) {
				manifest.sessions = manifest.sessions.filter((x) => x !== s);
				if (s === session) sessionAttached = false;
			}
			try {
				await unlink(join(outDir, rec.image));
			} catch {
				// File may already be gone — ignore.
			}
			await saveManifest(manifestPath, manifest);
			return true;
		}
		return false;
	}

	return {
		sessionId,
		outDir,
		snap,
		listSnaps: () => [...session.snaps],
		listAllSnaps,
		getSession: () => session,
		markUploaded,
		listPendingUploads,
		deleteSnap,
		reorderFlow,
		listFlows: () => [...manifest.flows],
		createFlow,
		renameFlow,
		moveSnapsToFlow,
		deleteFlow,
		reorderFlows,
		ingestDeclaration,
	};
}
