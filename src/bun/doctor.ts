/**
 * Doctor — per-project health check.
 *
 * Re-runs the wizard's repo fingerprint against an already-onboarded
 * project + cross-references it with Capture's runtime state (bridge
 * connection, snap-bridge version pin) to surface drift in a single
 * audit report.
 *
 * Returns an array of `Check`s; each is a status (ok / warn / error)
 * plus an optional auto-fix action. The view renders them as a
 * checklist with a Fix button per fixable check. Where Capture can't
 * automate the repair, we leave a `manualHint` instead.
 */

import { execSync } from "node:child_process";
import { findProjectForBridge } from "./init";
import { fingerprintRepo, type RepoFingerprint } from "./repo-fingerprint";
import { getSnapBridgeVersion } from "./snap-bridge-version";

/**
 * Probe whether the iOS Simulator has at least one booted device.
 * Returns the booted device name when found so the Doctor panel can
 * show "iPhone 15 Pro is booted" instead of just a checkmark. macOS
 * only — gracefully returns `{ booted: false, deviceName: null }` on
 * other platforms. Sync because `xcrun simctl` returns in <50ms.
 */
export function probeSimulatorBooted(): {
	booted: boolean;
	deviceName: string | null;
} {
	try {
		const out = execSync("xcrun simctl list devices booted -j", {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		});
		const parsed = JSON.parse(out) as {
			devices?: Record<string, Array<{ name?: string; state?: string }>>;
		};
		const all = Object.values(parsed.devices ?? {}).flat();
		const booted = all.find((d) => d?.state === "Booted");
		return { booted: !!booted, deviceName: booted?.name ?? null };
	} catch {
		return { booted: false, deviceName: null };
	}
}

/**
 * Probe whether an Expo / Metro dev server is reachable on the standard
 * port. We hit `/status` (Expo CLI's healthcheck) — when it responds
 * with the magic header, the bundler is alive. Anything else (no
 * response, wrong header) means the dev server isn't running. Default
 * port 8081; designers using a custom `--port` see a false negative
 * here, which is acceptable for v1 — they can launch from Capture and
 * skip the question entirely.
 */
export async function probeExpoDevServer(): Promise<{ running: boolean }> {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 1500);
		const resp = await fetch("http://localhost:8081/status", {
			signal: ctrl.signal,
		}).finally(() => clearTimeout(timer));
		const text = await resp.text().catch(() => "");
		// Metro's /status replies with "packager-status:running" in body.
		return { running: resp.ok && text.includes("running") };
	} catch {
		return { running: false };
	}
}

export interface RuntimeProbes {
	bridgeConnected: boolean;
	simulator: { booted: boolean; deviceName: string | null };
	expoDevServer: { running: boolean };
}

export type CheckStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
	id: string;
	label: string;
	status: CheckStatus;
	detail: string;
	/** When set, the view renders a Fix button that calls this RPC. */
	fixAction?: {
		kind:
			| "bump-snap-bridge"
			| "regenerate-flows"
			| "merge-flows"
			| "install-view-shot"
			| "open-layout"
			| "boot-simulator"
			| "launch-expo"
			| "reconnect-bridge"
			| "manual";
		label: string;
		/** Path that the manual action points to (e.g. layout file to open). */
		target?: string;
	};
}

export interface DoctorReport {
	slug: string;
	repoPath: string;
	rnAppDir: string | null;
	bridgeConnected: boolean;
	snapBridgePinned: string | null;
	snapBridgeSuggested: string;
	checks: DoctorCheck[];
	/** Bucket counts for the header summary. */
	summary: { ok: number; warn: number; error: number };
}

/**
 * Build a health report. Pure — caller decides what to do with the
 * suggested fixes (the view dispatches them as separate RPC calls).
 */
export function runDoctor(
	slug: string,
	probes: RuntimeProbes,
): { ok: true; report: DoctorReport } | { ok: false; error: string } {
	const { bridgeConnected, simulator, expoDevServer } = probes;
	const project = findProjectForBridge(slug);
	if (!project) return { ok: false, error: `No project with slug "${slug}"` };
	const repoPath = project.repoPath;
	if (!repoPath) {
		return {
			ok: false,
			error: `Project "${slug}" has no repoPath in the local registry — re-add via "+ Add" to fingerprint it.`,
		};
	}

	let fp: RepoFingerprint;
	try {
		fp = fingerprintRepo(repoPath);
	} catch (err) {
		return {
			ok: false,
			error: `Fingerprint failed: ${(err as Error).message}`,
		};
	}

	const suggested = getSnapBridgeVersion();
	const checks: DoctorCheck[] = [];

	// Runtime checks come first — they're the ones the designer
	// can actually act on when Snap is greyed out. Repo / version
	// checks are about pre-existing config that rarely needs daily
	// attention.

	// R1. iOS Simulator booted
	checks.push({
		id: "simulator-booted",
		label: "iOS Simulator running",
		status: simulator.booted ? "ok" : "error",
		detail: simulator.booted
			? `Booted: ${simulator.deviceName ?? "unknown device"}.`
			: "No booted simulator detected. Open Simulator.app or click Fix to boot the last-used device.",
		fixAction: simulator.booted
			? undefined
			: { kind: "boot-simulator", label: "Boot simulator" },
	});

	// R2. Expo dev server reachable
	checks.push({
		id: "expo-running",
		label: "Expo / Metro dev server reachable",
		status: expoDevServer.running ? "ok" : "error",
		detail: expoDevServer.running
			? "Dev server is responding on http://localhost:8081."
			: "No dev server on http://localhost:8081. Click Launch to start `expo start` from this repo, or run it yourself.",
		fixAction: expoDevServer.running
			? undefined
			: { kind: "launch-expo", label: "Launch Expo" },
	});

	// R3. Bridge connectivity — the snap-bridge WebSocket
	checks.push({
		id: "bridge-connected",
		label: "snap-bridge connected to your app",
		status: bridgeConnected ? "ok" : "warn",
		detail: bridgeConnected
			? "Bridge is online and pinging back."
			: "No active connection. If your app is running, click Reconnect to restart Capture's WebSocket listener.",
		fixAction: bridgeConnected
			? undefined
			: { kind: "reconnect-bridge", label: "Reconnect" },
	});

	// 2. snap-bridge version pin
	const sb = fp.snapBridge;
	if (sb.state === "missing") {
		checks.push({
			id: "snap-bridge-version",
			label: "snap-bridge dependency",
			status: "error",
			detail: "snap-bridge is not installed in this repo. Re-run the wizard.",
		});
	} else if (sb.state === "floating") {
		checks.push({
			id: "snap-bridge-version",
			label: "snap-bridge version pin",
			status: "warn",
			detail: `Floating ref (${sb.current}). Pinning to ${suggested} prevents the v0.0.1 drift bug.`,
			fixAction: {
				kind: "bump-snap-bridge",
				label: `Pin to ${suggested}`,
			},
		});
	} else if (sb.state === "pinned" && !sb.matchesSuggested) {
		checks.push({
			id: "snap-bridge-version",
			label: "snap-bridge version pin",
			status: "warn",
			detail: `Pinned to ${sb.current}. Capture suggests ${suggested}.`,
			fixAction: {
				kind: "bump-snap-bridge",
				label: `Bump to ${suggested}`,
			},
		});
	} else {
		checks.push({
			id: "snap-bridge-version",
			label: "snap-bridge version pin",
			status: "ok",
			detail: `Pinned to ${sb.current}.`,
		});
	}

	// 3. Layout wiring
	if (!fp.layoutFile.path) {
		checks.push({
			id: "layout-wired",
			label: "_layout.tsx wired",
			status: "error",
			detail: "No root _layout file detected. Capture needs `installSnapBridge` to be called somewhere at module scope.",
		});
	} else if (fp.layoutFile.wiringState === "absent") {
		checks.push({
			id: "layout-wired",
			label: "_layout.tsx wired",
			status: "error",
			detail: `${fp.layoutFile.path} doesn't call \`installSnapBridge\`. Re-run the onboarding wizard or paste the snippet by hand.`,
			fixAction: {
				kind: "open-layout",
				label: "Open layout",
				target: fp.layoutFile.path,
			},
		});
	} else if (fp.layoutFile.wiringState === "ast-unsupported") {
		checks.push({
			id: "layout-wired",
			label: "_layout.tsx wired",
			status: "warn",
			detail: `${fp.layoutFile.path}'s component shape (${fp.layoutFile.componentShape}) isn't auto-editable. Manual paste needed.`,
			fixAction: {
				kind: "open-layout",
				label: "Open layout",
				target: fp.layoutFile.path,
			},
		});
	} else {
		checks.push({
			id: "layout-wired",
			label: "_layout.tsx wired",
			status: "ok",
			detail: `${fp.layoutFile.path} calls installSnapBridge. ✓`,
		});
	}

	// 4. snap-flows.ts presence
	if (!fp.flowsFile.path) {
		checks.push({
			id: "flows-file",
			label: "snap-flows.ts present",
			status: "error",
			detail: "snap-flows.ts is missing. Run `Refresh → Regenerate` to create it from your app/ folder.",
			fixAction: {
				kind: "regenerate-flows",
				label: "Generate from app/",
			},
		});
	} else {
		const ageHours = fp.flowsFile.lastModified
			? Math.round(
					(Date.now() - new Date(fp.flowsFile.lastModified).getTime()) /
						(1000 * 60 * 60),
				)
			: null;
		checks.push({
			id: "flows-file",
			label: "snap-flows.ts present",
			status: "ok",
			detail:
				ageHours == null
					? `Found at ${fp.flowsFile.path}.`
					: `Last edit ${ageHours == 0 ? "<1h ago" : `${ageHours}h ago`}. Run \`Refresh → Add missing\` after route changes.`,
			fixAction: {
				kind: "merge-flows",
				label: "Add missing routes",
			},
		});
	}

	// 5. useSnapTarget hook (full-page capture prerequisite)
	checks.push({
		id: "hook-file",
		label: "useSnapTarget hook installed",
		status: fp.hookFile.path ? "ok" : "warn",
		detail: fp.hookFile.path
			? `Found at ${fp.hookFile.path}.`
			: "Missing — needed only if you wrap screens for full-page capture. Re-run the wizard or copy from snap-bridge/examples.",
	});

	// 6. react-native-view-shot
	if (!fp.viewShot.installed) {
		checks.push({
			id: "view-shot",
			label: "react-native-view-shot installed",
			status: "warn",
			detail: "Missing — full-page snaps fall back to viewport-only capture. Optional unless you wrap screens.",
			fixAction: {
				kind: "install-view-shot",
				label: "npm install",
			},
		});
	} else if (!fp.viewShot.podsInstalled) {
		checks.push({
			id: "view-shot",
			label: "react-native-view-shot installed",
			status: "warn",
			detail: "Installed in package.json but iOS pods haven't run. `cd ios && pod install`.",
		});
	} else {
		checks.push({
			id: "view-shot",
			label: "react-native-view-shot installed",
			status: "ok",
			detail: "Installed + pods linked.",
		});
	}

	// 7. iOS workspace
	checks.push({
		id: "ios-workspace",
		label: "iOS workspace exists",
		status: fp.iosWorkspace.exists ? "ok" : "warn",
		detail: fp.iosWorkspace.exists
			? `ios/ folder + Podfile.lock found.`
			: "No ios/ folder — managed Expo project? snap-bridge still works in Expo Go for most cases.",
	});

	const summary = checks.reduce(
		(acc, c) => {
			acc[c.status] += 1;
			return acc;
		},
		{ ok: 0, warn: 0, error: 0 } as DoctorReport["summary"],
	);

	return {
		ok: true,
		report: {
			slug,
			repoPath,
			rnAppDir: project.rnAppDir ?? null,
			bridgeConnected,
			snapBridgePinned:
				sb.state === "pinned" || sb.state === "floating" ? sb.current : null,
			snapBridgeSuggested: suggested,
			checks,
			summary,
		},
	};
}
