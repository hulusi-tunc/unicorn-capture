import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

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

/**
 * Capture the booted iOS Simulator's screen content directly via
 * `xcrun simctl io booted screenshot`. Pixel-perfect — no desktop chrome,
 * no titlebar, no notch fakery. This is the canonical capture path for
 * Unicorn Capture's RN mode.
 */
export function captureSimulator(outPath: string): CaptureResult {
	if (process.platform !== "darwin") {
		return { ok: false, error: "iOS Simulator capture is macOS-only." };
	}
	const r = spawnSync(
		"/usr/bin/xcrun",
		["simctl", "io", "booted", "screenshot", outPath],
		{ stdio: "pipe" },
	);
	if (r.status !== 0 || !existsSync(outPath)) {
		const stderr = r.stderr?.toString().trim() ?? "";
		if (stderr.includes("No devices are booted")) {
			return {
				ok: false,
				error: "No iOS Simulator device is booted. Boot one and try again.",
			};
		}
		if (stderr.includes("xcrun: error")) {
			return {
				ok: false,
				error: `Xcode command-line tools missing or misconfigured: ${stderr}`,
			};
		}
		return {
			ok: false,
			error: `simctl screenshot failed: ${stderr || "unknown"}`,
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
