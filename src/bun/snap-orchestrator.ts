import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stitchLongPageWithChrome } from "./long-page-stitch";
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
	/**
	 * User-hidden in Capture UI. The bridge keeps sending this screen in its
	 * declaration; we just suppress its placeholder card. Preserved across
	 * re-ingest so the next hello doesn't un-hide it.
	 */
	hidden?: boolean;
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
	/**
	 * Where this flow came from. Determines who owns it and who is
	 * allowed to remove it during reconciliation:
	 *   - `declared`: bridge hello declared it. `ingestDeclaration` is
	 *     the only thing allowed to remove it (when the bridge drops it
	 *     from the next declaration).
	 *   - `gallery`:  pulled from the platform via "Sync from gallery".
	 *     `mergeRemoteManifest` removes it when the next sync doesn't
	 *     include it anymore — keeps local state honest with the
	 *     server.
	 *   - `manual`:   user created it in the Capture UI. Nothing
	 *     automatic ever removes a manual flow.
	 *
	 * Optional for backwards compatibility — pre-migration manifests
	 * are loaded with `source` undefined and immediately upgraded to
	 * `manual` so the auto-pruners can't touch them.
	 */
	source?: 'declared' | 'gallery' | 'manual';
}

/**
 * One past capture of the same screen slot. Stored newest-first when
 * re-snap replaces the slot's current image with a new one. `versions[0]`
 * is the version that was current right before the latest snap.
 */
export interface SnapVersion {
	image: string;
	capturedAt: string;
	navStack?: string[];
}

export interface SnapRecord {
	projectId: string;
	sessionId: string;
	sequence: number;
	platform: "ios" | "android" | "web";
	route: string;
	/**
	 * User-assigned display name shown in the Capture card instead of the
	 * raw route. Optional — falls back to `route` when unset.
	 */
	displayName?: string;
	navStack?: string[];
	stateHash: string;
	/**
	 * Local file path (relative to outDir). Set after the bridge writes a
	 * PNG to disk. May be empty for snaps pulled from the gallery — those
	 * keep `remoteImageUrl` until the bytes are actually needed locally.
	 */
	image: string;
	/**
	 * Public Supabase Storage URL. Set on snaps pulled from the gallery
	 * (sync-from-cloud). The view layer prefers `image` (local) and falls
	 * back to this when the local file isn't on disk yet.
	 */
	remoteImageUrl?: string;
	capturedAt: string;
	uploaded?: UploadInfo;
	/**
	 * ISO timestamp after which the local PNG is eligible for deletion.
	 * Set when a successful push populates `remoteImageUrl` — the local
	 * file becomes a 7-day cache before the prune pass reclaims its
	 * disk space. Unset on snaps that have never been pushed.
	 */
	evictAt?: string;
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
	/**
	 * Past captures of this slot (same projectId + route + stateHash).
	 * Newest first. Empty/undefined when the slot has only ever been
	 * snapped once. Re-snap pushes the previous current state here.
	 */
	versions?: SnapVersion[];
	/**
	 * Web-only. True when the PNG is a full-page CDP capture (taller than
	 * the viewport, hugs document height). Library renders these in a
	 * scrollable tall-tile layout instead of the standard 16:10 thumbnail.
	 */
	fullPage?: boolean;
	/**
	 * Gallery's stable frame_id for this slot, set when the snap was
	 * pulled from the cloud (sync-from-gallery). Lets us dedupe across
	 * repeated syncs without re-importing the same frame. Local-only
	 * snaps that were captured here directly won't have this set —
	 * they get one stamped on first push.
	 */
	gallerySyncRef?: string;
	/**
	 * Optional motion clip (webm/mp4) recorded for this snap — proof of
	 * animations/interactions the still can't show. Local path relative
	 * to outDir; rides along on push and plays in the gallery's frame
	 * modal. Replaced wholesale on re-record (no version history).
	 */
	video?: string;
}

export interface SessionRecord {
	sessionId: string;
	startedAt: string;
	snaps: SnapRecord[];
	/**
	 * Stable bridge clientId that owned this session (Item 13). When a
	 * later hot-reload connects with the same clientId within
	 * SESSION_RESUME_WINDOW_MS, the orchestrator routes new snaps into
	 * this session instead of minting a new one — so the timeline view
	 * stops collecting ghost sessions on every Metro reload. Empty
	 * string / undefined for pre-Item-13 sessions.
	 */
	clientId?: string;
	/**
	 * ISO timestamp of the most recent snap added to this session.
	 * Used as the eligibility cutoff for session resumption.
	 */
	lastSeenAt?: string;
}

export interface Manifest {
	version: 1;
	sessions: SessionRecord[];
	flows: Flow[];
	/**
	 * Per-project tombstone list: declared-flow ids the user explicitly
	 * deleted in the Capture UI. `ingestDeclaration` checks this set on
	 * every bridge re-hello and skips re-creating any flow whose
	 * declaredId is listed — without this, the bridge would resurrect
	 * deleted flows on every Metro hot-reload.
	 *
	 * Keyed by projectId so two different apps can both delete a
	 * declared id like "home" without colliding. Optional for backward
	 * compat with pre-tombstone manifests; treated as empty when absent.
	 */
	deletedDeclaredIds?: Record<string, string[]>;
}

export interface SnapOrchestrator {
	readonly sessionId: string;
	readonly outDir: string;
	snap(opts?: {
		/** Pin to a specific bridge by projectId — used when multiple RN apps are connected. */
		projectId?: string;
		/**
		 * "auto" (default) — same (route, stateHash) replaces existing slot.
		 * "variant" — always create a new card; skip slot lookup.
		 */
		mode?: "auto" | "variant";
		/** Force placement into this flow regardless of route auto-grouping. */
		forceFlowId?: string;
		/** Force-replace this specific record's image, ignoring route/state. */
		forceScreen?: { sessionId: string; sequence: number };
	}): Promise<
		| {
				ok: true;
				record: SnapRecord;
				recordKind: "replaced" | "appended";
				placement: {
					flowId: string;
					flowName: string;
					screenName?: string;
					kind: "declared-match" | "auto-existing" | "auto-new";
				};
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
	 *
	 * When `opts.remoteImageUrl` is supplied, the gallery URL is stored on
	 * the snap and an `evictAt` timer (now + 7 days) is set. The next
	 * scheduled `pruneEvicted` pass will then reclaim the local PNG.
	 */
	markUploaded(
		sessionId: string,
		sequence: number,
		info: UploadInfo,
		opts?: { remoteImageUrl?: string },
	): Promise<void>;
	/**
	 * Walk all snaps and delete local PNGs whose `evictAt` has passed AND
	 * whose `remoteImageUrl` is set. Clears `snap.image` after delete so
	 * the UI falls back to the remote URL. Returns the count of files
	 * actually removed.
	 *
	 * `force=true` ignores `evictAt` (used by the "Clear pushed snaps"
	 * settings button); `projectId` scopes the prune to one project.
	 */
	pruneEvicted(opts?: {
		force?: boolean;
		projectId?: string;
	}): Promise<{ deleted: number; freedBytes: number }>;
	/** All snaps that have not yet been successfully uploaded. */
	listPendingUploads(): SnapRecord[];
	/**
	 * Permanently delete a single snap (manifest entry + PNG on disk).
	 * Resolves with `false` if no matching snap was found.
	 */
	deleteSnap(sessionId: string, sequence: number): Promise<boolean>;
	/**
	 * Delete one entry from a snap's version history without deleting the
	 * snap itself. `versionIdx` matches the lightbox: 0 = latest (current),
	 * 1+ = a past entry from versions[]. Removing the latest promotes the
	 * next-most-recent version up; removing the only remaining version
	 * deletes the entire snap.
	 */
	deleteSnapVersion(
		sessionId: string,
		sequence: number,
		versionIdx: number,
	): Promise<"deleted" | "version-removed" | "promoted" | false>;
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
	 * Re-parent a flow under a new parent (or to top-level when newParentId
	 * is undefined). Rejects cycles (newParent must not equal the flow or
	 * any of its descendants) and cross-project moves. Returns true on
	 * success.
	 */
	reparentFlow(
		flowId: string,
		newParentId: string | undefined,
	): Promise<boolean>;
	/**
	 * Rename a declared screen (placeholder card). The override sticks
	 * across bridge re-hellos because ingestDeclaration prefers the
	 * existing name when one is set.
	 */
	renameScreen(
		flowId: string,
		declaredId: string,
		name: string,
	): Promise<boolean>;
	/**
	 * Soft-delete a declared screen — hides its placeholder card. The bridge
	 * keeps declaring it; we just stop rendering. Survives re-hello.
	 */
	hideScreen(flowId: string, declaredId: string): Promise<boolean>;
	/** Rename a captured snap. Sets `displayName`; empty clears the override. */
	renameSnap(
		sessionId: string,
		sequence: number,
		name: string,
	): Promise<boolean>;
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
	 * Record a web-mode snap. Pre-captured PNG (from `captureRect` on the
	 * iframe), URL parsed into a route, auto-flow from path prefix. Mirrors
	 * the structure of mobile snaps so the rest of the orchestrator
	 * (listSnaps, push, manifest persistence) doesn't need a separate path.
	 */
	recordWebSnap(opts: {
		projectId: string;
		url: string;
		/** Either a path to a temp PNG on disk OR raw PNG bytes. One required. */
		tempImagePath?: string;
		pngBytes?: Uint8Array;
		title?: string;
		/**
		 * True when the PNG captures the full scrollable page height (CDP
		 * `captureBeyondViewport`). Used by the Library to render with a
		 * scrollable tall-thumbnail layout instead of the standard 16:10 tile.
		 */
		fullPage?: boolean;
		/**
		 * Force the snap into a specific existing flow instead of auto-deriving
		 * from the URL path. Used when the user pre-selects a flow in the
		 * extension. Falls back to auto-placement if the id doesn't resolve.
		 */
		flowId?: string;
	}): Promise<{
		record: SnapRecord;
		route: string;
		placement: {
			flowId: string;
			flowName: string;
			screenName?: string;
			kind: "auto-existing" | "auto-new";
		};
	}>;
	/**
	 * Attach a recorded motion clip (webm/mp4) to the most recent web snap
	 * matching (projectId, route-derived-from-url). The clip is written
	 * next to the snap's PNG and referenced via `SnapRecord.video`, so it
	 * rides along on the next push. When that snap ALREADY carries a clip,
	 * the still is duplicated into a fresh variant card and the new clip
	 * attaches there — a landing page with five animations becomes five
	 * cards, one clip each, instead of each recording overwriting the
	 * last. Fails when no snap exists for the route — the still is the
	 * poster, so it must be captured first (the extension auto-snaps).
	 */
	attachWebVideo(opts: {
		projectId: string;
		url: string;
		videoBytes: Uint8Array;
		mimeType: string;
	}): Promise<
		| { ok: true; record: SnapRecord; route: string }
		| { ok: false; error: string }
	>;
	/**
	 * Bridge-less capture: take a plain `simctl` screenshot of a booted
	 * simulator and append it as a frame — no snap-bridge required. This is
	 * the universal path that works for ANY app on the simulator (Flutter,
	 * native iOS, iPad, or an RN app whose bridge isn't installed/connected).
	 * Each call appends a fresh card (no slot-replace). `deviceUdid` targets a
	 * specific device; omit for the single booted one.
	 */
	recordDeviceSnap(opts: {
		projectId: string;
		deviceUdid?: string;
		/** Override the auto-generated "Screen N" name. */
		displayName?: string;
		/** Place into this flow instead of the default "Captures" bucket. */
		flowId?: string;
	}): Promise<
		| {
				ok: true;
				record: SnapRecord;
				route: string;
				placement: {
					flowId: string;
					flowName: string;
					screenName?: string;
					kind: "declared-match" | "auto-existing" | "auto-new";
				};
		  }
		| { ok: false; error: string }
	>;
	/**
	 * Apply a Claude-generated flow grouping. Each input flow gets
	 * created (or renamed if id collides with an existing project flow)
	 * and the snaps for the listed routes are moved into it. Existing
	 * project flows that aren't named in the input but still have snaps
	 * are left untouched. Used by the Improve workflow for web projects
	 * where there's no `snap-flows.ts` source of truth to rewrite.
	 */
	applyFlowGrouping(
		projectId: string,
		groups: Array<{ id: string; name: string; routes: string[] }>,
	): Promise<{ flowsApplied: number; snapsMoved: number }>;
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
	/**
	 * Pull frames + flow tree from the gallery and import them as
	 * remote-only snaps in the current session. Idempotent via
	 * `gallerySyncRef`. Used by "Sync from gallery" to restore work onto
	 * a fresh PC. The pulled snaps render straight from the Supabase URL —
	 * no PNG download — until they're re-snapped locally.
	 */
	mergeRemoteManifest(input: {
		projectId: string;
		/** The project's platform from the gallery — pulled snaps inherit it
		 * so web frames don't masquerade as iOS (wrong bezel + push platform
		 * mismatch). Defaults to "ios" for older callers. */
		platform?: "ios" | "android" | "web";
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
	}): Promise<{
		flowsAdded: number;
		flowsRemoved: number;
		framesAdded: number;
		framesSkipped: number;
	}>;
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

/**
 * Long-page (full-page) capture is paused. The wrap-screen + view-shot
 * path works in isolation but the workflow doesn't fit how designers
 * actually capture long screens — variant mode (⌘⇧V) with multiple
 * top/middle/bottom shots gives them a faster, more reliable result.
 * Flip to `true` to re-enable the bridge full-page request path;
 * `long-page-stitch.ts` + the bridge measurements protocol stay wired so
 * a future re-enable doesn't need a new migration.
 */
const LONG_PAGE_ENABLED = false;

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
	// Skip Expo route groups like `(tabs)`, file-based dynamic segments
	// (`[id]`, `[...catchAll]`), and the orchestrator's `:id` pattern
	// equivalents — they're plumbing, not user-facing names.
	const parts = trimmed
		.split("/")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.filter((s) => !/^\(.+\)$/.test(s))
		.filter((s) => !/^\[.+\]$/.test(s))
		.filter((s) => !s.startsWith(":"));
	if (parts.length === 0) return "Home";
	const titleCased = parts.map((p) =>
		p
			.replace(/[-_]+/g, " ")
			.replace(/\b\w/g, (c) => c.toUpperCase())
			.trim(),
	);
	return titleCased.join(" · ");
}

// Locale prefixes show up in routes as a 2-letter ISO code with an
// optional region suffix (en, fr, en-US, zh-Hant). Stripping them stops
// `/en/settings` and `/fr/settings` from spawning separate flow trees.
const LOCALE_SEG_RE = /^[a-z]{2}(-[a-zA-Z]{2,4})?$/;

function stripLocalePrefix(route: string): string {
	const segs = route.split("/").filter(Boolean);
	if (segs.length > 0 && LOCALE_SEG_RE.test(segs[0]!)) {
		const rest = segs.slice(1).join("/");
		return rest ? `/${rest}` : "/";
	}
	return route;
}

function niceSegmentName(s: string): string {
	return s
		.replace(/[-_]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.trim();
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
				// Tombstone map: per-project list of declared ids the
				// user deleted. Absent on legacy manifests; treat as
				// empty in that case.
				deletedDeclaredIds:
					parsed.deletedDeclaredIds && typeof parsed.deletedDeclaredIds === "object"
						? (parsed.deletedDeclaredIds as Record<string, string[]>)
						: undefined,
			};
		}
		return empty;
	} catch {
		return empty;
	}
}

async function saveManifest(path: string, m: Manifest): Promise<void> {
	// Atomic write: stage to a unique sibling tmp file, fsync via writeFile,
	// then rename into place. A crash mid-write leaves the prior manifest
	// intact; the orphaned `.tmp.*` (if any) is harmless and gets cleaned
	// up the next time saveManifest succeeds for that path.
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	try {
		await writeFile(tmp, `${JSON.stringify(m, null, 2)}\n`, "utf8");
		await rename(tmp, path);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
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

	// One-shot migration: tag every existing flow with a `source` so the
	// auto-pruners can tell apart bridge-declared / gallery-synced / user
	// flows. Anything pre-migration defaults to `manual` so we never
	// auto-delete user content we can't classify.
	for (const f of manifest.flows) {
		if (f.source) continue;
		f.source = f.declaredId ? 'declared' : 'manual';
		manifestDirty = true;
	}

	// Auto-create or fetch the flow that owns this (route, projectId) pair.
	// Each project gets its own flow tree — folleli's "Home" and ovria's
	// "Home" are separate rows even though they share `autoRoute: "/"`.
	function ensureAutoFlow(
		route: string,
		projectId: string,
		routePattern?: string,
	): Flow {
		const r = ensureAutoFlowWithPlacement(route, projectId, routePattern);
		return r.flow;
	}

	/**
	 * Same as ensureAutoFlow but also reports HOW the placement was made.
	 * Used by the snap path so the view can show "Placed in <flow> →
	 * <screen>" in the success toast — designers see at a glance whether
	 * the snap landed in a curated flow or an auto-bucket.
	 *
	 * `routePattern` — when the bridge knows the router pattern (e.g.
	 * `/reservation/:id` for an actual route of `/reservation/abc123`),
	 * it's used as the flow's stable identity instead of the concrete
	 * route. This keeps every `/reservation/<some-id>` snap inside a
	 * single flow rather than spawning one flow per id. Older bridges
	 * that don't send a pattern fall back to literal-route behavior.
	 */
	function ensureAutoFlowWithPlacement(
		route: string,
		projectId: string,
		routePattern?: string,
	): {
		flow: Flow;
		kind: "declared-match" | "auto-existing" | "auto-new";
		screenName?: string;
	} {
		// 1. Declared flows: if any flow's `screens` contains a route that
		//    matches (literal or `:param`), the snap belongs there. This
		//    is what makes "snap → fills a declared placeholder" work.
		for (const f of manifest.flows) {
			if (f.projectId !== projectId) continue;
			if (!f.screens || f.screens.length === 0) continue;
			const matchedScreen = f.screens.find((s) => orchRouteMatches(s.route, route));
			if (matchedScreen) {
				return { flow: f, kind: "declared-match", screenName: matchedScreen.name };
			}
		}
		// 2. autoRoute lookup: existing auto-created flows.
		//    Priority order:
		//      a) exact match against the routePattern (e.g. `/reservation/:id`)
		//         — the stable identity once the bridge sends patterns
		//      b) pattern match: an existing autoRoute that's itself a
		//         pattern (e.g. `/reservation/:id`) matching the incoming
		//         concrete route. Catches mixed-state manifests where some
		//         flows are pattern-keyed and the bridge happens to send a
		//         concrete route.
		//      c) legacy literal-equal fallback for old flows whose autoRoute
		//         is a concrete pathname. If we have an incoming pattern,
		//         opportunistically rebind such legacy flows to it (see
		//         comment on `migratable` below).
		const key = routePattern ?? route;
		const exact = manifest.flows.find(
			(f) => f.autoRoute === key && f.projectId === projectId,
		);
		if (exact) {
			return { flow: exact, kind: "auto-existing" };
		}
		const patternMatch = manifest.flows.find(
			(f) =>
				f.projectId === projectId &&
				!!f.autoRoute &&
				f.autoRoute.includes(":") &&
				orchRouteMatches(f.autoRoute, route),
		);
		if (patternMatch) {
			return { flow: patternMatch, kind: "auto-existing" };
		}
		// Migration: if the bridge supplied a pattern AND exactly one
		// legacy flow's literal autoRoute would fit under that pattern,
		// rebind the legacy flow to the pattern instead of creating a
		// duplicate. Single-match guard prevents accidentally collapsing
		// two intentionally-separate concrete-id flows.
		if (routePattern && routePattern !== route) {
			const candidates = manifest.flows.filter(
				(f) =>
					f.projectId === projectId &&
					!!f.autoRoute &&
					!f.autoRoute.includes(":") &&
					!f.declaredId &&
					orchRouteMatches(routePattern, f.autoRoute),
			);
			if (candidates.length === 1) {
				const migratable = candidates[0]!;
				migratable.autoRoute = routePattern;
				manifestDirty = true;
				return { flow: migratable, kind: "auto-existing" };
			}
		}
		// Walk segments to build (or find) a hierarchical flow chain. Each
		// path segment becomes its own flow level; locale prefixes are
		// stripped so /en/settings/billing and /fr/settings/billing both
		// land under one Settings → Billing tree.
		const cleaned = stripLocalePrefix(routePattern ?? route);
		const rawSegs = cleaned.split("/").filter(Boolean);
		const segs = rawSegs.filter(
			(s) => !/^\(.+\)$/.test(s) && !/^\[.+\]$/.test(s) && !s.startsWith(":"),
		);

		if (segs.length === 0) {
			const homeRoute = "/";
			const existingHome = manifest.flows.find(
				(f) => f.autoRoute === homeRoute && f.projectId === projectId,
			);
			if (existingHome) return { flow: existingHome, kind: "auto-existing" };
			const home: Flow = {
				id: newFlowId(),
				name: "Home",
				autoRoute: homeRoute,
				projectId,
				source: 'manual',
			};
			manifest.flows.push(home);
			manifestDirty = true;
			return { flow: home, kind: "auto-new" };
		}

		let parentId: string | undefined;
		let lastFlow: Flow | undefined;
		let createdAny = false;
		for (let i = 0; i < segs.length; i++) {
			const segPath = `/${segs.slice(0, i + 1).join("/")}`;
			const existing = manifest.flows.find(
				(f) => f.autoRoute === segPath && f.projectId === projectId,
			);
			if (existing) {
				parentId = existing.id;
				lastFlow = existing;
				continue;
			}
			const segFlow: Flow = {
				id: newFlowId(),
				name: niceSegmentName(segs[i]!),
				autoRoute: segPath,
				projectId,
				source: 'manual',
			};
			if (parentId) segFlow.parentFlowId = parentId;
			manifest.flows.push(segFlow);
			manifestDirty = true;
			parentId = segFlow.id;
			lastFlow = segFlow;
			createdAny = true;
		}
		return {
			flow: lastFlow!,
			kind: createdAny ? "auto-new" : "auto-existing",
		};
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

	/**
	 * Item 13: find a session worth resuming for the currently-connected
	 * bridge. Returns null when there's no clientId on file (older
	 * bridge, no bridge connected, or `force=true` was set somewhere
	 * upstream), in which case the caller falls back to the launch
	 * session. Otherwise returns the most-recent session for this
	 * (projectId, clientId) pair whose `lastSeenAt` is within the
	 * 5-minute resume window.
	 *
	 * The window is intentionally short — long enough to absorb a Metro
	 * rebuild + sim relaunch (~30s) and a coffee break (~3min), but
	 * shorter than a working day so abandoned sessions still age out
	 * cleanly.
	 */
	const SESSION_RESUME_WINDOW_MS = 5 * 60 * 1000;
	function resumeSessionForBridge(projectId: string): SessionRecord | null {
		const bridgeClientId = options.server.getClientId(projectId);
		if (!bridgeClientId) return null;
		const cutoff = Date.now() - SESSION_RESUME_WINDOW_MS;
		let best: SessionRecord | null = null;
		let bestTs = 0;
		for (const s of manifest.sessions) {
			if (s.clientId !== bridgeClientId) continue;
			// Sessions track the projects of their snaps inline — gate on
			// "at least one snap belongs to this project" so a session
			// from a different app doesn't accidentally absorb new snaps.
			if (s.snaps.length > 0 && !s.snaps.some((sn) => sn.projectId === projectId))
				continue;
			const ts = s.lastSeenAt ? Date.parse(s.lastSeenAt) : 0;
			if (ts < cutoff) continue;
			if (ts > bestTs) {
				best = s;
				bestTs = ts;
			}
		}
		if (best) return best;
		// First snap of this bridge install: tag the launch session with
		// the clientId so the NEXT hot-reload finds it.
		if (!session.clientId) session.clientId = bridgeClientId;
		return null;
	}

	let sequence = 0;

	async function snap(
		opts: {
			projectId?: string;
			mode?: "auto" | "variant";
			/** Force the resulting snap into this flow regardless of route. */
			forceFlowId?: string;
			/** Force-replace this existing record's image, ignoring route/state. */
			forceScreen?: { sessionId: string; sequence: number };
		} = {},
	): Promise<
		| {
				ok: true;
				record: SnapRecord;
				recordKind: "replaced" | "appended";
				/**
				 * Where the snap landed in the flow tree, plus how we got
				 * there. The view uses this for the "📸 Placed in <flow>
				 * → <screen>" toast so designers know at a glance whether
				 * the snap fell into a curated flow or an auto-bucket.
				 */
				placement: {
					flowId: string;
					flowName: string;
					/** Matched declared screen's display name, when applicable. */
					screenName?: string;
					kind:
						| "declared-match" /** improver-curated flow + screen match */
						| "auto-existing" /** existing auto-flow for this route */
						| "auto-new"; /** brand-new auto-flow created on this snap */
				};
				captureMethod: "full-page" | "simctl";
				captureNote?: string;
		  }
		| { ok: false; error: string }
	> {
		const mode = opts.mode ?? "auto";
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
		// `projectId` pins the request to the right bridge when multiple
		// RN apps are connected at once.
		const statePromise = options.server.requestState({
			timeoutMs: options.stateRequestTimeoutMs,
			projectId: opts.projectId,
		});
		// Long-page request gated by LONG_PAGE_ENABLED. When off we just
		// resolve with a "disabled" sentinel so the downstream branch
		// falls through to the simctl viewport path uniformly. Keeps the
		// Promise.allSettled triple intact so we don't need to fork the
		// downstream code path on the flag.
		const fullPagePromise = LONG_PAGE_ENABLED
			? options.server
					.requestFullPageCapture({ timeoutMs: 15000, projectId: opts.projectId })
					.then((r) => ({
						ok: true as const,
						image: r.image,
						measurements: r.measurements,
					}))
					.catch((err: Error) => ({ ok: false as const, error: err.message }))
			: Promise.resolve({ ok: false as const, error: "long-page disabled" });

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
				// Decode bridge's base64 PNG. If we ALSO have a simctl
				// screenshot + the bridge reported snap-target measurements,
				// stitch the simctl chrome strips (everything outside the
				// target rect) above and below the long-page content so
				// sticky chrome stays visible. Falls back to plain long-page
				// when measurements or simctl frame is missing.
				const fpResult = (
					fullPage as PromiseFulfilledResult<{
						ok: true;
						image: string;
						measurements?: {
							x: number;
							y: number;
							width: number;
							height: number;
							viewportWidth: number;
							viewportHeight: number;
							pixelRatio: number;
						};
					}>
				).value;
				const longPageBytes = Buffer.from(fpResult.image, "base64");
				let finalBytes = longPageBytes;
				if (simctlOk && fpResult.measurements) {
					try {
						const viewportBytes = await readFile(tmpAbs);
						finalBytes = await stitchLongPageWithChrome(
							viewportBytes,
							longPageBytes,
							fpResult.measurements,
						);
					} catch (err) {
						// Stitch failed (bad PNG, malformed measurements) —
						// fall through to plain long-page so the snap still
						// lands, just without chrome.
						console.error(
							`long-page chrome stitch failed: ${(err as Error).message}`,
						);
					}
				}
				await writeFile(imageAbs, finalBytes);
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

		// Re-snap detection: in "auto" mode, find an existing record at
		// the same screen slot (projectId + route + stateHash). If we
		// find one, REPLACE its current image instead of pushing a new
		// record — preserves (sessionId, sequence) identity so the
		// web-side frame_id stays stable, and keeps the user's
		// drag-and-drop placement intact. Past captures stack into
		// `versions[]` newest-first.
		//
		// In "variant" mode the user explicitly asks for a NEW record
		// at the same slot (e.g. capturing a long page in chunks or
		// comparing filter states). Skip the slot lookup so the snap
		// always becomes a fresh card.
		//
		// `forceScreen` (lightbox Re-snap): always replace that exact
		// record by (sessionId, sequence), ignoring route/state — the
		// user explicitly pointed at it. `forceFlowId` (flow-header
		// Capture): scope the slot lookup to the chosen flow only, so
		// a re-snap of the same route in this flow still de-dupes, but
		// route matches in OTHER flows don't steal the capture.
		let existing: SnapRecord | null = null;
		if (opts.forceScreen) {
			for (const s of manifest.sessions) {
				for (const r of s.snaps) {
					if (
						r.sessionId === opts.forceScreen.sessionId &&
						r.sequence === opts.forceScreen.sequence
					) {
						existing = r;
						break;
					}
				}
				if (existing) break;
			}
			if (!existing) {
				sequence -= 1;
				return {
					ok: false,
					error: `force-screen target not found (sessionId=${opts.forceScreen.sessionId} sequence=${opts.forceScreen.sequence})`,
				};
			}
		} else if (mode === "auto") {
			for (const s of manifest.sessions) {
				for (const r of s.snaps) {
					if (r.projectId !== state.projectId) continue;
					if (r.route !== state.snapshot.route) continue;
					if (r.stateHash !== stateHash) continue;
					if (opts.forceFlowId && r.flowId !== opts.forceFlowId) continue;
					existing = r;
					break;
				}
				if (existing) break;
			}
		}

		const capturedAt = new Date().toISOString();
		let record: SnapRecord;
		let recordKind: "replaced" | "appended";
		let placement: {
			flowId: string;
			flowName: string;
			screenName?: string;
			kind: "declared-match" | "auto-existing" | "auto-new";
		};
		if (existing) {
			// Push previous current to versions[] (newest first), update top.
			const versions = existing.versions ?? [];
			versions.unshift({
				image: existing.image,
				capturedAt: existing.capturedAt,
				navStack: existing.navStack,
			});
			existing.versions = versions;
			existing.image = imageRel;
			existing.capturedAt = capturedAt;
			existing.navStack = state.snapshot.navStack;
			// Drop any stale uploaded marker — the new image needs to push.
			delete existing.uploaded;
			record = existing;
			recordKind = "replaced";
			// Look up the existing flow so the toast can name it; treat
			// re-snaps as "auto-existing" since the slot was already there.
			const existingFlow = manifest.flows.find((f) => f.id === existing!.flowId);
			placement = {
				flowId: existing.flowId,
				flowName: existingFlow?.name ?? "Unknown",
				kind: "auto-existing",
			};
			// Don't roll back the sequence counter even though we didn't
			// create a new record — the rolled-back value would collide on
			// the NEXT re-snap of the same route. That collision produces
			// two manifest pointers (current image + versions[0]) at the
			// same on-disk filename; deleting either version later unlinks
			// the file the other still references, leaving the snap with a
			// dangling image path. Sequence is just an internal capture-
			// event counter; non-contiguous values are fine. Record
			// identity (sessionId, sequence) is whatever the record was
			// created with and stays untouched here.
		} else {
			// `forceFlowId` overrides auto-flow assignment — the user
			// explicitly picked the destination, so we honor it even if the
			// route would normally land elsewhere. We still look up the
			// forced flow to surface its name in the placement toast.
			let chosenFlowId: string;
			let chosenFlowName: string;
			let chosenScreenName: string | undefined;
			let chosenKind: "declared-match" | "auto-existing" | "auto-new";
			if (opts.forceFlowId) {
				const forced = manifest.flows.find((f) => f.id === opts.forceFlowId);
				if (!forced) {
					sequence -= 1;
					return {
						ok: false,
						error: `force-flow target not found (flowId=${opts.forceFlowId})`,
					};
				}
				chosenFlowId = forced.id;
				chosenFlowName = forced.name;
				chosenKind = "auto-existing";
			} else {
				const placed = ensureAutoFlowWithPlacement(
					state.snapshot.route,
					state.projectId,
					state.snapshot.routePattern,
				);
				chosenFlowId = placed.flow.id;
				chosenFlowName = placed.flow.name;
				chosenScreenName = placed.screenName;
				chosenKind = placed.kind;
			}
			// Item 13: resume an existing session when the bridge's
			// clientId matches a recent session in the manifest. Otherwise
			// fall back to the launch session (current behavior). The
			// resumed session keeps its own sessionId + sequence range so
			// keys stay unique, and `lastSeenAt` is stamped for the next
			// reconnect to detect.
			const resumed = resumeSessionForBridge(state.projectId);
			const resolvedSession = resumed ?? session;
			const resolvedSessionId = resolvedSession.sessionId;
			let resolvedSequence = sequence;
			if (resumed) {
				const maxExisting = resumed.snaps.reduce(
					(m, s) => (s.sequence > m ? s.sequence : m),
					0,
				);
				if (maxExisting >= resolvedSequence) {
					resolvedSequence = maxExisting + 1;
				}
			}
			record = {
				projectId: state.projectId,
				sessionId: resolvedSessionId,
				sequence: resolvedSequence,
				platform: "ios",
				route: state.snapshot.route,
				navStack: state.snapshot.navStack,
				stateHash,
				image: imageRel,
				capturedAt,
				flowId: chosenFlowId,
			};
			resolvedSession.snaps.push(record);
			resolvedSession.lastSeenAt = capturedAt;
			recordKind = "appended";
			placement = {
				flowId: chosenFlowId,
				flowName: chosenFlowName,
				screenName: chosenScreenName,
				kind: chosenKind,
			};
			if (resumed === null && !sessionAttached) {
				manifest.sessions.push(session);
				sessionAttached = true;
			}
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
		return {
			ok: true,
			record,
			recordKind,
			placement,
			captureMethod,
			captureNote,
		};
	}

	/**
	 * Record a snap captured from web mode (iframe → captureRect). No
	 * bridge, no simctl — caller hands us a temp PNG path; we move it
	 * into the project's session folder, auto-create a flow from the URL
	 * path's depth-1 segment (so `/dashboard/foo` and `/dashboard/bar`
	 * cluster into "Dashboard"), and append the SnapRecord. Sequence
	 * numbering, manifest persistence, and placement reporting mirror
	 * the mobile path so the UI doesn't need a separate codepath.
	 */
	async function recordWebSnap(opts: {
		projectId: string;
		url: string;
		tempImagePath?: string;
		pngBytes?: Uint8Array;
		title?: string;
		fullPage?: boolean;
		flowId?: string;
	}): Promise<{
		record: SnapRecord;
		route: string;
		placement: {
			flowId: string;
			flowName: string;
			screenName?: string;
			kind: "auto-existing" | "auto-new";
		};
	}> {
		if (!opts.tempImagePath && !opts.pngBytes) {
			throw new Error("recordWebSnap: either tempImagePath or pngBytes required");
		}
		let route = "/";
		try {
			const u = new URL(opts.url);
			route = u.pathname || "/";
		} catch {
			// Non-URL input — keep "/" as a safe fallback.
		}
		sequence += 1;
		const seqStr = String(sequence).padStart(3, "0");
		const stateHash = "default";
		const filename = `${seqStr}-${sanitize(route)}-${sanitize(stateHash)}.png`;
		const imageRel = join("screenshots", sessionId, filename);
		const imageAbs = join(outDir, imageRel);
		await mkdir(join(outDir, "screenshots", sessionId), { recursive: true });
		if (opts.pngBytes) {
			await writeFile(imageAbs, opts.pngBytes);
		} else if (opts.tempImagePath) {
			try {
				await rename(opts.tempImagePath, imageAbs);
			} catch {
				// Cross-device rename can fail — fall back to copy+unlink.
				const bytes = await readFile(opts.tempImagePath);
				await writeFile(imageAbs, bytes);
				try {
					await unlink(opts.tempImagePath);
				} catch {}
			}
		}
		// If the extension preselected a flow, look it up and use it
		// directly. Anything else falls back to URL-derived auto-placement so
		// snaps without a manual choice still land somewhere sensible.
		let placed: ReturnType<typeof ensureAutoFlowWithPlacement>;
		if (opts.flowId) {
			const target = manifest.flows.find(
				(f) => f.id === opts.flowId && f.projectId === opts.projectId,
			);
			if (target) {
				placed = {
					flow: target,
					screenName: undefined,
					kind: "auto-existing",
				};
			} else {
				placed = ensureAutoFlowWithPlacement(route, opts.projectId);
			}
		} else {
			placed = ensureAutoFlowWithPlacement(route, opts.projectId);
		}
		const capturedAt = new Date().toISOString();
		const record: SnapRecord = {
			projectId: opts.projectId,
			sessionId,
			sequence,
			platform: "web",
			route,
			stateHash,
			image: imageRel,
			capturedAt,
			flowId: placed.flow.id,
			...(opts.fullPage ? { fullPage: true } : {}),
		};
		session.snaps.push(record);
		if (!sessionAttached) {
			manifest.sessions.push(session);
			sessionAttached = true;
		}
		void saveManifest(manifestPath, manifest);
		return {
			record,
			route,
			placement: {
				flowId: placed.flow.id,
				flowName: placed.flow.name,
				screenName: placed.screenName,
				kind: placed.kind,
			},
		};
	}

	async function attachWebVideo(opts: {
		projectId: string;
		url: string;
		videoBytes: Uint8Array;
		mimeType: string;
	}): Promise<
		| { ok: true; record: SnapRecord; route: string }
		| { ok: false; error: string }
	> {
		if (opts.videoBytes.byteLength === 0) {
			return { ok: false, error: "empty video body" };
		}
		let route = "/";
		try {
			const u = new URL(opts.url);
			route = u.pathname || "/";
		} catch {
			// Non-URL input — keep "/" as a safe fallback.
		}
		// Find the newest web snap for this (project, route) across every
		// session — the clip attaches to whatever still the designer last
		// captured of this screen.
		let target: SnapRecord | null = null;
		for (const sess of manifest.sessions) {
			for (const sn of sess.snaps) {
				if (sn.projectId !== opts.projectId) continue;
				if (sn.platform !== "web") continue;
				if (sn.route !== route) continue;
				if (!target || sn.capturedAt > target.capturedAt) target = sn;
			}
		}
		if (!target) {
			return {
				ok: false,
				error: `No snap exists for ${route} yet — snap the screen first, then record.`,
			};
		}
		// The matched snap already has a clip → don't overwrite it. Duplicate
		// the still into a fresh variant card in the same flow and attach the
		// new clip there, so multiple animations on one page each keep their
		// own recording. Variant naming ("Home (2)", "Home (3)") comes from
		// the existing slot-variant logic at push time.
		if (target.video) {
			if (!target.image) {
				return {
					ok: false,
					error:
						"The matched snap is remote-only (pulled from the gallery) — re-snap the screen locally, then record.",
				};
			}
			sequence += 1;
			const seqStr = String(sequence).padStart(3, "0");
			const filename = `${seqStr}-${sanitize(route)}-${sanitize(target.stateHash || "default")}.png`;
			const imageRel = join("screenshots", sessionId, filename);
			const imageAbs = join(outDir, imageRel);
			await mkdir(join(outDir, "screenshots", sessionId), { recursive: true });
			await copyFile(join(outDir, target.image), imageAbs);
			const rec: SnapRecord = {
				projectId: target.projectId,
				sessionId,
				sequence,
				platform: "web",
				route,
				stateHash: target.stateHash || "default",
				image: imageRel,
				capturedAt: new Date().toISOString(),
				flowId: target.flowId,
				...(target.displayName ? { displayName: target.displayName } : {}),
				...(target.fullPage ? { fullPage: true } : {}),
			};
			session.snaps.push(rec);
			if (!sessionAttached) {
				manifest.sessions.push(session);
				sessionAttached = true;
			}
			target = rec;
		}
		const ext = opts.mimeType.includes("mp4") ? "mp4" : "webm";
		// Derive the clip path from the snap's PNG path so they live side
		// by side and share cleanup fate.
		const base = target.image.replace(/\.png$/i, "");
		const videoRel = `${base || `motion-${target.sequence}`}-motion.${ext}`;
		const videoAbs = join(outDir, videoRel);
		await mkdir(dirname(videoAbs), { recursive: true });
		// Re-record replaces the old clip; remove a stale one with the other
		// extension so we don't leak both a .webm and an .mp4.
		if (target.video && target.video !== videoRel) {
			await unlink(join(outDir, target.video)).catch(() => {});
		}
		await writeFile(videoAbs, opts.videoBytes);
		target.video = videoRel;
		void saveManifest(manifestPath, manifest);
		return { ok: true, record: target, route };
	}

	/**
	 * See the interface doc. Mirrors `recordWebSnap`'s no-bridge append but
	 * sources the image from `simctl` instead of a caller-supplied PNG. All
	 * device snaps land in a per-project "Captures" bucket unless `flowId`
	 * pins them elsewhere; each gets a unique frame id via `sequence`.
	 */
	async function recordDeviceSnap(opts: {
		projectId: string;
		deviceUdid?: string;
		displayName?: string;
		flowId?: string;
	}): Promise<
		| {
				ok: true;
				record: SnapRecord;
				route: string;
				placement: {
					flowId: string;
					flowName: string;
					screenName?: string;
					kind: "declared-match" | "auto-existing" | "auto-new";
				};
		  }
		| { ok: false; error: string }
	> {
		sequence += 1;
		const seqStr = String(sequence).padStart(3, "0");
		const tmpAbs = join(
			outDir,
			"screenshots",
			sessionId,
			`.tmp-${seqStr}-${Date.now()}.png`,
		);
		await mkdir(join(outDir, "screenshots", sessionId), { recursive: true });
		const cap = await captureSimulator(tmpAbs, opts.deviceUdid);
		if (!cap.ok) {
			sequence -= 1;
			return { ok: false, error: cap.error };
		}
		// No bridge → no route/state. Park every device snap under one stable
		// "/captures" slot so they cluster into a single "Captures" flow; the
		// per-snap `sequence` still yields a unique frame id on upload.
		const route = "/captures";
		const stateHash = "default";
		const filename = `${seqStr}-${sanitize(route)}-${sanitize(stateHash)}.png`;
		const imageRel = join("screenshots", sessionId, filename);
		const imageAbs = join(outDir, imageRel);
		try {
			await rename(tmpAbs, imageAbs);
		} catch {
			// Cross-device rename can fail — fall back to copy+unlink.
			const bytes = await readFile(tmpAbs);
			await writeFile(imageAbs, bytes);
			try {
				await unlink(tmpAbs);
			} catch {}
		}
		// Explicit flow when the caller pinned one (and it exists for this
		// project), else the auto-derived "Captures" bucket.
		let placed: ReturnType<typeof ensureAutoFlowWithPlacement>;
		if (opts.flowId) {
			const target = manifest.flows.find(
				(f) => f.id === opts.flowId && f.projectId === opts.projectId,
			);
			placed = target
				? { flow: target, screenName: undefined, kind: "auto-existing" }
				: ensureAutoFlowWithPlacement(route, opts.projectId);
		} else {
			placed = ensureAutoFlowWithPlacement(route, opts.projectId);
		}
		// Auto-name "Screen N" from the count already parked in this flow for
		// this project, so the gallery shows Screen 1, Screen 2, … in order.
		let displayName = opts.displayName?.trim();
		if (!displayName) {
			const priorInFlow = listAllSnaps().filter(
				(s) => s.projectId === opts.projectId && s.flowId === placed.flow.id,
			).length;
			displayName = `Screen ${priorInFlow + 1}`;
		}
		const capturedAt = new Date().toISOString();
		const record: SnapRecord = {
			projectId: opts.projectId,
			sessionId,
			sequence,
			platform: "ios",
			route,
			stateHash,
			image: imageRel,
			capturedAt,
			flowId: placed.flow.id,
			displayName,
		};
		session.snaps.push(record);
		if (!sessionAttached) {
			manifest.sessions.push(session);
			sessionAttached = true;
		}
		void saveManifest(manifestPath, manifest);
		return {
			ok: true,
			record,
			route,
			placement: {
				flowId: placed.flow.id,
				flowName: placed.flow.name,
				screenName: placed.screenName,
				kind: placed.kind,
			},
		};
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
		opts?: { remoteImageUrl?: string },
	): Promise<void> {
		for (const s of manifest.sessions) {
			if (s.sessionId !== sId) continue;
			const rec = s.snaps.find((r) => r.sequence === seq);
			if (rec) {
				rec.uploaded = info;
				if (info.ok && opts?.remoteImageUrl) {
					rec.remoteImageUrl = opts.remoteImageUrl;
					// 7-day grace window: covers the typical "did the push
					// actually work?" verification period without filling
					// disk indefinitely. After this, pruneEvicted reclaims.
					const evictMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
					rec.evictAt = new Date(evictMs).toISOString();
				}
				await saveManifest(manifestPath, manifest);
				return;
			}
		}
	}

	async function pruneEvicted(opts?: {
		force?: boolean;
		projectId?: string;
	}): Promise<{ deleted: number; freedBytes: number }> {
		const now = Date.now();
		let deleted = 0;
		let freedBytes = 0;
		let dirty = false;
		for (const s of manifest.sessions) {
			for (const rec of s.snaps) {
				if (opts?.projectId && rec.projectId !== opts.projectId) continue;
				// Require a remote URL — without one, deleting locally
				// would orphan the card.
				if (!rec.remoteImageUrl) continue;
				if (!rec.image) continue;
				const expired = rec.evictAt
					? Date.parse(rec.evictAt) <= now
					: false;
				if (!opts?.force && !expired) continue;
				const abs = join(outDir, rec.image);
				try {
					const st = await stat(abs).catch(() => null);
					if (st) freedBytes += st.size;
					await unlink(abs);
				} catch (err) {
					// File already gone or permission issue — log and
					// proceed so a single bad entry doesn't stall the
					// rest of the prune.
					console.warn(
						`pruneEvicted: ${rec.image} — ${(err as Error).message}`,
					);
				}
				rec.image = "";
				delete rec.evictAt;
				dirty = true;
				deleted += 1;
			}
		}
		if (dirty) await saveManifest(manifestPath, manifest);
		return { deleted, freedBytes };
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
			source: 'manual',
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

	async function reparentFlow(
		flowId: string,
		newParentId: string | undefined,
	): Promise<boolean> {
		const idx = manifest.flows.findIndex((x) => x.id === flowId);
		if (idx === -1) return false;
		const flow = manifest.flows[idx]!;
		const currentParent = flow.parentFlowId;
		const desiredParent = newParentId || undefined;
		if ((currentParent ?? undefined) === desiredParent) return true;
		if (desiredParent) {
			if (desiredParent === flowId) return false;
			const parent = manifest.flows.find((x) => x.id === desiredParent);
			if (!parent) return false;
			if (parent.projectId !== flow.projectId) return false;
			// Cycle guard — walk up from the candidate parent; if we hit
			// `flowId` it would create a loop.
			let cursor: string | undefined = parent.parentFlowId;
			while (cursor) {
				if (cursor === flowId) return false;
				const next: Flow | undefined = manifest.flows.find(
					(x) => x.id === cursor,
				);
				cursor = next?.parentFlowId;
			}
			flow.parentFlowId = desiredParent;
		} else {
			delete flow.parentFlowId;
		}
		// Move to the end of the flat list so it lands as the last sibling
		// under its new parent (render groups by parentFlowId in flat order).
		manifest.flows.splice(idx, 1);
		manifest.flows.push(flow);
		await saveManifest(manifestPath, manifest);
		return true;
	}

	async function renameScreen(
		flowId: string,
		declaredId: string,
		name: string,
	): Promise<boolean> {
		const f = manifest.flows.find((x) => x.id === flowId);
		if (!f || !f.screens) return false;
		const s = f.screens.find((x) => x.declaredId === declaredId);
		if (!s) return false;
		const trimmed = name.trim();
		if (!trimmed) return false;
		s.name = trimmed;
		await saveManifest(manifestPath, manifest);
		return true;
	}

	async function hideScreen(
		flowId: string,
		declaredId: string,
	): Promise<boolean> {
		const f = manifest.flows.find((x) => x.id === flowId);
		if (!f || !f.screens) return false;
		const s = f.screens.find((x) => x.declaredId === declaredId);
		if (!s) return false;
		if (s.hidden) return true;
		s.hidden = true;
		await saveManifest(manifestPath, manifest);
		return true;
	}

	async function renameSnap(
		sessionId: string,
		sequence: number,
		name: string,
	): Promise<boolean> {
		const session = manifest.sessions.find((s) => s.sessionId === sessionId);
		if (!session) return false;
		const rec = session.snaps.find((r) => r.sequence === sequence);
		if (!rec) return false;
		const trimmed = name.trim();
		if (trimmed) rec.displayName = trimmed;
		else delete rec.displayName;
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

		// Track every declaredId in the incoming declaration so we can prune
		// flows that were removed in this re-declaration (e.g. heuristic
		// "Trade" / "Splash" / "Role" flows after the user collapses them
		// into a "worker-onboarding" sub-flow). Without this, stale flows
		// linger forever and clutter the sidebar.
		const declaredIdsInNewDecl = new Set<string>();
		const collectIds = (node: DeclaredFlowInput) => {
			declaredIdsInNewDecl.add(node.id);
			for (const child of node.flows ?? []) collectIds(child);
		};
		for (const root of decl.flows) collectIds(root);

		// Tombstones: declared ids the user explicitly deleted in the
		// Capture UI. We skip re-creating these on re-ingest so deletes
		// stick across hot-reloads.
		const tombstoned = new Set(
			manifest.deletedDeclaredIds?.[projectId] ?? [],
		);

		const visit = (
			node: DeclaredFlowInput,
			parentInternalId: string | undefined,
		) => {
			if (tombstoned.has(node.id)) {
				// Still recurse into children — a user might have deleted
				// the parent grouping but want its sub-flows preserved as
				// top-level. Children get re-parented to undefined since
				// the parent flow no longer exists.
				for (const child of node.flows ?? []) visit(child, undefined);
				return;
			}
			let flow = byDeclaredId.get(node.id);
			const desiredName = node.name ?? titleizeRoute(node.id);
			if (!flow) {
				flow = {
					id: newFlowId(),
					name: desiredName,
					projectId,
					declaredId: node.id,
					source: 'declared',
				};
				if (parentInternalId) flow.parentFlowId = parentInternalId;
				manifest.flows.push(flow);
				byDeclaredId.set(node.id, flow);
				dirty = true;
			} else {
				// DO NOT re-parent on re-ingest. The bridge re-sends its
				// declaration on every Metro hot-reload — if we re-applied
				// `parentFlowId` each time, any reorganization the user did
				// in the Capture UI (drag a flow under another, move it back
				// to the top level, etc.) would get clobbered seconds after
				// they made the change. Parent assignment is now a one-time
				// thing set at creation; the user owns the structure
				// afterward.
				//
				// Don't clobber user-edited names either — only fill if the
				// flow still has the auto-derived default.
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
				if (existing?.hidden) spec.hidden = true;
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

		// Prune flows that came from a previous declaration but are absent
		// from the new one. Re-route any snaps inside them back to their
		// route's auto-flow (mirrors deleteFlow's re-parent logic) so we
		// never lose user data — only the empty container disappears.
		const stale = manifest.flows.filter(
			(f) =>
				f.projectId === projectId &&
				f.declaredId &&
				!declaredIdsInNewDecl.has(f.declaredId),
		);
		if (stale.length > 0) {
			const staleIds = new Set(stale.map((f) => f.id));
			for (const session of manifest.sessions) {
				for (const snap of session.snaps) {
					if (staleIds.has(snap.flowId)) {
						snap.flowId = ensureAutoFlow(snap.route, snap.projectId).id;
					}
				}
			}
			// Re-parent any non-stale children whose parent is being removed —
			// they bubble up to the deleted flow's parent (or top level).
			for (const f of manifest.flows) {
				if (f.parentFlowId && staleIds.has(f.parentFlowId)) {
					const deletedParent = stale.find(
						(s) => s.id === f.parentFlowId,
					)?.parentFlowId;
					if (deletedParent) f.parentFlowId = deletedParent;
					else delete f.parentFlowId;
				}
			}
			manifest.flows = manifest.flows.filter((f) => !staleIds.has(f.id));
			dirty = true;
		}

		if (dirty) await saveManifest(manifestPath, manifest);
	}

	/**
	 * Bulk apply a Claude-suggested grouping to a project. Idempotent:
	 * re-applying the same grouping leaves the manifest untouched.
	 *   1. Match input flows to existing project flows by id, falling
	 *      back to name (case-insensitive). Rename existing matches.
	 *   2. Create new flows for inputs with no existing match.
	 *   3. For each route in an input flow, move every project snap on
	 *      that route into that flow.
	 *   4. Existing flows not in the input keep their snaps + identity
	 *      — we don't delete them. The "Apply" UI shows the delta so
	 *      the user can manually delete leftovers if they want.
	 *
	 * Returns how many flows were touched + how many snaps relocated.
	 */
	async function applyFlowGrouping(
		projectId: string,
		groups: Array<{ id: string; name: string; routes: string[] }>,
	): Promise<{ flowsApplied: number; snapsMoved: number }> {
		let flowsApplied = 0;
		let snapsMoved = 0;
		const existingProjectFlows = manifest.flows.filter(
			(f) => f.projectId === projectId,
		);
		for (const g of groups) {
			const inputId = g.id?.trim();
			const inputName = g.name?.trim();
			if (!inputName) continue;
			// Resolve to an existing flow: prefer id match, fall back to
			// case-insensitive name match. New flow on miss.
			let flow =
				existingProjectFlows.find((f) => inputId && f.id === inputId) ??
				existingProjectFlows.find(
					(f) => f.name.toLowerCase() === inputName.toLowerCase(),
				);
			if (!flow) {
				flow = {
					id: inputId || autoFlowIdFromName(inputName),
					name: inputName,
					projectId,
					source: 'manual',
				};
				manifest.flows.push(flow);
				existingProjectFlows.push(flow);
			} else if (flow.name !== inputName) {
				flow.name = inputName;
			}
			flowsApplied += 1;
			// Move snaps. Match by exact route — Claude is asked to keep
			// route strings verbatim so equality compare is safe.
			const wantedRoutes = new Set(g.routes ?? []);
			if (wantedRoutes.size === 0) continue;
			for (const sess of manifest.sessions) {
				for (const snap of sess.snaps) {
					if (snap.projectId !== projectId) continue;
					if (!wantedRoutes.has(snap.route)) continue;
					if (snap.flowId === flow.id) continue;
					snap.flowId = flow.id;
					snapsMoved += 1;
				}
			}
		}
		await saveManifest(manifestPath, manifest);
		return { flowsApplied, snapsMoved };
	}

	function autoFlowIdFromName(name: string): string {
		const base = name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 32);
		// Suffix with timestamp to avoid colliding with a different
		// project's flow that happens to share the slug.
		return base ? `${base}-${Date.now().toString(36).slice(-4)}` : `flow-${Date.now().toString(36)}`;
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
		const target = manifest.flows[idx]!;
		const deletedParent = target.parentFlowId;
		// Tombstone declared flows so the next bridge re-hello doesn't
		// resurrect them. Manual + auto flows have no declaredId and
		// don't need tombstoning — they're not re-created from the
		// declaration on re-ingest.
		if (target.declaredId && target.projectId) {
			const map = manifest.deletedDeclaredIds ?? {};
			const list = map[target.projectId] ?? [];
			if (!list.includes(target.declaredId)) {
				list.push(target.declaredId);
			}
			map[target.projectId] = list;
			manifest.deletedDeclaredIds = map;
		}
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
		// Send orphaned snaps to the synthetic "Unassigned" bucket the UI
		// renders for flowId-less records — DO NOT route them back through
		// ensureAutoFlow, which would create a new flow with the same
		// route/name as what we just deleted (so the user sees their
		// deleted flow "come back" with their snaps intact). The user can
		// drag snaps to a real flow afterward or delete them individually.
		for (const s of manifest.sessions) {
			for (const r of s.snaps) {
				if (r.flowId === flowId) {
					r.flowId = "__unassigned__";
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
			// Delete the latest image AND every archived version. Each
			// version has its own PNG on disk (from the moment it was the
			// "latest" before being pushed into versions[]). The motion clip
			// (if recorded) shares the snap's fate too.
			const paths = [rec.image, ...(rec.versions ?? []).map((v) => v.image)];
			if (rec.video) paths.push(rec.video);
			for (const p of paths) {
				try {
					await unlink(join(outDir, p));
				} catch {}
			}
			await saveManifest(manifestPath, manifest);
			return true;
		}
		return false;
	}

	/**
	 * Delete a single past version of a snap without deleting the snap itself.
	 * `versionIdx` follows the lightbox convention:
	 *   0   = the current/latest image. Removing this promotes versions[0]
	 *         to current; if versions[] was empty, the entire snap is deleted.
	 *   1+  = an entry in versions[] (versionIdx - 1). The PNG is unlinked
	 *         and the slot is removed from the array.
	 *
	 * Returns "deleted" when the whole snap was removed (last version gone),
	 * "version-removed" when only one entry was pruned, "promoted" when the
	 * latest was deleted and a previous version took its place, or false
	 * when the snap couldn't be located.
	 */
	async function deleteSnapVersion(
		sId: string,
		seq: number,
		versionIdx: number,
	): Promise<"deleted" | "version-removed" | "promoted" | false> {
		for (const s of manifest.sessions) {
			if (s.sessionId !== sId) continue;
			const rec = s.snaps.find((r) => r.sequence === seq);
			if (!rec) continue;
			const versions = rec.versions ?? [];
			if (versionIdx === 0) {
				// Removing current. If we have a prior version, promote it.
				if (versions.length === 0) {
					// Last version standing — delete the whole snap.
					return (await deleteSnap(sId, seq)) ? "deleted" : false;
				}
				try {
					await unlink(join(outDir, rec.image));
				} catch {}
				const promoted = versions.shift()!;
				rec.image = promoted.image;
				rec.capturedAt = promoted.capturedAt;
				rec.navStack = promoted.navStack;
				delete rec.uploaded;
				if (versions.length === 0) delete rec.versions;
				else rec.versions = versions;
				await saveManifest(manifestPath, manifest);
				return "promoted";
			}
			const arrayIdx = versionIdx - 1;
			if (arrayIdx < 0 || arrayIdx >= versions.length) return false;
			const removed = versions.splice(arrayIdx, 1)[0]!;
			try {
				await unlink(join(outDir, removed.image));
			} catch {}
			if (versions.length === 0) delete rec.versions;
			else rec.versions = versions;
			await saveManifest(manifestPath, manifest);
			return "version-removed";
		}
		return false;
	}

	/**
	 * Pull frames + flow tree from the gallery and import them as
	 * remote-only snaps in the current session. Used by "Sync from gallery"
	 * to bring snaps onto a fresh PC (or after a disk loss).
	 *
	 * Idempotent via `gallerySyncRef` — re-running adds only new frames.
	 *
	 * Limitation: pulled snaps don't have route/stateHash (the gallery
	 * doesn't store them — only the synthesized frame_id). They render
	 * fine in the dashboard but a fresh `Snap` won't auto-replace them
	 * since the bridge matches on (route, stateHash). Treat this as a
	 * VIEW-ONLY restore of past work.
	 */
	async function mergeRemoteManifest(input: {
		projectId: string;
		platform?: "ios" | "android" | "web";
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
	}): Promise<{
		flowsAdded: number;
		flowsRemoved: number;
		framesAdded: number;
		framesSkipped: number;
	}> {
		let flowsAdded = 0;
		let flowsRemoved = 0;
		let framesAdded = 0;
		let framesSkipped = 0;

		// Track which flow ids the gallery just told us are current. We use
		// this set both to skip dup inserts and to drive the reconcile-prune
		// below — any local `source: 'gallery'` flow on this project that
		// isn't in this set is stale and gets removed.
		const incomingFlowIds = new Set(input.flows.map((f) => f.id));

		// Add any flows we don't already have (match by id). Flows we
		// already have but pulled from the gallery before get their
		// metadata refreshed (name/parent) so renames on the server
		// propagate down.
		const existingByIdForProject = new Map<string, Flow>();
		for (const f of manifest.flows) {
			if (f.projectId === input.projectId) {
				existingByIdForProject.set(f.id, f);
			}
		}
		for (const rf of input.flows) {
			const existing = existingByIdForProject.get(rf.id);
			if (!existing) {
				manifest.flows.push({
					id: rf.id,
					name: rf.name,
					projectId: input.projectId,
					parentFlowId: rf.parentFlowId,
					source: 'gallery',
				});
				flowsAdded += 1;
			} else if (existing.source === 'gallery') {
				// Refresh gallery-owned metadata. Don't clobber bridge-
				// declared or user-created flows that happen to share an id.
				if (existing.name !== rf.name) existing.name = rf.name;
				if ((existing.parentFlowId ?? undefined) !== (rf.parentFlowId ?? undefined)) {
					if (rf.parentFlowId) existing.parentFlowId = rf.parentFlowId;
					else delete existing.parentFlowId;
				}
			}
		}

		// Reconcile-prune. Any `source: 'gallery'` flow on this project that
		// wasn't in the incoming response is stale and gets removed. This
		// is the self-healing step: even if the gallery once served garbage
		// (or this device imported it before a server bug was fixed), the
		// next clean sync drops the stale flows automatically. We never
		// touch `source: 'declared'` (owned by the bridge) or
		// `source: 'manual'` (owned by the user).
		const staleGalleryFlowIds: string[] = [];
		for (const f of manifest.flows) {
			if (f.projectId !== input.projectId) continue;
			if (f.source !== 'gallery') continue;
			if (incomingFlowIds.has(f.id)) continue;
			staleGalleryFlowIds.push(f.id);
		}
		if (staleGalleryFlowIds.length > 0) {
			const stale = new Set(staleGalleryFlowIds);
			// Re-parent any non-stale children whose parent is being removed,
			// matching the same rule ingestDeclaration uses: bubble up to the
			// deleted flow's parent (or top level).
			const deletedParentOf = new Map<string, string | undefined>();
			for (const f of manifest.flows) {
				if (stale.has(f.id)) deletedParentOf.set(f.id, f.parentFlowId);
			}
			for (const f of manifest.flows) {
				if (f.parentFlowId && stale.has(f.parentFlowId)) {
					const grandparent = deletedParentOf.get(f.parentFlowId);
					if (grandparent) f.parentFlowId = grandparent;
					else delete f.parentFlowId;
				}
			}
			// Reassign snaps whose flow is going away to the project's
			// auto-bucket so the snap rows themselves survive the prune.
			for (const sess of manifest.sessions) {
				for (const sn of sess.snaps) {
					if (stale.has(sn.flowId)) {
						sn.flowId = ensureAutoFlow(sn.route, sn.projectId).id;
					}
				}
			}
			manifest.flows = manifest.flows.filter((f) => !stale.has(f.id));
			flowsRemoved = staleGalleryFlowIds.length;
		}

		// Track frames we've already synced (by gallerySyncRef) to skip dups.
		// Scan EVERY session, not just the current one — each app launch
		// starts a fresh session, so a current-session-only scan re-imported
		// the full gallery on every restart+sync and duplicated everything.
		const importedRefs = new Set<string>();
		for (const sess of manifest.sessions) {
			for (const sn of sess.snaps) {
				if (sn.projectId !== input.projectId) continue;
				if (sn.gallerySyncRef) importedRefs.add(sn.gallerySyncRef);
			}
		}
		for (const sn of session.snaps) {
			if (sn.gallerySyncRef) importedRefs.add(sn.gallerySyncRef);
		}

		// Sequence assignment: keep going from wherever the session left off.
		let nextSeq = session.snaps.length;

		for (const rfr of input.frames) {
			if (!rfr.latest_image_url) {
				framesSkipped += 1;
				continue;
			}
			if (importedRefs.has(rfr.id)) {
				framesSkipped += 1;
				continue;
			}
			const rec: SnapRecord = {
				projectId: input.projectId,
				sessionId,
				sequence: nextSeq++,
				platform: input.platform ?? "ios",
				route: "",
				stateHash: "",
				image: "",
				remoteImageUrl: rfr.latest_image_url,
				capturedAt: rfr.created_at,
				flowId: rfr.flow_id,
				gallerySyncRef: rfr.id,
				position: rfr.frame_position ?? undefined,
				// Without this, a pushed re-ref would rename the gallery frame
				// to the route-derived fallback ("Home") — keep the real name.
				...(rfr.frame_name ? { displayName: rfr.frame_name } : {}),
			};
			session.snaps.push(rec);
			// Lazy-attach the current session exactly like recordWebSnap does.
			// Without this, a sync in a fresh app run (no local snap yet)
			// imports into an orphan session object that never serializes —
			// flows persist but every pulled frame silently vanishes on save.
			if (!sessionAttached) {
				manifest.sessions.push(session);
				sessionAttached = true;
			}
			importedRefs.add(rfr.id);
			framesAdded += 1;
		}

		await saveManifest(manifestPath, manifest);
		return { flowsAdded, flowsRemoved, framesAdded, framesSkipped };
	}

	return {
		sessionId,
		outDir,
		snap,
		listSnaps: () => [...session.snaps],
		listAllSnaps,
		getSession: () => session,
		markUploaded,
		pruneEvicted,
		listPendingUploads,
		deleteSnap,
		deleteSnapVersion,
		reorderFlow,
		listFlows: () => [...manifest.flows],
		createFlow,
		renameFlow,
		reparentFlow,
		renameScreen,
		hideScreen,
		renameSnap,
		moveSnapsToFlow,
		deleteFlow,
		reorderFlows,
		recordWebSnap,
		attachWebVideo,
		recordDeviceSnap,
		applyFlowGrouping,
		ingestDeclaration,
		mergeRemoteManifest,
	};
}
