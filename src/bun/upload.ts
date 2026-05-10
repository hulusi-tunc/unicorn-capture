import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Flow, SessionRecord, SnapRecord } from "./snap-orchestrator";

/**
 * Shape the gallery platform's intake endpoint expects. Each user-facing
 * flow becomes its own row; sub-flows carry their `parentFlowId` so the
 * platform can render the same parent/child tree as capture.
 */
export interface PlatformManifest {
	projectId: string;
	buildSha: string;
	capturedAt: string;
	platform: "ios" | "android" | "web";
	/** Optional human note shown in the version history (e.g. "Booking flow added"). */
	message?: string;
	flows: Array<{
		id: string;
		name: string;
		parentFlowId?: string;
		autoRoute?: string;
		/** Index of this flow among siblings (display order). */
		position?: number;
		frames: Array<{
			id: string;
			name: string;
			image: string;
			/** Index of this frame within its flow (display order). */
			position?: number;
			/**
			 * Past captures of this same frame slot, captured before the
			 * latest one (newest first). Mirrors Capture's `versions[]`
			 * array — designer re-snapped this screen multiple times and
			 * the platform should let viewers scrub through history.
			 * Empty/undefined for frames that have only ever been snapped
			 * once.
			 */
			versions?: Array<{
				image: string;
				capturedAt: string;
			}>;
		}>;
	}>;
}

export interface UploadOptions {
	/** e.g. http://localhost:3010/api/captures/upload */
	url: string;
	/** Bearer project token (pgt_xxx). */
	token: string;
	/** Local out dir; image paths in the manifest are relative to this. */
	outDir: string;
	session: SessionRecord;
	/**
	 * The full list of flows from the orchestrator's manifest. Used to
	 * resolve each snap's flowId into a flow with name + parentFlowId
	 * for the upload payload. Pass an empty array to fall back to the
	 * legacy "All screens" bundling.
	 */
	flows: readonly Flow[];
	/**
	 * EVERY snap from every session — used to compute each frame's
	 * display position WITHIN ITS FLOW. Without this, single-snap uploads
	 * would always claim position=0 and the web view wouldn't reflect
	 * the user's drag-reorder. Pass `orch.listAllSnaps()`.
	 */
	allSnaps: readonly SnapRecord[];
	/**
	 * When true, this upload represents the COMPLETE current state — the
	 * server wipes existing frames + builds for this app before inserting.
	 * For chunked uploads, replace=true is set only on the FIRST batch;
	 * later batches must append (not wipe again).
	 */
	replace?: boolean;
	/** Optional commit-message-style note saved as builds.message. */
	message?: string;
	log?: (msg: string) => void;
}

export type UploadResult =
	| { ok: true; framesCount: number; buildId: string; appSlug: string }
	| { ok: false; error: string };

interface MultipartPart {
	name: string;
	filename: string;
	contentType: string;
	bytes: Uint8Array;
}

/**
 * Build a multipart/form-data body manually. We bypass `FormData + fetch`
 * because Bun's serialization produced a body Next.js's `request.formData()`
 * couldn't parse — same payload via curl works fine, so the issue is in the
 * envelope, not the consumer. Hand-rolling 40 LoC is more reliable than
 * debugging Bun internals.
 */
function encodeMultipart(parts: MultipartPart[]): {
	body: Uint8Array;
	contentType: string;
} {
	const boundary = `----UnicornCapture${crypto.randomUUID().replace(/-/g, "")}`;
	const enc = new TextEncoder();
	const CRLF = "\r\n";
	const chunks: Uint8Array[] = [];
	for (const p of parts) {
		chunks.push(enc.encode(`--${boundary}${CRLF}`));
		const safeName = p.name.replace(/"/g, '\\"');
		const safeFilename = p.filename.replace(/"/g, '\\"');
		chunks.push(
			enc.encode(
				`Content-Disposition: form-data; name="${safeName}"; filename="${safeFilename}"${CRLF}`,
			),
		);
		chunks.push(enc.encode(`Content-Type: ${p.contentType}${CRLF}${CRLF}`));
		chunks.push(p.bytes);
		chunks.push(enc.encode(CRLF));
	}
	chunks.push(enc.encode(`--${boundary}--${CRLF}`));

	let total = 0;
	for (const c of chunks) total += c.length;
	const body = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		body.set(c, offset);
		offset += c.length;
	}
	return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function sanitize(s: string, fallback = "x"): string {
	return (
		s
			.replace(/[^a-zA-Z0-9_-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || fallback
	);
}

/**
 * Build a unique-per-snap frame ID. Each captured snap is its own card in
 * the desktop view, so each one needs to round-trip to a distinct row on
 * the platform — even when two snaps cover the same screen state (scroll
 * position, popup variations, deliberate re-takes).
 *
 * Format: `<route-id>--<sessionId-tail>-<sequence>`. The route-id keeps
 * the frame name human-readable in the DB; the suffix makes it unique
 * and stable across re-uploads of the same snap.
 */
function frameIdFromSnap(snap: SnapRecord): string {
	const stack = snap.navStack ?? [];
	const parts: string[] = [];
	for (const seg of stack) {
		if (!seg) continue;
		if (seg.startsWith("[") && seg.endsWith("]")) continue; // dynamic params
		if (seg.startsWith("(") && seg.endsWith(")")) continue; // route groups
		parts.push(seg.toLowerCase());
	}
	const routeId =
		parts.length === 0
			? stack.length === 0
				? "welcome"
				: "home"
			: parts.join("-");
	// Take the trailing 8 chars of the sessionId — enough to disambiguate
	// across sessions without bloating the row keys.
	const sessionTail = snap.sessionId.slice(-8);
	return `${sanitize(routeId, "screen")}--${sanitize(sessionTail, "s")}-${snap.sequence}`;
}

/**
 * Human-readable frame name. Drops route groups `(...)` and dynamic params
 * `[...]` from the displayed segments, then title-cases what's left.
 *
 * `variantIndex` differentiates multiple snaps that share the same
 * (route, stateHash) slot — produced by Capture's "Snap as variant" path.
 * Index 0 = the original; 1+ get a "(2)" / "(3)" suffix so the gallery
 * sidebar can tell them apart at a glance.
 */
function frameNameFromSnap(snap: SnapRecord, variantIndex = 0): string {
	const stack = snap.navStack ?? [];
	const parts = stack.filter(
		(s) => s && !s.startsWith("(") && !s.startsWith("["),
	);
	const base =
		parts.length === 0
			? stack.length === 0
				? "Welcome"
				: "Home"
			: parts
					.map((s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " "))
					.join(" / ");
	if (variantIndex <= 0) return base;
	return `${base} (${variantIndex + 1})`;
}

/**
 * Group snaps by their slot key (projectId + route + stateHash) and assign
 * each a variant index — the position within its group, sorted by
 * capturedAt. Used by frameNameFromSnap so the second variant of /home
 * gets labeled "Home (2)" instead of colliding visually with the first.
 */
function buildVariantIndex(
	allSnaps: readonly SnapRecord[],
): Map<string, number> {
	const byKey = new Map<string, SnapRecord[]>();
	for (const s of allSnaps) {
		const key = `${s.projectId}\t${s.route}\t${s.stateHash}`;
		const list = byKey.get(key) ?? [];
		list.push(s);
		byKey.set(key, list);
	}
	const out = new Map<string, number>();
	for (const list of byKey.values()) {
		if (list.length === 1) {
			// Single snap in this slot — no variants, no suffix needed.
			out.set(`${list[0]!.sessionId}#${list[0]!.sequence}`, 0);
			continue;
		}
		list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
		list.forEach((s, i) =>
			out.set(`${s.sessionId}#${s.sequence}`, i),
		);
	}
	return out;
}

/**
 * Build a frame-position lookup keyed on (sessionId#sequence). The position
 * is the snap's index inside its flow, after sorting all sibling snaps by
 * (position, capturedAt) — the same sort key the desktop view uses.
 */
function buildFramePositionIndex(
	allSnaps: readonly SnapRecord[],
): Map<string, number> {
	const byFlow = new Map<string, SnapRecord[]>();
	for (const s of allSnaps) {
		const list = byFlow.get(s.flowId) ?? [];
		list.push(s);
		byFlow.set(s.flowId, list);
	}
	const out = new Map<string, number>();
	for (const list of byFlow.values()) {
		list.sort((a, b) => {
			const ap = a.position ?? Number.POSITIVE_INFINITY;
			const bp = b.position ?? Number.POSITIVE_INFINITY;
			if (ap !== bp) return ap - bp;
			return a.capturedAt.localeCompare(b.capturedAt);
		});
		list.forEach((s, i) => out.set(`${s.sessionId}#${s.sequence}`, i));
	}
	return out;
}

export function sessionToPlatformManifest(
	session: SessionRecord,
	flows: readonly Flow[],
	allSnaps: readonly SnapRecord[],
): PlatformManifest | null {
	if (session.snaps.length === 0) return null;
	const first = session.snaps[0];
	if (!first) return null;

	const flowById = new Map(flows.map((f) => [f.id, f]));
	const flowOrder = new Map(flows.map((f, i) => [f.id, i]));
	const framePositions = buildFramePositionIndex(allSnaps);
	const variantIndices = buildVariantIndex(allSnaps);

	type Bucket = PlatformManifest["flows"][number];
	const grouped = new Map<string, Bucket>();
	for (const snap of session.snaps) {
		const flow = flowById.get(snap.flowId);
		const id = flow?.id ?? snap.flowId ?? "snaps";
		const name = flow?.name ?? "All screens";
		let bucket = grouped.get(id);
		if (!bucket) {
			bucket = {
				id,
				name,
				parentFlowId: flow?.parentFlowId,
				autoRoute: flow?.autoRoute,
				position: flowOrder.get(id),
				frames: [],
			};
			grouped.set(id, bucket);
		}
		const variantIdx =
			variantIndices.get(`${snap.sessionId}#${snap.sequence}`) ?? 0;
		bucket.frames.push({
			id: frameIdFromSnap(snap),
			name: frameNameFromSnap(snap, variantIdx),
			image: snap.image,
			position: framePositions.get(`${snap.sessionId}#${snap.sequence}`),
			versions:
				snap.versions && snap.versions.length > 0
					? snap.versions.map((v) => ({
							image: v.image,
							capturedAt: v.capturedAt,
						}))
					: undefined,
		});
	}

	// Emit groups in the orchestrator's flow order; orphans go at the end.
	const orderedFlows: PlatformManifest["flows"] = [];
	for (const f of flows) {
		const g = grouped.get(f.id);
		if (g) {
			orderedFlows.push(g);
			grouped.delete(f.id);
		}
	}
	for (const g of grouped.values()) orderedFlows.push(g);

	return {
		projectId: first.projectId,
		buildSha: session.sessionId,
		capturedAt: session.startedAt,
		platform: first.platform,
		flows: orderedFlows,
	};
}

/**
 * Next.js dev-mode caps the multipart body around ~10MB. RN screenshots
 * run ~600KB each, so 17+ frames blow past it. We chunk into batches that
 * stay well under the limit. Each batch keeps the same buildSha (sessionId)
 * so the platform upserts the build, and frames upsert across batches by
 * their stable (flow_id, frame_id) key — comments persist either way.
 */
const MAX_FRAMES_PER_BATCH = 10;

export async function uploadSession(
	opts: UploadOptions,
): Promise<UploadResult> {
	const log = opts.log ?? (() => {});
	const fullManifest = sessionToPlatformManifest(
		opts.session,
		opts.flows,
		opts.allSnaps,
	);
	if (!fullManifest)
		return { ok: false, error: "Session has no snaps to upload." };

	// Flatten frames across all flows so we can batch by count, then
	// re-bucket each batch into its source flows. Each batch keeps the
	// same buildSha so the platform upserts the build, and frames
	// upsert across batches by their stable (flow_id, frame_id) key.
	type FlowMeta = Omit<PlatformManifest["flows"][number], "frames">;
	type Frame = PlatformManifest["flows"][number]["frames"][number];
	const items: Array<{ flow: FlowMeta; frame: Frame }> = [];
	for (const flow of fullManifest.flows) {
		const { frames, ...meta } = flow;
		for (const frame of frames) items.push({ flow: meta, frame });
	}
	if (items.length === 0)
		return { ok: false, error: "Session has no frames to upload." };

	const batches: (typeof items)[] = [];
	for (let i = 0; i < items.length; i += MAX_FRAMES_PER_BATCH) {
		batches.push(items.slice(i, i + MAX_FRAMES_PER_BATCH));
	}

	let totalUploaded = 0;
	let lastBuildId = "";
	let lastAppSlug = "";

	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		if (!batch) continue;
		const flowsInBatch = new Map<string, PlatformManifest["flows"][number]>();
		for (const it of batch) {
			let bucket = flowsInBatch.get(it.flow.id);
			if (!bucket) {
				bucket = { ...it.flow, frames: [] };
				flowsInBatch.set(it.flow.id, bucket);
			}
			bucket.frames.push(it.frame);
		}
		const batchManifest: PlatformManifest = {
			...fullManifest,
			flows: [...flowsInBatch.values()],
			// Only stamp message on the first batch — server creates the build
			// then; later batches go through the existing-build update branch.
			...(opts.message && i === 0 ? { message: opts.message } : {}),
		};
		const result = await uploadOne({
			// Replace=true only on the FIRST batch — later batches must
			// append, otherwise each one would wipe what the previous wrote.
			url: opts.replace && i === 0 ? `${opts.url}?replace=true` : opts.url,
			token: opts.token,
			outDir: opts.outDir,
			manifest: batchManifest,
			label:
				batches.length === 1
					? `${batch.length} frame(s)`
					: `batch ${i + 1}/${batches.length} (${batch.length} frame${batch.length === 1 ? "" : "s"})`,
			log,
		});
		if (!result.ok) return result;
		totalUploaded += result.framesCount;
		lastBuildId = result.buildId;
		lastAppSlug = result.appSlug;
	}

	return {
		ok: true,
		framesCount: totalUploaded,
		buildId: lastBuildId,
		appSlug: lastAppSlug,
	};
}

async function uploadOne(args: {
	url: string;
	token: string;
	outDir: string;
	manifest: PlatformManifest;
	label: string;
	log: (m: string) => void;
}): Promise<UploadResult> {
	const { url, token, outDir, manifest, label, log } = args;

	const parts: MultipartPart[] = [
		{
			name: "manifest",
			filename: "manifest.json",
			contentType: "application/json",
			bytes: new TextEncoder().encode(JSON.stringify(manifest)),
		},
	];

	let count = 0;
	for (const flow of manifest.flows) {
		for (const frame of flow.frames) {
			const filePath = join(outDir, frame.image);
			let bytes: Buffer;
			try {
				bytes = await readFile(filePath);
			} catch (err) {
				return {
					ok: false,
					error: `Missing screenshot file ${frame.image}: ${(err as Error).message}`,
				};
			}
			parts.push({
				name: frame.image,
				filename: basename(frame.image),
				contentType: "image/png",
				bytes: new Uint8Array(bytes),
			});
			count++;
			// Also bundle each past-version PNG. Server side keys captures
			// by the manifest path so the same `name` string the server
			// reads from frame.versions[i].image matches the multipart
			// part name. Missing files are skipped — the version row
			// won't have a usable image but the rest of the upload
			// shouldn't fail.
			for (const v of frame.versions ?? []) {
				const vPath = join(outDir, v.image);
				let vBytes: Buffer;
				try {
					vBytes = await readFile(vPath);
				} catch {
					continue;
				}
				parts.push({
					name: v.image,
					filename: basename(v.image),
					contentType: "image/png",
					bytes: new Uint8Array(vBytes),
				});
				count++;
			}
		}
	}

	const { body, contentType } = encodeMultipart(parts);

	log(`uploading ${label}…`);
	let resp: Response;
	try {
		const bodyBuf = Buffer.from(body);
		resp = await fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": contentType,
				"content-length": String(bodyBuf.length),
			},
			body: bodyBuf,
		});
	} catch (err) {
		return {
			ok: false,
			error: `Network: ${(err as Error).message}`,
		};
	}
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		return {
			ok: false,
			error: `${resp.status} ${resp.statusText} — ${text || "(no body)"}`,
		};
	}
	let json: {
		ok?: boolean;
		framesCount?: number;
		build?: { id?: string };
		app?: { slug?: string };
	} | null = null;
	try {
		json = (await resp.json()) as typeof json;
	} catch {
		// platform should always reply JSON, but tolerate
	}
	return {
		ok: true,
		framesCount: json?.framesCount ?? count,
		buildId: json?.build?.id ?? "",
		appSlug: json?.app?.slug ?? "",
	};
}
