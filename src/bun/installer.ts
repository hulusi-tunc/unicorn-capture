/**
 * Atomic, streamed installer for new-project onboarding.
 *
 * Replaces the monolithic `initProject` (kept around for back-compat) with
 * a list of named steps. Each step runs sequentially; on failure the
 * driver walks the completed-steps stack in reverse and calls
 * `rollback()` so the repo never lands in a half-installed state.
 *
 * Each transition is streamed through the new `onInitProgress` RPC
 * message so the wizard's Phase 3 UI can render live progress.
 */

import { randomUUID } from "node:crypto";
import type { InstallProgressMessage } from "../lib/rpc";
import type { RepoFingerprint } from "./repo-fingerprint";

// ── Public types ─────────────────────────────────────────────────────────

export interface InstallPlan {
	/** Slug for the new project (lowercase kebab-case). */
	slug: string;
	/** Optional human-readable name; falls back to slug. */
	name?: string;
	platform: "ios" | "android" | "web";
	/** Platform URL (https://your-gallery.example.com or http://localhost:3010). */
	platformUrl: string;
	/** Setup token for one-shot project creation, OR existing project token. */
	setupToken?: string;
	projectToken?: string;
	/**
	 * Signed-in user's Supabase access token. Preferred over setupToken so the
	 * created project is attributed + assigned to the creator (and thus appears
	 * in their Capture dashboard). Injected by the runInstaller RPC handler.
	 */
	accessToken?: string;
	/** Detected fingerprint from `fingerprintRepo()`. */
	fingerprint: RepoFingerprint;
	/** Toggles from the Plan UI. */
	options: {
		/** Run `<pm> install` after editing package.json. */
		runPackageInstall: boolean;
		/** Install react-native-view-shot if it isn't already present. */
		installViewShot: boolean;
		/** Run `pod install` (iOS only). */
		runPodInstall: boolean;
		/** Generate snap-flows.ts via the bridge CLI. */
		runSnapFlowsScan: boolean;
		/** Write hooks/useSnapTarget.ts. */
		writeUseSnapTargetHook: boolean;
		/** Auto-launch Expo + verify bridge connects. */
		verifyAfterInstall: boolean;
	};
}

export interface InstallOutcome {
	ok: boolean;
	error?: string;
	installId: string;
	completedSteps: string[];
	rolledBackSteps: string[];
	/** Set by the platformRegister step. */
	projectToken?: string;
	/** Set by the registerProject step. */
	registered?: { uploadUrl: string; rnAppDir: string };
	/** Set by the verify step. */
	verify?: {
		bridgeConnected: boolean;
		flowCount?: number;
		screenCount?: number;
		fullPageReady?: boolean;
		notes: string[];
	};
}

export type StepEmitFn = (
	phase: InstallProgressMessage["phase"],
	message: string,
	opts?: { progress?: number; outputLine?: string },
) => void;

export interface StepCtx {
	installId: string;
	plan: InstallPlan;
	/** Step-local key/value bag — e.g. previousRef so rollback can restore. */
	memo: Map<string, unknown>;
	/** Output of upstream steps, e.g. `platformRegister` writes the project token. */
	bag: Record<string, unknown>;
	emit: StepEmitFn;
	signal: AbortSignal;
}

export interface Step {
	id: string;
	/** One-line description for the Plan preview. */
	describe(plan: InstallPlan): string;
	/**
	 * Whether this step should run for the given plan. Default true. Used by
	 * optional steps (e.g. skip view-shot install when fingerprint already
	 * has it).
	 */
	enabled?(plan: InstallPlan): boolean;
	/** Do the work. Throw to fail; the driver catches and runs rollbacks. */
	run(ctx: StepCtx): Promise<void>;
	/** Best-effort undo. Driver swallows errors here so we always finish unwinding. */
	rollback?(ctx: StepCtx): Promise<void>;
}

// ── Driver ───────────────────────────────────────────────────────────────

export async function runInstaller(opts: {
	plan: InstallPlan;
	steps: Step[];
	send: (msg: InstallProgressMessage) => void;
	signal?: AbortSignal;
}): Promise<InstallOutcome> {
	const installId = randomUUID();
	const completed: { step: Step; ctx: StepCtx }[] = [];
	const completedIds: string[] = [];
	const bag: Record<string, unknown> = {};
	const signal = opts.signal ?? new AbortController().signal;
	const outcome: InstallOutcome = {
		ok: true,
		installId,
		completedSteps: [],
		rolledBackSteps: [],
	};

	for (const step of opts.steps) {
		if (step.enabled && !step.enabled(opts.plan)) {
			opts.send({
				installId,
				stepId: step.id,
				phase: "succeeded",
				message: `${step.describe(opts.plan)} (skipped)`,
			});
			continue;
		}

		const memo = new Map<string, unknown>();
		const ctx: StepCtx = {
			installId,
			plan: opts.plan,
			memo,
			bag,
			signal,
			emit: (phase, message, extra) => {
				opts.send({
					installId,
					stepId: step.id,
					phase,
					message,
					...(extra?.progress !== undefined ? { progress: extra.progress } : {}),
					...(extra?.outputLine !== undefined
						? { outputLine: extra.outputLine }
						: {}),
				});
			},
		};

		ctx.emit("started", step.describe(opts.plan));
		try {
			await step.run(ctx);
			ctx.emit("succeeded", `${step.describe(opts.plan)} ✓`);
			completed.push({ step, ctx });
			completedIds.push(step.id);
		} catch (err) {
			const message = (err as Error)?.message ?? String(err);
			ctx.emit("failed", `${step.describe(opts.plan)} — ${message}`);

			// Walk completed steps in reverse, calling rollback. Errors here
			// are swallowed (we still want to finish unwinding) but logged
			// through the same stream so the user can see what happened.
			for (let i = completed.length - 1; i >= 0; i--) {
				const entry = completed[i]!;
				if (!entry.step.rollback) continue;
				try {
					entry.ctx.emit(
						"rolled-back",
						`Rolling back ${entry.step.describe(opts.plan)}…`,
					);
					await entry.step.rollback(entry.ctx);
					outcome.rolledBackSteps.push(entry.step.id);
				} catch (rbErr) {
					entry.ctx.emit(
						"rolled-back",
						`Rollback failed for ${entry.step.id}: ${(rbErr as Error)?.message ?? rbErr}`,
					);
				}
			}

			outcome.ok = false;
			outcome.error = message;
			outcome.completedSteps = completedIds;
			return outcome;
		}
	}

	outcome.completedSteps = completedIds;
	// Pass step-side outputs back up to the caller.
	if (typeof bag.projectToken === "string") {
		outcome.projectToken = bag.projectToken;
	}
	if (typeof bag.uploadUrl === "string" && typeof bag.rnAppDir === "string") {
		outcome.registered = {
			uploadUrl: bag.uploadUrl,
			rnAppDir: bag.rnAppDir,
		};
	}
	if (
		bag.verify &&
		typeof bag.verify === "object" &&
		!Array.isArray(bag.verify)
	) {
		outcome.verify = bag.verify as InstallOutcome["verify"];
	}
	return outcome;
}
