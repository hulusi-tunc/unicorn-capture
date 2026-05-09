/**
 * Phase 4 of the new wizard: spawn the customer's RN app, watch for the
 * snap-bridge to connect with our slug, and confirm the bridge protocol
 * works end-to-end. Verify failure converts to a Doctor warning — never
 * hard-fails the install.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type { StepCtx, Step } from "./installer";
import type { SnapServer } from "./snap-server";

export interface VerifyResult {
	bridgeConnected: boolean;
	flowCount?: number;
	screenCount?: number;
	statePongMs?: number;
	fullPageReady?: boolean;
	notes: string[];
}

export function buildVerifyStep(snapServer: SnapServer): Step {
	return {
		id: "verify",
		describe: () => "Launching app + verifying bridge connects",
		enabled: (plan) => plan.options.verifyAfterInstall,
		async run(ctx) {
			const result = await verifyOnce({
				ctx,
				snapServer,
				timeoutMs: 90_000,
			});
			ctx.bag.verify = result;
			if (!result.bridgeConnected) {
				// Don't throw — a Verify miss is not a hard failure. The user
				// can still snap; we just couldn't auto-confirm. The
				// notes list explains what to check (Simulator booted? Metro
				// running? snap-bridge wired?).
				ctx.emit(
					"progress",
					`Verify warning: bridge didn't say hello in ${result.notes.join(" / ")}. Snap will work the moment your app launches; check the notes if it doesn't.`,
				);
			}
		},
		async rollback(ctx) {
			// Kill the spawned Expo if we started it.
			const child = ctx.memo.get("expoChild") as
				| ChildProcessWithoutNullStreams
				| undefined;
			if (child) {
				try {
					child.kill();
				} catch {}
			}
		},
	};
}

// ── Internals ────────────────────────────────────────────────────────────

async function verifyOnce(args: {
	ctx: StepCtx;
	snapServer: SnapServer;
	timeoutMs: number;
}): Promise<VerifyResult> {
	const { ctx, snapServer, timeoutMs } = args;
	const fp = ctx.plan.fingerprint;
	const slug = ctx.plan.slug;
	const notes: string[] = [];

	// Subscribe BEFORE spawning so we don't miss the hello if it arrives
	// quickly (some Expo dev servers reuse a warm bundle and connect
	// almost immediately).
	let bridgeConnected = false;
	let declaredFlowCount = 0;
	let declaredScreenCount = 0;
	const helloPromise = new Promise<void>((resolve) => {
		const unsubscribe = snapServer.onDeclaredFlows((projectId, decl) => {
			if (projectId !== slug) return;
			bridgeConnected = true;
			declaredFlowCount = decl.flows.length;
			declaredScreenCount = countScreens(decl.flows);
			unsubscribe();
			resolve();
		});
	});

	// Boot a simulator if iOS + none currently booted.
	if (ctx.plan.platform === "ios") {
		const booted = await isSimulatorBooted();
		if (!booted) {
			ctx.emit(
				"progress",
				"No iOS simulator booted — launching Simulator.app. If you keep one open, this is faster next time.",
			);
			try {
				spawn("open", ["-a", "Simulator"], { detached: true });
			} catch {}
		}
	}

	// Spawn `<pm> exec expo start --ios`. The user picked the package
	// manager during fingerprint; we honor it. `--ios` triggers Expo to
	// open the booted simulator with our app.
	const child = spawnExpo(ctx);
	ctx.memo.set("expoChild", child);

	// Race: hello arrives, OR our timeout fires.
	const timeoutPromise = new Promise<void>((resolve) => {
		setTimeout(resolve, timeoutMs);
	});
	await Promise.race([helloPromise, timeoutPromise]);

	if (!bridgeConnected) {
		if (ctx.plan.platform === "ios" && !(await isSimulatorBooted())) {
			notes.push("iOS simulator never booted — open Xcode > Window > Devices and Simulators, boot any iOS 16+ device, then re-run the wizard");
		} else {
			notes.push(
				`bridge didn't say hello within ${Math.round(timeoutMs / 1000)}s — your RN app may still be bundling, or installSnapBridge isn't being reached`,
			);
		}
		return { bridgeConnected: false, notes };
	}

	ctx.emit(
		"progress",
		`Bridge connected — ${declaredFlowCount} flows / ${declaredScreenCount} screens declared`,
	);

	// Once connected, ping state to confirm the bridge protocol is live.
	let statePongMs: number | undefined;
	try {
		const t0 = performance.now();
		await snapServer.requestState({ timeoutMs: 5000, projectId: slug });
		statePongMs = Math.round(performance.now() - t0);
		ctx.emit("progress", `State pong in ${statePongMs}ms`);
	} catch (err) {
		notes.push(
			`state ping failed: ${(err as Error)?.message ?? "timeout"}. Bridge connected but bidirectional protocol may be broken.`,
		);
	}

	// Try a full-page capture too — but its failure is informational, not
	// fatal. Most fresh installs won't have a SnapTarget registered yet.
	let fullPageReady = false;
	try {
		await snapServer.requestFullPageCapture({
			timeoutMs: 8000,
			projectId: slug,
		});
		fullPageReady = true;
	} catch {
		notes.push(
			"Full-page capture not yet wired — snap a screen first, then wrap your root ScrollView's content in a View with `useSnapTarget` to enable.",
		);
	}

	return {
		bridgeConnected: true,
		flowCount: declaredFlowCount,
		screenCount: declaredScreenCount,
		statePongMs,
		fullPageReady,
		notes,
	};
}

function spawnExpo(ctx: StepCtx): ChildProcessWithoutNullStreams {
	const fp = ctx.plan.fingerprint;
	const cwd = fp.picked!.rnAppDir;
	const pm = fp.packageManager;
	// Different package managers spell exec differently. `expo start --ios`
	// is what Expo wants; the package manager just needs to find the bin.
	const args = pm === "yarn" ? ["expo", "start", "--ios"] : ["exec", "expo", "start", "--ios"];
	if (pm !== "yarn" && !existsSync(`${cwd}/node_modules/.bin/expo`)) {
		// Fallback for projects that don't have expo locally installed.
		args.unshift("--yes");
	}

	const child = spawn(pm, args, {
		cwd,
		env: { ...process.env, CI: "1" }, // CI=1 keeps Expo from opening QR-code prompts
	});

	const handleData = (buf: Buffer) => {
		for (const line of buf.toString().split("\n")) {
			if (line.length === 0) continue;
			ctx.emit("progress", line, { outputLine: line });
		}
	};
	child.stdout.on("data", handleData);
	child.stderr.on("data", handleData);
	return child;
}

async function isSimulatorBooted(): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const child = spawn("xcrun", ["simctl", "list", "devices", "booted"]);
		let out = "";
		child.stdout.on("data", (b: Buffer) => {
			out += b.toString();
		});
		child.on("close", () => {
			resolve(out.includes("Booted"));
		});
		child.on("error", () => resolve(false));
	});
}

function countScreens(
	flows: ReadonlyArray<{
		screens?: ReadonlyArray<unknown>;
		flows?: ReadonlyArray<unknown>;
	}>,
): number {
	let n = 0;
	for (const f of flows) {
		n += f.screens?.length ?? 0;
		if (f.flows) {
			n += countScreens(
				f.flows as ReadonlyArray<{
					screens?: ReadonlyArray<unknown>;
					flows?: ReadonlyArray<unknown>;
				}>,
			);
		}
	}
	return n;
}
