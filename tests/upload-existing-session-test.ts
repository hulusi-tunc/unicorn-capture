// Re-upload the most recent session from local manifest to the platform.
// Useful when a previous session was captured offline (or upload failed)
// and you want to push it without recapturing.
//
// Run with:
//   SNAP_UPLOAD_URL=http://localhost:3010/api/captures/upload \
//   SNAP_UPLOAD_TOKEN=pgt_xxx \
//   bun tests/upload-existing-session-test.ts
//
// Optional: SNAP_OUT=/path/to/snaps to point at a non-default folder.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Manifest } from "../src/bun/snap-orchestrator";
import { uploadSession } from "../src/bun/upload";

const URL = process.env.SNAP_UPLOAD_URL;
const TOKEN = process.env.SNAP_UPLOAD_TOKEN;
const OUT_DIR = resolve(process.cwd(), process.env.SNAP_OUT ?? "snaps");

if (!URL || !TOKEN) {
	console.error(
		"Missing env. Set SNAP_UPLOAD_URL and SNAP_UPLOAD_TOKEN before running.",
	);
	process.exit(1);
}

const manifestPath = resolve(OUT_DIR, "manifest.json");
let manifest: Manifest;
try {
	manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
} catch (err) {
	console.error(`Could not read ${manifestPath}: ${(err as Error).message}`);
	process.exit(1);
}

const sessions = manifest.sessions ?? [];
const lastSession = sessions[sessions.length - 1];
if (!lastSession || lastSession.snaps.length === 0) {
	console.error(
		`No sessions with snaps in ${manifestPath}. Run \`bun run snap\` first.`,
	);
	process.exit(1);
}

console.log(
	`Uploading session ${lastSession.sessionId} (${lastSession.snaps.length} snap(s))…`,
);
console.log(`  out:    ${OUT_DIR}`);
console.log(`  to:     ${URL}`);
console.log("");

const result = await uploadSession({
	url: URL,
	token: TOKEN,
	outDir: OUT_DIR,
	session: lastSession,
	log: (m) => console.log(`  ${m}`),
});

if (!result.ok) {
	console.error(`✗ upload failed: ${result.error}`);
	process.exit(1);
}

console.log("");
console.log(
	`✓ uploaded to ${result.appSlug || "platform"} — ${result.framesCount} frame(s), build ${result.buildId.slice(0, 8)}`,
);
process.exit(0);
