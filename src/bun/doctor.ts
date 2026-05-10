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

import { findProjectForBridge } from "./init";
import { fingerprintRepo, type RepoFingerprint } from "./repo-fingerprint";
import { getSnapBridgeVersion } from "./snap-bridge-version";

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
	bridgeConnected: boolean,
): { ok: true; report: DoctorReport } | { ok: false; error: string } {
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

	// 1. Bridge connectivity
	checks.push({
		id: "bridge-connected",
		label: "snap-bridge WebSocket connected",
		status: bridgeConnected ? "ok" : "warn",
		detail: bridgeConnected
			? "Bridge is online and pinging back."
			: "No active connection. Make sure your RN app is running in the iOS sim and `installSnapBridge` is called in _layout.",
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
