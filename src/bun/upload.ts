import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

/**
 * One per missing/unreadable image that got dropped from an upload.
 * `image` is the local relative path (matches `SnapRecord.image` or a
 * version path); for past versions a `(version)` suffix is appended so
 * the summary UI can distinguish them from the current frame.
 */
export interface UploadSkipped {
	image: string;
	reason: "missing-file" | "read-error" | "too-large";
	/** Byte count for `too-large` skips so the UI can format a useful hint. */
	bytes?: number;
}

/**
 * Per-frame public URL returned by the gallery. Used by Capture to
 * populate `SnapRecord.remoteImageUrl` so local PNGs can be evicted
 * after the cache grace period without losing thumbnails.
 *
 * `frameId` matches the manifest-side frame id Capture generated via
 * `frameIdFromSnap` — the client looks each one up to find the
 * matching snap.
 */
export interface UploadedFrameUrl {
	frameId: string;
	url: string;
}

export type UploadResult =
	| {
			ok: true;
			framesCount: number;
			buildId: string;
			appSlug: string;
			skipped: UploadSkipped[];
			frames: UploadedFrameUrl[];
	  }
	| { ok: false; error: string; skipped: UploadSkipped[] };

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
export function frameIdFromSnap(snap: SnapRecord): string {
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
	const explicit = snap.displayName?.trim();
	let base: string;
	if (explicit) {
		base = explicit;
	} else if (snap.platform === "web") {
		// Web snaps have no navStack — derive a readable name from the route.
		// /en/dashboard/requests → "Dashboard / Requests" (locale stripped,
		// segments title-cased). Falls back to the raw route when nothing
		// nicer can be built (e.g., just "/").
		const route = snap.route || "/";
		const segs = route
			.split("/")
			.filter((s) => s && !s.startsWith(":") && !s.startsWith("(") && !s.startsWith("["));
		const localeRe = /^[a-z]{2}(-[a-zA-Z]{2,4})?$/;
		if (segs.length > 0 && localeRe.test(segs[0]!)) segs.shift();
		if (segs.length === 0) base = "Home";
		else
			base = segs
				.map((s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " "))
				.join(" / ");
	} else {
		const stack = snap.navStack ?? [];
		const parts = stack.filter(
			(s) => s && !s.startsWith("(") && !s.startsWith("["),
		);
		base =
			parts.length === 0
				? stack.length === 0
					? "Welcome"
					: "Home"
				: parts
						.map((s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " "))
						.join(" / ");
	}
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
 * Vercel serverless functions cap request bodies at ~4.5MB. We pack frames
 * into batches by TOTAL ON-DISK SIZE rather than count — mobile snaps sit
 * around 600KB so dozens fit per batch, but a single web full-page snap
 * can be 8-15MB and needs its own (probably-failing) batch with a clear
 * error so the user knows which frame is too big.
 *
 * SAFE_BATCH_BYTES leaves headroom for multipart envelope + manifest JSON
 * + any version PNGs that ride along. MAX_FRAMES_PER_BATCH is a safety cap
 * to keep the per-batch latency bounded even for projects with hundreds of
 * tiny snaps.
 */
const SAFE_BATCH_BYTES = 3_500_000;
const MAX_FRAMES_PER_BATCH = 20;
// Truly massive PNGs (40MB+) are almost certainly bad captures — even q60
// WebP wouldn't fit. Preflight-skip them with a clear reason. Below this
// ceiling we trust WebP recoding to bring the bytes under Vercel's 4.5MB
// cap; anything that still doesn't fit fails at the per-batch level with
// the actual server error.
const HARD_FRAME_BYTES = 40_000_000;
// Re-encode any PNG larger than this to JPEG @ q85 before push. Web full-
// page snaps (8-15MB PNG) typically drop to 1-3MB JPEG — fits Vercel's
// limit without losing visible quality for UI screenshots. macOS sips
// can write JPEG natively (it can't write WebP), so this stays dep-free.
const RECODE_PNG_THRESHOLD = 1_500_000;
const JPEG_QUALITY = 85;

/**
 * Re-encode PNG bytes to JPEG via macOS `sips` so we can fit large web
 * snaps under Vercel's 4.5MB body cap. Subprocess + temp files (not
 * ideal) but uses zero deps and is fast enough — the push pipeline is
 * already disk-bound.
 *
 * Returns `null` if sips isn't available or the encode fails, so the
 * caller falls back to sending the original PNG (which may then hit the
 * too-large skip).
 */
async function recodePngToJpeg(
	pngBytes: Uint8Array,
): Promise<Uint8Array | null> {
	const stamp = randomBytes(6).toString("hex");
	const tmpIn = join(tmpdir(), `uc-recode-${stamp}.png`);
	const tmpOut = join(tmpdir(), `uc-recode-${stamp}.jpg`);
	try {
		await writeFile(tmpIn, pngBytes);
		await new Promise<void>((resolve, reject) => {
			const proc = spawn("sips", [
				"-s", "format", "jpeg",
				"-s", "formatOptions", String(JPEG_QUALITY),
				tmpIn,
				"--out", tmpOut,
			]);
			proc.on("close", (code) =>
				code === 0 ? resolve() : reject(new Error(`sips exit ${code}`)),
			);
			proc.on("error", reject);
		});
		const out = await readFile(tmpOut);
		return new Uint8Array(out);
	} catch {
		return null;
	} finally {
		await unlink(tmpIn).catch(() => {});
		await unlink(tmpOut).catch(() => {});
	}
}

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
		return { ok: false, error: "Session has no snaps to upload.", skipped: [] };

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
		return { ok: false, error: "Session has no frames to upload.", skipped: [] };

	// Pre-measure each frame (cheap — single stat, no readFile) so we can
	// pack into size-bounded batches. Versions ride along in the same
	// multipart body so we count them too.
	const sizes = new Map<string, number>();
	const preflightSkipped: UploadSkipped[] = [];
	const sendable: typeof items = [];
	for (const it of items) {
		let frameSize = 0;
		try {
			const st = await stat(join(opts.outDir, it.frame.image));
			frameSize = st.size;
		} catch {
			// Missing file — uploadOne's per-batch read will surface it.
		}
		let versionsSize = 0;
		for (const v of it.frame.versions ?? []) {
			try {
				const st = await stat(join(opts.outDir, v.image));
				versionsSize += st.size;
			} catch {}
		}
		const total = frameSize + versionsSize;
		// Skip only truly massive PNGs (way past anything WebP could shrink
		// to fit Vercel's 4.5MB cap). Below the hard ceiling, uploadOne's
		// WebP recode handles the heavy lifting.
		if (frameSize > HARD_FRAME_BYTES) {
			preflightSkipped.push({
				image: it.frame.image,
				reason: "too-large",
				bytes: frameSize,
			});
			continue;
		}
		sizes.set(`${it.flow.id}::${it.frame.id}`, total);
		sendable.push(it);
	}

	const batches: (typeof sendable)[] = [];
	let current: typeof sendable = [];
	let currentBytes = 0;
	for (const it of sendable) {
		const k = `${it.flow.id}::${it.frame.id}`;
		const size = sizes.get(k) ?? 0;
		const wouldOverflow =
			current.length > 0 &&
			(currentBytes + size > SAFE_BATCH_BYTES ||
				current.length >= MAX_FRAMES_PER_BATCH);
		if (wouldOverflow) {
			batches.push(current);
			current = [];
			currentBytes = 0;
		}
		current.push(it);
		currentBytes += size;
		// A single oversized frame becomes its own batch so smaller
		// neighbors don't get dragged into a doomed request — the solo
		// batch fails with a clear per-frame error if it really is too big.
		if (size > SAFE_BATCH_BYTES) {
			batches.push(current);
			current = [];
			currentBytes = 0;
		}
	}
	if (current.length > 0) batches.push(current);

	let totalUploaded = 0;
	let lastBuildId = "";
	let lastAppSlug = "";
	const allSkipped: UploadSkipped[] = [...preflightSkipped];
	const allFrames: UploadedFrameUrl[] = [];
	if (preflightSkipped.length > 0) {
		opts.log?.(
			`skipping ${preflightSkipped.length} oversized frame${preflightSkipped.length === 1 ? "" : "s"} (Vercel 4.5MB cap)`,
		);
	}
	if (sendable.length === 0) {
		return {
			ok: false,
			error: `All ${items.length} frame${items.length === 1 ? "" : "s"} exceed Vercel's 4.5MB payload limit. Re-snap as viewport (instead of full page), or shorten the page before re-snapping.`,
			skipped: allSkipped,
		};
	}

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
		// Always carry forward skipped frames the batch detected, even on
		// failure — the user still wants to see which local files were
		// missing before the batch died.
		allSkipped.push(...result.skipped);
		if (!result.ok) {
			log(
				`batch ${i + 1}/${batches.length} failed: ${result.error} (aborting remaining batches)`,
			);
			return { ...result, skipped: allSkipped };
		}
		log(
			`batch ${i + 1}/${batches.length} ok — ${result.framesCount} frames stored`,
		);
		totalUploaded += result.framesCount;
		lastBuildId = result.buildId;
		lastAppSlug = result.appSlug;
		allFrames.push(...result.frames);
	}

	return {
		ok: true,
		framesCount: totalUploaded,
		buildId: lastBuildId,
		appSlug: lastAppSlug,
		skipped: allSkipped,
		frames: allFrames,
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

	// Pre-read every screenshot file. Frames whose PNG is missing on disk
	// get dropped from this upload (and from the manifest sent to the
	// server) so a few stale records don't fail the whole push. The
	// manifest entry itself stays in the local store — only this upload
	// is filtered. Skipped frames + versions are returned to the caller so
	// the UI's post-push summary modal can show what didn't make it.
	const frameBytes = new Map<string, Uint8Array>();
	const versionBytes = new Map<string, Uint8Array>();
	const frameContentType = new Map<string, string>();
	const versionContentType = new Map<string, string>();
	const skipped: UploadSkipped[] = [];
	let recoded = 0;
	let savedBytes = 0;

	const maybeRecode = async (
		key: string,
		originalBytes: Uint8Array,
	): Promise<{ bytes: Uint8Array; contentType: string }> => {
		if (originalBytes.byteLength <= RECODE_PNG_THRESHOLD) {
			return { bytes: originalBytes, contentType: "image/png" };
		}
		const jpg = await recodePngToJpeg(originalBytes);
		if (!jpg || jpg.byteLength >= originalBytes.byteLength) {
			return { bytes: originalBytes, contentType: "image/png" };
		}
		recoded += 1;
		savedBytes += originalBytes.byteLength - jpg.byteLength;
		log(
			`  · ${key} → jpeg (${(originalBytes.byteLength / 1_000_000).toFixed(1)}MB → ${(jpg.byteLength / 1_000_000).toFixed(1)}MB)`,
		);
		return { bytes: jpg, contentType: "image/jpeg" };
	};

	for (const flow of manifest.flows) {
		for (const frame of flow.frames) {
			const filePath = join(outDir, frame.image);
			try {
				const raw = new Uint8Array(await readFile(filePath));
				const { bytes, contentType } = await maybeRecode(frame.image, raw);
				frameBytes.set(frame.image, bytes);
				frameContentType.set(frame.image, contentType);
			} catch (err) {
				const reason =
					(err as NodeJS.ErrnoException)?.code === "ENOENT"
						? "missing-file"
						: "read-error";
				skipped.push({ image: frame.image, reason });
				continue;
			}
			// Past versions stay best-effort — missing version PNGs get
			// reported but don't fail the frame they belong to.
			for (const v of frame.versions ?? []) {
				try {
					const raw = new Uint8Array(await readFile(join(outDir, v.image)));
					const { bytes, contentType } = await maybeRecode(v.image, raw);
					versionBytes.set(v.image, bytes);
					versionContentType.set(v.image, contentType);
				} catch (err) {
					const reason =
						(err as NodeJS.ErrnoException)?.code === "ENOENT"
							? "missing-file"
							: "read-error";
					skipped.push({ image: `${v.image} (version)`, reason });
				}
			}
		}
	}

	if (recoded > 0) {
		log(
			`recoded ${recoded} large image${recoded === 1 ? "" : "s"} to JPEG — saved ${(savedBytes / 1_000_000).toFixed(1)}MB`,
		);
	}

	if (skipped.length > 0) {
		log(
			`skipping ${skipped.length} image${skipped.length === 1 ? "" : "s"} (missing or unreadable on disk)`,
		);
		for (const m of skipped.slice(0, 5)) log(`  · ${m.image} — ${m.reason}`);
		if (skipped.length > 5) {
			log(`  · …and ${skipped.length - 5} more`);
		}
	}

	const filteredManifest: PlatformManifest = {
		...manifest,
		flows: manifest.flows
			.map((flow) => ({
				...flow,
				frames: flow.frames
					.filter((f) => frameBytes.has(f.image))
					.map((f) => ({
						...f,
						versions: (f.versions ?? []).filter((v) =>
							versionBytes.has(v.image),
						),
					})),
			}))
			.filter((flow) => flow.frames.length > 0),
	};

	if (filteredManifest.flows.length === 0) {
		log(`nothing live to upload for ${label} — all frames missing on disk`);
		return {
			ok: true,
			framesCount: 0,
			buildId: "",
			appSlug: "",
			skipped,
			frames: [],
		};
	}

	const parts: MultipartPart[] = [
		{
			name: "manifest",
			filename: "manifest.json",
			contentType: "application/json",
			bytes: new TextEncoder().encode(JSON.stringify(filteredManifest)),
		},
	];

	const filenameWithExt = (originalPath: string, contentType: string): string => {
		const base = basename(originalPath);
		// Swap the .png extension on the multipart filename when we recoded
		// the bytes, so a server that picks extension from the filename
		// stores the right thing. The lookup key (`name` field) keeps the
		// manifest's original path, which is how the gallery joins bytes
		// back to its frame entry.
		if (base.toLowerCase().endsWith(".png")) {
			const stem = base.slice(0, -4);
			if (contentType === "image/webp") return `${stem}.webp`;
			if (contentType === "image/jpeg") return `${stem}.jpg`;
		}
		return base;
	};

	let count = 0;
	for (const flow of filteredManifest.flows) {
		for (const frame of flow.frames) {
			const ct = frameContentType.get(frame.image) ?? "image/png";
			parts.push({
				name: frame.image,
				filename: filenameWithExt(frame.image, ct),
				contentType: ct,
				bytes: frameBytes.get(frame.image)!,
			});
			count++;
			for (const v of frame.versions ?? []) {
				const vBuf = versionBytes.get(v.image);
				if (!vBuf) continue;
				const vct = versionContentType.get(v.image) ?? "image/png";
				parts.push({
					name: v.image,
					filename: filenameWithExt(v.image, vct),
					contentType: vct,
					bytes: vBuf,
				});
				count++;
			}
		}
	}

	const { body, contentType } = encodeMultipart(parts);

	const bodyBuf = Buffer.from(body);
	const sizeMb = (bodyBuf.length / (1024 * 1024)).toFixed(1);
	log(`uploading ${label} (${sizeMb}MB)…`);
	let resp: Response;
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), 90_000);
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": contentType,
				"content-length": String(bodyBuf.length),
			},
			body: bodyBuf,
			signal: abort.signal,
		});
	} catch (err) {
		const e = err as Error;
		return {
			ok: false,
			error:
				e.name === "AbortError"
					? "Upload timed out after 90s (likely Vercel function exhaustion or body too large)"
					: `Network: ${e.message}`,
			skipped,
		};
	} finally {
		clearTimeout(timer);
	}
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		return {
			ok: false,
			error: `${resp.status} ${resp.statusText} — ${text || "(no body)"}`,
			skipped,
		};
	}
	let json: {
		ok?: boolean;
		framesCount?: number;
		build?: { id?: string };
		app?: { slug?: string };
		frames?: Array<{ frameId?: string; url?: string }>;
	} | null = null;
	try {
		json = (await resp.json()) as typeof json;
	} catch {
		// platform should always reply JSON, but tolerate
	}
	// `frames` is optional — older gallery deployments don't return it.
	// Capture treats a missing list as "no URLs available, keep local
	// files indefinitely" rather than erroring; eviction simply waits.
	const frames: UploadedFrameUrl[] = [];
	for (const f of json?.frames ?? []) {
		if (!f?.frameId || !f?.url) continue;
		frames.push({ frameId: f.frameId, url: f.url });
	}
	return {
		ok: true,
		framesCount: json?.framesCount ?? count,
		buildId: json?.build?.id ?? "",
		appSlug: json?.app?.slug ?? "",
		skipped,
		frames,
	};
}
