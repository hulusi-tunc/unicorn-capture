/**
 * Step implementations for the new atomic installer.
 *
 * Each step:
 *   - has a stable `id` used by progress events
 *   - is idempotent where possible (re-running doesn't double-edit)
 *   - has a best-effort `rollback` that undoes its work
 *
 * Order matters — see `assembleSteps()` at the bottom for the canonical
 * sequence the driver runs.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import {
	addBridgeDep,
	createProjectOnPlatform,
	getAugmentedSpawnEnv,
	injectLayoutSnippet,
	patchMetroConfig,
	registerWithCapture,
	removeBridgeDep,
	writeUnicornDir,
} from "./init";
import type { Step } from "./installer";
import { getSnapBridgeRef } from "./snap-bridge-version";

// ── 1. Platform register ─────────────────────────────────────────────────

const platformRegisterStep: Step = {
	id: "platformRegister",
	describe: (plan) =>
		plan.projectToken
			? "Reusing existing project token"
			: `Registering ${plan.slug} on the platform`,
	async run(ctx) {
		if (ctx.plan.projectToken) {
			ctx.bag.projectToken = ctx.plan.projectToken;
			return;
		}
		if (!ctx.plan.setupToken && !ctx.plan.accessToken) {
			throw new Error(
				"Sign in (or provide a token / setup token) to register the project.",
			);
		}
		const r = await createProjectOnPlatform({
			url: ctx.plan.platformUrl,
			setupToken: ctx.plan.setupToken,
			accessToken: ctx.plan.accessToken,
			slug: ctx.plan.slug,
			name: ctx.plan.name ?? ctx.plan.slug,
			platform: ctx.plan.platform,
		});
		ctx.bag.projectToken = r.projectToken;
		ctx.bag.platformProjectId = r.id;
		ctx.memo.set("createdOnPlatform", true);
	},
	// We don't try to delete the platform record on rollback — too risky and
	// the platform's idempotent on slug, so a re-run is a no-op anyway.
};

// ── 2. Add snap-bridge dep ───────────────────────────────────────────────

function installTargetPkgPath(plan: { fingerprint: { isMonorepo: boolean; workspaceRoot: string; picked: { rnAppDir: string } | null } }): string {
	const fp = plan.fingerprint;
	if (!fp.picked) throw new Error("No RN app dir picked");
	return fp.isMonorepo
		? join(fp.workspaceRoot, "package.json")
		: join(fp.picked.rnAppDir, "package.json");
}

const addBridgeDepStep: Step = {
	id: "addBridgeDep",
	describe: (plan) => `Pinning @unicorn-studio/snap-bridge to ${getSnapBridgeRef()}`,
	async run(ctx) {
		const target = installTargetPkgPath(ctx.plan);
		const result = addBridgeDep(target, getSnapBridgeRef());
		ctx.memo.set("target", target);
		ctx.memo.set("previousRef", result.previousRef);
		ctx.memo.set("changed", result.changed);
	},
	async rollback(ctx) {
		if (!ctx.memo.get("changed")) return;
		const target = ctx.memo.get("target") as string;
		const previousRef = ctx.memo.get("previousRef") as string | null;
		removeBridgeDep(target, previousRef);
	},
};

// ── 3. Metro config ─────────────────────────────────────────────────────

const writeMetroConfigStep: Step = {
	id: "writeMetroConfig",
	describe: (plan) =>
		plan.fingerprint.isMonorepo
			? "Configuring metro.config.js for the monorepo"
			: "Skipping metro.config.js (single-package layout)",
	enabled: (plan) => plan.fingerprint.isMonorepo,
	async run(ctx) {
		if (!ctx.plan.fingerprint.picked) throw new Error("No RN app dir picked");
		const flavor: "expo" | "rn-cli" =
			ctx.plan.fingerprint.rnLayout === "rn-cli" ? "rn-cli" : "expo";
		const result = patchMetroConfig({
			rnAppDir: ctx.plan.fingerprint.picked.rnAppDir,
			workspaceRoot: ctx.plan.fingerprint.workspaceRoot,
			flavor,
		});
		ctx.memo.set(
			"metroConfigPath",
			join(ctx.plan.fingerprint.picked.rnAppDir, "metro.config.js"),
		);
		ctx.memo.set("previousContents", result.previousContents);
		ctx.memo.set("mode", result.mode);
	},
	async rollback(ctx) {
		const target = ctx.memo.get("metroConfigPath") as string | undefined;
		const prev = ctx.memo.get("previousContents") as string | null;
		const mode = ctx.memo.get("mode") as string | undefined;
		if (!target) return;
		if (mode === "created") {
			// We made the file — delete it.
			try {
				rmSync(target);
			} catch {}
		} else if (prev !== null && prev !== undefined) {
			// We mutated an existing file — restore.
			writeFileSync(target, prev, "utf8");
		}
	},
};

// ── 4. useSnapTarget hook ────────────────────────────────────────────────

const HOOK_SOURCE = `import { useEffect, useRef } from "react";
import { registerSnapTarget } from "@unicorn-studio/snap-bridge";

/**
 * Wire a screen's content View into snap-bridge so Capture's full-page
 * snapshot covers the entire scrollable content (off-screen included).
 *
 * Usage:
 *   const ref = useSnapTarget();
 *   return (
 *     <ScrollView>
 *       <View ref={ref} collapsable={false}>{content}</View>
 *     </ScrollView>
 *   );
 */
export function useSnapTarget() {
	const ref = useRef(null);
	useEffect(() => {
		registerSnapTarget(ref);
		return () => registerSnapTarget(null);
	}, []);
	return ref;
}
`;

const writeUseSnapTargetHookStep: Step = {
	id: "writeUseSnapTargetHook",
	describe: () => "Writing hooks/useSnapTarget.ts",
	enabled: (plan) => plan.options.writeUseSnapTargetHook,
	async run(ctx) {
		if (!ctx.plan.fingerprint.picked) throw new Error("No RN app dir picked");
		const dir = join(ctx.plan.fingerprint.picked.rnAppDir, "hooks");
		const target = join(dir, "useSnapTarget.ts");
		ctx.memo.set("target", target);
		if (existsSync(target)) {
			ctx.memo.set("preExisting", true);
			return; // idempotent — leave existing file alone
		}
		mkdirSync(dir, { recursive: true });
		writeFileSync(target, HOOK_SOURCE, "utf8");
		ctx.memo.set("preExisting", false);
	},
	async rollback(ctx) {
		if (ctx.memo.get("preExisting")) return;
		const target = ctx.memo.get("target") as string | undefined;
		if (target && existsSync(target)) {
			try {
				rmSync(target);
			} catch {}
		}
	},
};

// ── 5. Run package install ──────────────────────────────────────────────

function spawnPm(args: {
	pm: "npm" | "pnpm" | "yarn" | "bun";
	cwd: string;
	subcommand: string;
	extraArgs: string[];
	signal: AbortSignal;
	onLine: (line: string) => void;
}): Promise<number> {
	return new Promise((resolve, reject) => {
		// `bun` doesn't have a separate "install" subcommand — `bun install`
		// works, plus alias `i`. The other three accept "install" universally.
		const child: ChildProcessWithoutNullStreams = spawn(
			args.pm,
			[args.subcommand, ...args.extraArgs],
			{
				cwd: args.cwd,
				env: getAugmentedSpawnEnv(),
			},
		);

		const handleData = (buf: Buffer) => {
			for (const line of buf.toString().split("\n")) {
				if (line.length > 0) args.onLine(line);
			}
		};
		child.stdout.on("data", handleData);
		child.stderr.on("data", handleData);
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));

		args.signal.addEventListener("abort", () => {
			try {
				child.kill();
			} catch {}
		});
	});
}

const runPackageInstallStep: Step = {
	id: "runPackageInstall",
	describe: (plan) =>
		`Running ${plan.fingerprint.packageManager} install`,
	enabled: (plan) => plan.options.runPackageInstall,
	async run(ctx) {
		const { packageManager } = ctx.plan.fingerprint;
		const cwd = ctx.plan.fingerprint.isMonorepo
			? ctx.plan.fingerprint.workspaceRoot
			: ctx.plan.fingerprint.picked!.rnAppDir;
		const code = await spawnPm({
			pm: packageManager,
			cwd,
			subcommand: "install",
			extraArgs: [],
			signal: ctx.signal,
			onLine: (line) => {
				ctx.emit("progress", line, { outputLine: line });
			},
		});
		if (code !== 0) {
			throw new Error(`${packageManager} install exited with code ${code}`);
		}
	},
	// No file rollback — re-running install with the original package.json
	// (which will be restored by addBridgeDep's rollback) brings the
	// node_modules back into a consistent state.
};

// ── 6. Install react-native-view-shot ───────────────────────────────────

const runViewShotInstallStep: Step = {
	id: "runViewShotInstall",
	describe: () => "Installing react-native-view-shot",
	enabled: (plan) =>
		plan.options.installViewShot && !plan.fingerprint.viewShot.installed,
	async run(ctx) {
		const { packageManager } = ctx.plan.fingerprint;
		const cwd = ctx.plan.fingerprint.picked!.rnAppDir;
		const subcommand = packageManager === "yarn" ? "add" : "install";
		const code = await spawnPm({
			pm: packageManager,
			cwd,
			subcommand,
			extraArgs: ["react-native-view-shot"],
			signal: ctx.signal,
			onLine: (line) => {
				ctx.emit("progress", line, { outputLine: line });
			},
		});
		if (code !== 0) {
			throw new Error(`view-shot install exited with code ${code}`);
		}
	},
};

// ── 7. Pod install ──────────────────────────────────────────────────────

const runPodInstallStep: Step = {
	id: "runPodInstall",
	describe: () => "Running pod install (iOS)",
	enabled: (plan) =>
		plan.options.runPodInstall &&
		plan.platform === "ios" &&
		plan.fingerprint.iosWorkspace.exists,
	async run(ctx) {
		const iosDir = join(ctx.plan.fingerprint.picked!.rnAppDir, "ios");
		await new Promise<void>((resolve) => {
			const child = spawn("pod", ["install"], { cwd: iosDir, env: getAugmentedSpawnEnv() });
			let stderr = "";
			child.stdout.on("data", (b: Buffer) => {
				const lines = b.toString().split("\n").filter(Boolean);
				for (const line of lines) ctx.emit("progress", line, { outputLine: line });
			});
			child.stderr.on("data", (b: Buffer) => {
				stderr += b.toString();
			});
			child.on("error", () => {
				// Best-effort: warn instead of failing — Expo prebuild handles
				// pods on next dev launch in most modern setups.
				ctx.emit("progress", `pod install not available — skipping (${stderr.trim()})`);
				resolve();
			});
			child.on("close", (code) => {
				if (code !== 0) {
					ctx.emit("progress", `pod install exited with ${code} — continuing (Expo will handle pods on first dev launch)`);
				}
				resolve();
			});
		});
	},
};

// ── 8. Patch _layout.tsx ────────────────────────────────────────────────

const patchLayoutStep: Step = {
	id: "patchLayout",
	describe: () => "Wiring installSnapBridge into your root _layout",
	async run(ctx) {
		const fp = ctx.plan.fingerprint;
		if (!fp.layoutFile.path) {
			const hint =
				fp.navLibrary === "react-navigation"
					? " This is a react-navigation app: call installSnapBridge(...) once at your app root and add useSnapAutoSync(navigationRef) from @unicorn-studio/snap-bridge/react-navigation."
					: " Call installSnapBridge(...) yourself at your app entry point.";
			ctx.emit(
				"progress",
				`No root _layout file detected — skipping auto-wire.${hint}`,
			);
			return;
		}
		// Idempotent: skip if already wired.
		if (fp.layoutFile.wiringState === "wired") {
			ctx.emit("progress", "_layout already wired — skipping");
			return;
		}
		const result = injectLayoutSnippet(fp.layoutFile.path, ctx.plan.slug);
		if (result.mode === "manual") {
			// Don't hard-fail. Persist the snippet to .unicorn/ for the user to
			// paste manually + surface a clear message in the UI.
			ctx.bag.layoutManualSnippet = result.snippet;
			ctx.bag.layoutManualReason = result.reason;
			ctx.emit(
				"progress",
				`Auto-wire couldn't pattern-match this layout (${result.reason}). Snippet saved to .unicorn/layout-snippet.txt — paste it into ${relative(fp.workspaceRoot, fp.layoutFile.path)}.`,
			);
			// Write the snippet file so it's available even after the wizard closes.
			try {
				const dir = join(fp.workspaceRoot, ".unicorn");
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "layout-snippet.txt"), result.snippet, "utf8");
			} catch {}
		} else if (result.mode === "injected") {
			ctx.memo.set("backupPath", result.backupPath);
			ctx.memo.set("layoutPath", fp.layoutFile.path);
		}
	},
	async rollback(ctx) {
		const backupPath = ctx.memo.get("backupPath") as string | undefined;
		const layoutPath = ctx.memo.get("layoutPath") as string | undefined;
		if (backupPath && layoutPath && existsSync(backupPath)) {
			try {
				const original = readFileSync(backupPath, "utf8");
				writeFileSync(layoutPath, original, "utf8");
				rmSync(backupPath);
			} catch {}
		}
	},
};

// ── 9. Run snap-flows-scan ──────────────────────────────────────────────

const runSnapFlowsScanStep: Step = {
	id: "runSnapFlowsScan",
	describe: () => "Generating snap-flows.ts from your routes",
	enabled: (plan) => plan.options.runSnapFlowsScan,
	async run(ctx) {
		const fp = ctx.plan.fingerprint;
		const rnAppDir = fp.picked!.rnAppDir;

		// snap-flows-scan walks an Expo Router `app/` route tree. A
		// react-navigation or home-rolled app has no such tree, so the scan
		// would exit 1 with "Could not find an Expo Router `app/` directory".
		// Skip it with a clear next-step instead of failing the whole install:
		// the react-navigation adapter (useSnapAutoSync) still feeds Capture
		// live routes, and snap-flows.ts can be authored by hand or grown from
		// captures via Improve.
		if (fp.navLibrary !== "expo-router") {
			const how =
				fp.navLibrary === "react-navigation"
					? "this app uses react-navigation — wire `useSnapAutoSync(navigationRef)` from `@unicorn-studio/snap-bridge/react-navigation`"
					: "this app has no Expo Router `app/` tree — push routes with `setSnapState` from your navigator";
			ctx.emit(
				"progress",
				`Skipping snap-flows-scan: ${how}. Routes still flow to Capture live; author snap-flows.ts by hand or grow it from captures via Improve.`,
			);
			return;
		}

		const localBin = join(rnAppDir, "node_modules", ".bin", "snap-flows-scan");
		const rootBin = join(
			fp.workspaceRoot,
			"node_modules",
			".bin",
			"snap-flows-scan",
		);
		const cmd = existsSync(localBin)
			? localBin
			: existsSync(rootBin)
				? rootBin
				: "npx";
		// If snap-flows.ts already exists (e.g. user ran Improve and refined
		// grouping via Claude Code, then re-runs the wizard), use --merge so
		// new routes get folded in without trashing the curated structure.
		const existingFlowsFile = join(rnAppDir, "snap-flows.ts");
		const hasExisting = existsSync(existingFlowsFile);
		const baseArgs = cmd === "npx"
			? ["-y", getSnapBridgeRef(), "snap-flows-scan"]
			: [];
		const args = hasExisting ? [...baseArgs, "--merge"] : baseArgs;
		if (hasExisting) {
			ctx.emit(
				"progress",
				"Existing snap-flows.ts found — using --merge to preserve curated grouping",
			);
		}

		await new Promise<void>((resolve, reject) => {
			const child = spawn(cmd, args, { cwd: rnAppDir, env: getAugmentedSpawnEnv() });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (b: Buffer) => {
				const txt = b.toString();
				stdout += txt;
				for (const line of txt.split("\n")) {
					if (line.length > 0) ctx.emit("progress", line, { outputLine: line });
				}
			});
			child.stderr.on("data", (b: Buffer) => {
				stderr += b.toString();
			});
			child.on("error", reject);
			child.on("close", (code) => {
				if (code !== 0) {
					reject(
						new Error(
							`snap-flows-scan exited with ${code}: ${stderr || stdout}`.trim(),
						),
					);
					return;
				}
				resolve();
			});
		});
	},
	// Don't rollback — snap-flows.ts is a regenerable artifact. If the user
	// re-runs the installer, the next scan overwrites it.
};

// ── 10. Persist + register ──────────────────────────────────────────────

const persistStep: Step = {
	id: "persist",
	describe: () => "Saving project locally",
	async run(ctx) {
		const fp = ctx.plan.fingerprint;
		const projectToken = ctx.bag.projectToken as string;
		const uploadUrl = `${ctx.plan.platformUrl.replace(/\/$/, "")}/api/captures/upload`;

		writeUnicornDir(fp.workspaceRoot, {
			slug: ctx.plan.slug,
			name: ctx.plan.name ?? ctx.plan.slug,
			platform: ctx.plan.platform,
			projectToken,
			uploadUrl,
			createdAt: new Date().toISOString(),
		});
		const path = registerWithCapture({
			slug: ctx.plan.slug,
			name: ctx.plan.name ?? ctx.plan.slug,
			platform: ctx.plan.platform,
			projectToken,
			uploadUrl,
			repoPath: fp.repoPath,
			rnAppDir: fp.picked?.rnAppDir,
			registeredAt: new Date().toISOString(),
		});
		ctx.emit("progress", `Wrote ${path}`);
		ctx.bag.uploadUrl = uploadUrl;
		ctx.bag.rnAppDir = fp.picked!.rnAppDir;
	},
	// Rollback removes the registry entry so a failed install doesn't leave
	// a stub project in the sidebar.
	async rollback(ctx) {
		try {
			const { removeCaptureProject } = await import("./init");
			removeCaptureProject(ctx.plan.slug);
		} catch {}
	},
};

// ── Assembly ─────────────────────────────────────────────────────────────

/**
 * The canonical step order. The verifier step is appended by the caller
 * after platformRegister has set the project token (so `verify` can
 * subscribe to the right slug). Verify lives in its own module
 * (`./verifier.ts`) because it spawns Expo and that's a separate concern.
 */
export function assembleCoreSteps(): Step[] {
	return [
		platformRegisterStep,
		addBridgeDepStep,
		writeMetroConfigStep,
		writeUseSnapTargetHookStep,
		runPackageInstallStep,
		runViewShotInstallStep,
		runPodInstallStep,
		runSnapFlowsScanStep,
		patchLayoutStep,
		persistStep,
	];
}
