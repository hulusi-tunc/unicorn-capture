import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionRecord, SnapRecord } from "./snap-orchestrator";

/**
 * Shape the gallery platform's intake endpoint expects. Our session-based
 * snap model is collapsed into a single "snaps" flow, with frame_id derived
 * from route+stateHash so re-snaps of the same screen accumulate as
 * versions of the same frame (and comments persist).
 */
export interface PlatformManifest {
	projectId: string;
	buildSha: string;
	capturedAt: string;
	platform: "ios" | "android" | "web";
	flows: Array<{
		id: string;
		name: string;
		frames: Array<{ id: string; name: string; image: string }>;
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
 * Build a stable frame ID from the navigation stack. We use navStack rather
 * than the resolved pathname because:
 *   - "/", navStack=[]               (root/welcome, pre-auth)
 *   - "/", navStack=["(tabs)"]       (home tab, post-auth)
 *   are different screens but collapse to the same pathname.
 * Dynamic params like "[id]" are stripped — `/reservation/abc123` and
 * `/reservation/xyz789` are the same screen.
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
	const id =
		parts.length === 0
			? stack.length === 0
				? "welcome"
				: "home"
			: parts.join("-");
	return `${sanitize(id, "screen")}--${sanitize(snap.stateHash, "default")}`;
}

/**
 * Human-readable frame name. Drops route groups `(...)` and dynamic params
 * `[...]` from the displayed segments, then title-cases what's left.
 */
function frameNameFromSnap(snap: SnapRecord): string {
	const stack = snap.navStack ?? [];
	const parts = stack.filter(
		(s) => s && !s.startsWith("(") && !s.startsWith("["),
	);
	if (parts.length === 0) {
		return stack.length === 0 ? "Welcome" : "Home";
	}
	return parts
		.map((s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " "))
		.join(" / ");
}

export function sessionToPlatformManifest(
	session: SessionRecord,
): PlatformManifest | null {
	if (session.snaps.length === 0) return null;
	const first = session.snaps[0];
	if (!first) return null;
	return {
		projectId: first.projectId,
		buildSha: session.sessionId,
		capturedAt: session.startedAt,
		platform: first.platform,
		flows: [
			{
				id: "snaps",
				name: "All screens",
				frames: session.snaps.map((s) => ({
					id: frameIdFromSnap(s),
					name: frameNameFromSnap(s),
					image: s.image,
				})),
			},
		],
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
	const fullManifest = sessionToPlatformManifest(opts.session);
	if (!fullManifest)
		return { ok: false, error: "Session has no snaps to upload." };
	const allFrames = fullManifest.flows[0]?.frames ?? [];
	if (allFrames.length === 0)
		return { ok: false, error: "Session has no frames to upload." };

	const batches: (typeof allFrames)[] = [];
	for (let i = 0; i < allFrames.length; i += MAX_FRAMES_PER_BATCH) {
		batches.push(allFrames.slice(i, i + MAX_FRAMES_PER_BATCH));
	}

	let totalUploaded = 0;
	let lastBuildId = "";
	let lastAppSlug = "";

	for (let i = 0; i < batches.length; i++) {
		const frames = batches[i];
		if (!frames) continue;
		const batchManifest: PlatformManifest = {
			...fullManifest,
			flows: [
				{
					id: fullManifest.flows[0]!.id,
					name: fullManifest.flows[0]!.name,
					frames,
				},
			],
		};
		const result = await uploadOne({
			url: opts.url,
			token: opts.token,
			outDir: opts.outDir,
			manifest: batchManifest,
			label:
				batches.length === 1
					? `${frames.length} frame(s)`
					: `batch ${i + 1}/${batches.length} (${frames.length} frame${frames.length === 1 ? "" : "s"})`,
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
