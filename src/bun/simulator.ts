import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export interface SimulatorWindow {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type SimulatorWindowResult =
	| { ok: true; rect: SimulatorWindow }
	| { ok: false; error: string };

export type CaptureResult =
	| { ok: true; path: string }
	| { ok: false; error: string };

export type MirrorResult =
	| { ok: true; pngBase64: string }
	| { ok: false; error: string };

export type TapResult = { ok: true } | { ok: false; error: string };

/**
 * Grab a fresh screenshot for live-mirror polling. Writes to a temp path,
 * reads bytes, base64-encodes for transport over RPC. Polled at ~4 fps while
 * the iOS Sim view is active so the designer sees their app live inside
 * Capture instead of switching to the standalone Simulator window.
 */
const MIRROR_PATH = "/tmp/uc-mirror.png";
export function mirrorSimulator(): MirrorResult {
	if (process.platform !== "darwin") {
		return { ok: false, error: "iOS Simulator mirror is macOS-only." };
	}
	const r = spawnSync(
		"/usr/bin/xcrun",
		["simctl", "io", "booted", "screenshot", MIRROR_PATH],
		{ stdio: "pipe" },
	);
	if (r.status !== 0) {
		const stderr = r.stderr?.toString().trim() ?? "";
		if (stderr.includes("No devices are booted")) {
			return { ok: false, error: "no-booted-device" };
		}
		return {
			ok: false,
			error: `simctl screenshot failed: ${stderr || "unknown"}`,
		};
	}
	if (!existsSync(MIRROR_PATH)) {
		return { ok: false, error: "mirror file missing after screenshot" };
	}
	try {
		const bytes = readFileSync(MIRROR_PATH);
		return { ok: true, pngBase64: bytes.toString("base64") };
	} catch (e) {
		return {
			ok: false,
			error: `Failed to read ${MIRROR_PATH}: ${(e as Error).message}`,
		};
	}
}

/**
 * Capture the booted iOS Simulator's screen content directly via
 * `xcrun simctl io booted screenshot`. Pixel-perfect — no desktop chrome,
 * no titlebar, no notch fakery. This is the canonical capture path for
 * Unicorn Capture's RN mode.
 *
 * Async (uses Bun.spawn) so it can run concurrently with the WebSocket
 * metadata request from the orchestrator — total snap latency ≈
 * max(simctl, ws) instead of simctl + ws.
 */
export async function captureSimulator(outPath: string): Promise<CaptureResult> {
	if (process.platform !== "darwin") {
		return { ok: false, error: "iOS Simulator capture is macOS-only." };
	}
	const proc = Bun.spawn({
		cmd: ["/usr/bin/xcrun", "simctl", "io", "booted", "screenshot", outPath],
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	if (code !== 0 || !existsSync(outPath)) {
		const stderr = await new Response(proc.stderr).text();
		const trimmed = stderr.trim();
		if (trimmed.includes("No devices are booted")) {
			return {
				ok: false,
				error: "No iOS Simulator device is booted. Boot one and try again.",
			};
		}
		if (trimmed.includes("xcrun: error")) {
			return {
				ok: false,
				error: `Xcode command-line tools missing or misconfigured: ${trimmed}`,
			};
		}
		return {
			ok: false,
			error: `simctl screenshot failed: ${trimmed || "unknown"}`,
		};
	}
	return { ok: true, path: outPath };
}

const APPLESCRIPT_WINDOW = `
tell application "System Events"
	if not (exists process "Simulator") then return "no-simulator"
	tell process "Simulator"
		set wins to windows
		if (count of wins) is 0 then return "no-window"
		set w to first window
		set p to position of w
		set s to size of w
		set output to ((item 1 of p) as string) & "," & ((item 2 of p) as string) & "," & ((item 1 of s) as string) & "," & ((item 2 of s) as string)
		return output
	end tell
end tell
`.trim();

/**
 * Forward a tap from the Capture mirror onto the actual iOS Simulator window.
 * Designer clicks on the live mirror in Capture; we compute the equivalent
 * screen coordinate on the Simulator window and post a click via AppleScript.
 *
 * `mirrorX/Y` are the click coordinates within the mirror img (CSS px).
 * `mirrorWidth/Height` are the mirror img's display size (CSS px).
 *
 * The simulator window has macOS chrome at the top (~28pt title bar). We
 * subtract that approximation so the tap lands on the actual screen content.
 */
const SIM_CHROME_TOP = 28;

export function forwardTap(
	mirrorX: number,
	mirrorY: number,
	mirrorWidth: number,
	mirrorHeight: number,
): TapResult {
	if (process.platform !== "darwin") {
		return { ok: false, error: "Touch forwarding is macOS-only." };
	}
	const win = getSimulatorWindow();
	if (!win.ok) {
		return {
			ok: false,
			error: `Sim window not found: ${win.error}. Make sure the iOS Simulator app has a visible window.`,
		};
	}
	const contentX = win.rect.x;
	const contentY = win.rect.y + SIM_CHROME_TOP;
	const contentW = win.rect.width;
	const contentH = Math.max(1, win.rect.height - SIM_CHROME_TOP);
	const screenX = Math.round(contentX + (mirrorX / mirrorWidth) * contentW);
	const screenY = Math.round(contentY + (mirrorY / mirrorHeight) * contentH);

	const script = `
tell application "Simulator" to activate
delay 0.05
tell application "System Events"
	tell process "Simulator"
		click at {${screenX}, ${screenY}}
	end tell
end tell
`.trim();

	const r = spawnSync("/usr/bin/osascript", ["-e", script], { stdio: "pipe" });
	if (r.status !== 0) {
		return {
			ok: false,
			error: `osascript click failed: ${r.stderr?.toString().trim() || "unknown"}. Likely missing Accessibility permission for the Capture app.`,
		};
	}
	return { ok: true };
}

/**
 * Reads the rect of the frontmost iOS Simulator window via AppleScript.
 * Useful for embedding/mirroring the simulator inside the Unicorn Capture
 * UI (overlaying our chrome). NOT used for capture — `captureSimulator`
 * uses `simctl` which sidesteps window-position detection entirely.
 *
 * Requires Accessibility permission for whatever process runs this.
 */
export function getSimulatorWindow(): SimulatorWindowResult {
	if (process.platform !== "darwin") {
		return { ok: false, error: "iOS Simulator detection is macOS-only." };
	}
	const r = spawnSync("/usr/bin/osascript", ["-e", APPLESCRIPT_WINDOW], {
		stdio: "pipe",
	});
	if (r.status !== 0) {
		return {
			ok: false,
			error: `osascript failed: ${r.stderr?.toString() || "unknown"}. Likely missing Accessibility permission.`,
		};
	}
	const out = r.stdout.toString().trim();
	if (out === "no-simulator") {
		return { ok: false, error: "iOS Simulator app is not running." };
	}
	if (out === "no-window") {
		return { ok: false, error: "Simulator is running but no window is open." };
	}
	const parts = out.split(",").map((s) => Number(s.trim()));
	if (parts.length !== 4 || parts.some(Number.isNaN)) {
		return { ok: false, error: `Unexpected osascript output: "${out}"` };
	}
	const [x, y, width, height] = parts as [number, number, number, number];
	return { ok: true, rect: { x, y, width, height } };
}
