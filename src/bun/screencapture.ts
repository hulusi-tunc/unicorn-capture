import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface CaptureRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function captureRect(
	rect: CaptureRect,
	outDir: string,
	name: string,
): { ok: true; path: string } | { ok: false; error: string } {
	if (process.platform !== "darwin") {
		return {
			ok: false,
			error:
				"Screen capture currently supported on macOS only (uses /usr/sbin/screencapture).",
		};
	}
	const path = join(outDir, `${name}.png`);
	// macOS screencapture: -R x,y,w,h  -t png  -x (no sound)
	const r = spawnSync(
		"/usr/sbin/screencapture",
		[
			"-R",
			`${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`,
			"-t",
			"png",
			"-x",
			path,
		],
		{ stdio: "pipe" },
	);
	if (r.status !== 0 || !existsSync(path)) {
		return {
			ok: false,
			error: `screencapture failed: ${r.stderr?.toString() || "unknown"}`,
		};
	}
	return { ok: true, path };
}
