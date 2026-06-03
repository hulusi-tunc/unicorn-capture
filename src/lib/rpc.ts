import type { Device, Scenario } from "./schemas";

export type SourceInput =
	| { kind: "url"; url: string }
	| { kind: "folder"; path: string }
	| { kind: "archive"; path: string };

export interface StepResult {
	flowIdx: number;
	stepIdx: number;
	action: string;
	status: "passed" | "failed" | "skipped";
	screenshot?: string;
	error?: string;
	duration: number;
}

export interface FlowResult {
	flowIdx: number;
	name: string;
	status: "passed" | "failed" | "partial" | "running" | "pending";
	steps: StepResult[];
}

export interface RunResult {
	id: string;
	timestamp: string;
	duration: number;
	status: "completed" | "failed" | "partial";
	scenarioName: string;
	deviceName: string;
	baseUrl: string;
	flows: FlowResult[];
}

/**
 * Subset of SnapRecord that the view needs. Keep flat — RPC traverses JSON.
 * `imagePath` is an absolute path; the view loads it via file:// URL.
 * `remoteImageUrl` is set on snaps pulled from the gallery (sync-from-cloud)
 * — the view falls back to it when the local file isn't on disk yet.
 */
export interface RnSnapVersion {
	imagePath: string;
	remoteImageUrl?: string;
	capturedAt: string;
	navStack?: string[];
}

export interface RnSnapInfo {
	sessionId: string;
	sequence: number;
	projectId: string;
	route: string;
	/** User-renamed label shown on the card; falls back to `route` when unset. */
	displayName?: string;
	navStack?: string[];
	stateHash: string;
	capturedAt: string;
	imagePath: string;
	remoteImageUrl?: string;
	uploaded?:
		| { ok: true; buildId: string; uploadedAt?: string }
		| { ok: false; error: string; uploadedAt?: string };
	/** User-assigned sort position from drag-and-drop. Undefined = no override. */
	position?: number;
	/** Which flow this snap belongs to. Always set. */
	flowId: string;
	/**
	 * Past captures of this slot — populated by re-snapping the same
	 * (route, stateHash) more than once. Newest first. Length 0 means
	 * the slot has only ever been captured once.
	 */
	versions?: RnSnapVersion[];
	/**
	 * Web-only. True when the PNG is a full-page CDP capture (taller than
	 * the viewport). Library renders these as tall scrollable tiles.
	 */
	fullPage?: boolean;
}

export interface RnFlowScreen {
	declaredId: string;
	name: string;
	route: string;
	stateHash?: string;
	/** Soft-deleted in Capture UI — placeholder is suppressed. */
	hidden?: boolean;
}

export interface RnFlow {
	id: string;
	name: string;
	/** Slug of the project that owns this flow. */
	projectId: string;
	autoRoute?: string;
	parentFlowId?: string;
	/** Stable id from snap-flows.ts when the flow came from a declaration. */
	declaredId?: string;
	/** Expected screens, rendered as placeholders until snaps fill them. */
	screens?: RnFlowScreen[];
}

export interface RnProjectInfo {
	slug: string;
	name?: string;
	platform: string;
	projectToken: string;
	uploadUrl: string;
	repoPath?: string;
	rnAppDir?: string;
	registeredAt: string;
	/** Web-only: persisted base URL the iframe auto-loads on entry. */
	baseUrl?: string;
}

export interface RnInitStep {
	kind: "info" | "ok" | "warn" | "error";
	message: string;
}

/**
 * Result of `detectRepo` — a read-only snapshot of a repo's setup state
 * before the wizard touches anything. Drives the new wizard's Phase 1
 * "we found:" card and the Plan preview.
 */
export interface RepoFingerprint {
	repoPath: string;
	workspaceRoot: string;
	isMonorepo: boolean;
	packageManager: "npm" | "pnpm" | "yarn" | "bun";
	candidates: Array<{
		rnAppDir: string;
		relativeFromRepo: string;
		hasAppFolder: boolean;
		packageJsonName: string | null;
	}>;
	picked: {
		rnAppDir: string;
		relativeFromRepo: string;
		hasAppFolder: boolean;
		packageJsonName: string | null;
	} | null;
	pickedNotFoundReason?: string;
	rnLayout: "expo-router" | "rn-cli" | "expo-classic" | "unknown";
	navLibrary: "expo-router" | "react-navigation" | "unknown";
	snapBridge:
		| { state: "missing"; suggested: string }
		| { state: "floating"; current: string; suggested: string }
		| {
				state: "pinned";
				current: string;
				matchesSuggested: boolean;
				suggested: string;
		  };
	viewShot: { installed: boolean; podsInstalled: boolean };
	layoutFile: {
		path: string | null;
		wiringState: "absent" | "wired" | "ast-unsupported";
		componentShape:
			| "function-decl"
			| "memo-arrow"
			| "forwardRef"
			| "default-export-only"
			| "unknown";
	};
	flowsFile: { path: string | null; lastModified: string | null };
	hookFile: { path: string | null };
	iosWorkspace: { exists: boolean; podfileLockExists: boolean };
}

/**
 * One progress event in the new wizard's Phase 3 install stream. The bun
 * side emits these via `rpc.send.onInitProgress({...})`; the view side
 * subscribes via `electroview.rpc.on("onInitProgress", handler)`.
 *
 * `phase` lets the UI render the correct visual state without parsing
 * `message`. `progress` is an optional 0..1 indeterminate-or-determinate
 * hint for long ops (npm install, snap-flows-scan). `outputLine` carries
 * one line of subprocess stdout/stderr for the "View output" expander.
 */
export interface InstallProgressMessage {
	installId: string;
	stepId: string;
	phase: "started" | "progress" | "succeeded" | "failed" | "rolled-back";
	message: string;
	progress?: number;
	outputLine?: string;
}

/** Pushed bun→view once an update has been downloaded and is ready to apply. */
export interface UpdateReadyMessage {
	/** Version string from the freshly fetched update.json. */
	version: string;
	/** Content hash of the new build (what the updater compares on). */
	hash: string;
}

/**
 * Wire format for `runInstaller`. Carries the user's choices from the
 * Plan phase plus the fingerprint already gathered in the Detect phase
 * (re-using it instead of re-fingerprinting on submit). The bun-side
 * driver assembles steps + the verify step from this input.
 */
export interface InstallPlanInput {
	slug: string;
	name?: string;
	platform: "ios" | "android" | "web";
	platformUrl: string;
	setupToken?: string;
	projectToken?: string;
	fingerprint: RepoFingerprint;
	options: {
		runPackageInstall: boolean;
		installViewShot: boolean;
		runPodInstall: boolean;
		runSnapFlowsScan: boolean;
		writeUseSnapTargetHook: boolean;
		verifyAfterInstall: boolean;
	};
}

export interface InstallOutcomeWire {
	ok: boolean;
	error?: string;
	installId: string;
	completedSteps: string[];
	rolledBackSteps: string[];
	projectToken?: string;
	registered?: { uploadUrl: string; rnAppDir: string };
	verify?: {
		bridgeConnected: boolean;
		flowCount?: number;
		screenCount?: number;
		fullPageReady?: boolean;
		notes: string[];
	};
}

export interface RnInitOutcome {
	ok: boolean;
	error?: string;
	slug?: string;
	name?: string;
	platform?: string;
	projectToken?: string;
	uploadUrl?: string;
	workspaceRoot?: string;
	rnAppDir?: string;
	layoutPath?: string;
	layoutInjection?:
		| { mode: "injected"; backupPath: string }
		| { mode: "already" }
		| { mode: "manual"; snippet: string; reason: string };
	steps: RnInitStep[];
}

export type ScenarioRunnerRPC = {
	bun: {
		requests: {
			/** View asks bun to apply the downloaded update and relaunch. */
			applyUpdate: {
				params: Record<string, never>;
				response: { ok: boolean; error?: string };
			};
			/**
			 * View pulls any update that finished downloading before its RPC
			 * handler was live (the push is fire-once and unbuffered). Called
			 * once at view bootstrap so a won launch-race still shows the banner.
			 */
			getPendingUpdate: {
				params: Record<string, never>;
				response: { update: UpdateReadyMessage | null };
			};
			resolveSource: {
				params: SourceInput;
				response: {
					ok: boolean;
					baseUrl?: string;
					entry?: string;
					error?: string;
				};
			};
			cleanupSources: {
				params: Record<string, never>;
				response: { ok: boolean };
			};
			pickPath: {
				params: { kind: "local" };
				response: {
					ok: boolean;
					path?: string;
					inferredKind?: "folder" | "archive";
					error?: string;
				};
			};
			validateScenario: {
				params: { yaml: string };
				response: { ok: boolean; value?: Scenario; error?: string };
			};
			validateDevices: {
				params: { yaml: string };
				response: {
					ok: boolean;
					value?: { devices: Device[] };
					error?: string;
				};
			};
			captureRect: {
				params: {
					x: number;
					y: number;
					width: number;
					height: number;
					name: string;
				};
				response: { ok: boolean; path?: string; error?: string };
			};
			getConfig: {
				params: Record<string, never>;
				response: { devicesYaml: string; scenarioYaml: string };
			};
			snapServerStatus: {
				params: Record<string, never>;
				response: {
					port: number;
					clientCount: number;
					projects: string[];
					sessionId: string;
					pendingUploads: number;
					snaps: RnSnapInfo[];
					flows: RnFlow[];
				};
			};
			performSnap: {
				params: {
					projectSlug?: string;
					/**
					 * "auto" (default) — same (route, stateHash) slot replaces;
					 *   prior image goes to versions[]. Right model for redesigning
					 *   the same screen.
					 * "variant" — always create a NEW snap record even if a slot
					 *   match exists. Right model for capturing multiple frames of
					 *   the same long page (top/middle/bottom) or filter states.
					 */
					mode?: "auto" | "variant";
					/**
					 * When set, the snap is placed into this flow regardless of
					 * the route's auto-flow. Used by the "Capture into this flow"
					 * button in flow headers. Re-snap detection still runs but is
					 * scoped to the forced flow only — match → replace, else
					 * append a new card into the flow.
					 */
					forceFlowId?: string;
					/**
					 * When set, the snap REPLACES this specific record's image
					 * regardless of route/state. Used by the "Re-snap" button in
					 * the lightbox to update a focused screen. Wins over
					 * `forceFlowId` and `mode` if both are present.
					 */
					forceScreen?: { sessionId: string; sequence: number };
				};
				response:
					| {
							ok: true;
							snap: RnSnapInfo;
							/** "replaced" = same slot updated; "appended" = new card created (variant or first capture). */
							recordKind?: "replaced" | "appended";
							/** Where the snap landed in the flow tree + how (declared / auto). */
							placement?: {
								flowId: string;
								flowName: string;
								screenName?: string;
								kind: "declared-match" | "auto-existing" | "auto-new";
							};
							/** Which path produced the image: bridge full-page or simctl viewport. */
							captureMethod?: "full-page" | "simctl";
							/** Reason the bridge full-page path didn't run, when fallback to simctl happened. */
							captureNote?: string;
					  }
					| { ok: false; error: string };
			};
			uploadPending: {
				params: { force?: boolean };
				response: {
					ok: true;
					uploaded: number;
					failed: number;
					errors: string[];
				};
			};
			pushAll: {
				params: { projectSlug?: string; message?: string };
				response: {
					synced: number;
					failed: number;
					errors: string[];
					/**
					 * Per-image entries for screenshots that couldn't be
					 * uploaded because the local PNG was missing or
					 * unreadable on disk. Surfaces in the post-push
					 * summary modal so the user can see what didn't make
					 * it instead of silently dropping records.
					 */
					skipped: Array<{
						projectId: string;
						image: string;
						reason: "missing-file" | "read-error" | "too-large";
						bytes?: number;
					}>;
				};
			};
			/**
			 * Force-evict the local PNG cache for a project's pushed
			 * snaps, ignoring the 7-day grace window. Intended for the
			 * "Clear pushed snaps" settings button when the user wants
			 * to reclaim disk now. Snaps that have not been pushed (no
			 * `remoteImageUrl`) are left alone so nothing is lost.
			 */
			clearPushedSnaps: {
				params: { projectSlug?: string };
				response: {
					ok: true;
					deleted: number;
					freedBytes: number;
				};
			};
			/**
			 * Pull frames + flow tree from the gallery for a project and import
			 * them as remote-only snaps (no local PNG download). Used to restore
			 * a project on a fresh PC, or after disk loss.
			 */
			syncFromGallery: {
				params: { projectSlug: string };
				response:
					| {
							ok: true;
							flowsAdded: number;
							flowsRemoved: number;
							framesAdded: number;
							framesSkipped: number;
					  }
					| { ok: false; error: string };
			};
			deleteSnap: {
				params: { sessionId: string; sequence: number };
				response: { ok: true } | { ok: false; error: string };
			};
			deleteSnapVersion: {
				params: {
					sessionId: string;
					sequence: number;
					/** 0 = current, 1+ = entries from versions[] (newest-first). */
					versionIdx: number;
				};
				response:
					| {
							ok: true;
							/** "deleted" = whole snap gone (last version standing). */
							outcome: "deleted" | "version-removed" | "promoted";
					  }
					| { ok: false; error: string };
			};
			reorderSnaps: {
				params: {
					flowId: string;
					ordered: Array<{ sessionId: string; sequence: number }>;
				};
				response: { ok: true };
			};
			createFlow: {
				params: {
					name: string;
					projectId: string;
					parentFlowId?: string;
				};
				response: { ok: true; flow: RnFlow };
			};
			renameFlow: {
				params: { flowId: string; name: string };
				response: { ok: true } | { ok: false; error: string };
			};
			reparentFlow: {
				params: { flowId: string; newParentId?: string };
				response: { ok: true } | { ok: false; error: string };
			};
			renameScreen: {
				params: { flowId: string; declaredId: string; name: string };
				response: { ok: true } | { ok: false; error: string };
			};
			hideScreen: {
				params: { flowId: string; declaredId: string };
				response: { ok: true } | { ok: false; error: string };
			};
			renameSnap: {
				params: { sessionId: string; sequence: number; name: string };
				response: { ok: true } | { ok: false; error: string };
			};
			moveSnapsToFlow: {
				params: {
					snapIds: Array<{ sessionId: string; sequence: number }>;
					toFlowId: string;
				};
				response: { ok: true; moved: number };
			};
			deleteFlow: {
				params: { flowId: string };
				response: { ok: true } | { ok: false; error: string };
			};
			reorderFlows: {
				params: { orderedIds: string[] };
				response: { ok: true };
			};
			resetSnapSession: {
				params: Record<string, never>;
				response: { ok: true; sessionId: string };
			};
			mirrorSimulator: {
				params: Record<string, never>;
				response:
					| { ok: true; pngBase64: string }
					| { ok: false; error: string };
			};
			forwardTap: {
				params: {
					mirrorX: number;
					mirrorY: number;
					mirrorWidth: number;
					mirrorHeight: number;
				};
				response: { ok: true } | { ok: false; error: string };
			};
			pickRepoPath: {
				params: Record<string, never>;
				response: { ok: true; path: string } | { ok: false; error: string };
			};
			detectRepo: {
				params: { repoPath: string };
				response:
					| { ok: true; fingerprint: RepoFingerprint }
					| { ok: false; error: string };
			};
			runInstaller: {
				params: { plan: InstallPlanInput };
				response: InstallOutcomeWire;
			};
			improveSnapFlows: {
				params: { slug: string };
				response:
					| {
							ok: true;
							clipboardPayload: string;
							flowsFilePath: string;
							summary: string;
					  }
					| { ok: false; error: string };
			};
			listProjects: {
				params: Record<string, never>;
				response: { projects: RnProjectInfo[] };
			};
			removeProject: {
				params: { slug: string };
				response: { ok: true } | { ok: false; error: string };
			};
			refreshProjectFlows: {
				params: { slug: string; mode?: "merge" | "regenerate" };
				response:
					| {
							ok: true;
							output: string;
							flowsFound?: number;
							screensFound?: number;
							mode: "merge" | "regenerate";
					  }
					| { ok: false; error: string };
			};
			wrapScreenForFullPage: {
				params: {
					slug: string;
					route: string;
					/** "wrap" enables full-page on this route; "unwrap" reverts. */
					mode: "wrap" | "unwrap";
				};
				response:
					| { ok: true; output: string }
					| { ok: false; error: string };
			};
			runDoctor: {
				params: { slug: string };
				response:
					| {
							ok: true;
							report: {
								slug: string;
								repoPath: string;
								rnAppDir: string | null;
								bridgeConnected: boolean;
								snapBridgePinned: string | null;
								snapBridgeSuggested: string;
								checks: Array<{
									id: string;
									label: string;
									status: "ok" | "warn" | "error";
									detail: string;
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
										target?: string;
									};
								}>;
								summary: { ok: number; warn: number; error: number };
							};
					  }
					| { ok: false; error: string };
			};
			doctorAutoFix: {
				params: {
					slug: string;
					kind:
						| "bump-snap-bridge"
						| "regenerate-flows"
						| "merge-flows"
						| "install-view-shot"
						| "boot-simulator"
						| "launch-expo"
						| "reconnect-bridge";
				};
				response: { ok: true; output: string } | { ok: false; error: string };
			};
			/**
			 * Standalone "Launch Expo" — spawn `<pm> expo start` in the
			 * project's RN app dir. Detached so killing Capture doesn't
			 * kill Expo. Same RPC the Doctor panel's launch-expo fix
			 * uses; exposed separately so a project-card "Launch" button
			 * can call it directly.
			 */
			launchExpo: {
				params: { slug: string };
				response: { ok: true; output: string } | { ok: false; error: string };
			};
			/**
			 * Force-close every connected bridge socket. The bridge's
			 * onclose handler triggers its 3s auto-reconnect, so within
			 * a few seconds the bridge is back with a fresh hello.
			 * Surfaced as "Reconnect" in the Doctor panel.
			 */
			reconnectBridge: {
				params: Record<string, never>;
				response: { ok: true };
			};
			/**
			 * Open Simulator.app. macOS-only. Equivalent to clicking the
			 * dock icon — restores the last-used device.
			 */
			bootSimulator: {
				params: Record<string, never>;
				response: { ok: true; output: string } | { ok: false; error: string };
			};
			/**
			 * Poll the current bridge route for the topbar live indicator.
			 * Returns null when no bridge is connected for the project.
			 * Cheap, designed to be called every 2s while a project is
			 * open and the bridge is connected.
			 */
			getBridgeRoute: {
				params: { projectSlug: string };
				response: {
					ok: true;
					route: string | null;
					stateHash?: string;
				};
			};
			/**
			 * Run a one-click tour over every declared screen in a
			 * project: navigate → wait for ready → snap → repeat. Returns
			 * the per-screen result so the summary modal can show what
			 * succeeded vs. failed. Blocks until the whole tour finishes
			 * (or a step errors past timeout).
			 */
			runProjectTour: {
				params: { projectSlug: string };
				response:
					| {
							ok: true;
							total: number;
							succeeded: number;
							failed: number;
							visits: Array<{
								flowName: string;
								screenName: string;
								route: string;
								ok: boolean;
								error?: string;
							}>;
					  }
					| { ok: false; error: string };
			};
			initProject: {
				params: {
					repoPath: string;
					slug: string;
					name?: string;
					platform: "ios" | "android" | "web";
					platformUrl: string;
					setupToken?: string;
					token?: string;
				};
				response: RnInitOutcome;
			};
			/**
			 * Web-only equivalent of `initProject`. No bridge install, no
			 * Metro patching — just register a project on the gallery so
			 * snaps can be pushed to it, and persist the entry locally with
			 * its `baseUrl` so the iframe knows where to load when the user
			 * re-enters the project.
			 */
			createWebProject: {
				params: {
					name: string;
					slug?: string;
					baseUrl: string;
					platformUrl: string;
					setupToken: string;
					/**
					 * Optional seed flows produced by `discoverWebRoutes`
					 * + auto-grouping. When set, the orchestrator
					 * pre-creates these flows so the project's sidebar
					 * shows a populated tree before the first snap. Same
					 * shape as applyFlowGrouping so the path-prefix
					 * helper can be reused on the view side.
					 */
					seedFlows?: Array<{ id: string; name: string; routes: string[] }>;
				};
				response:
					| {
							ok: true;
							slug: string;
							projectToken: string;
							restored?: boolean;
							reused?: boolean;
							seededFlows?: number;
					  }
					| { ok: false; error: string };
			};
			/**
			 * Record a snap captured from the web mode iframe. Mirrors the
			 * mobile snap pipeline (auto-flow from path prefix, sequence
			 * numbering, placement reporting) — minus the bridge state +
			 * simctl half, since web captures come pre-rendered from
			 * `captureRect`.
			 */
			performWebSnap: {
				params: {
					slug: string;
					url: string;
					tempImagePath: string;
					title?: string;
				};
				response:
					| {
							ok: true;
							snap: RnSnapInfo;
							route: string;
							placement: {
								flowId: string;
								flowName: string;
								screenName?: string;
								kind: "auto-existing" | "auto-new";
							};
					  }
					| { ok: false; error: string };
			};
			/**
			 * Apply a Claude-improved flow grouping to a project. Used by
			 * both mobile + web Improve flows after the user pastes
			 * Claude's JSON back into Capture. Backend updates the
			 * orchestrator's manifest in one transaction so the view's
			 * next listProjects/snapServerStatus reflects the new tree.
			 */
			applyFlowGrouping: {
				params: {
					slug: string;
					groups: Array<{ id: string; name: string; routes: string[] }>;
				};
				response:
					| { ok: true; flowsApplied: number; snapsMoved: number }
					| { ok: false; error: string };
			};
			/**
			 * Diff the gallery's project list against the local registry and
			 * archive any gallery-only entries. Used to reconcile after
			 * test/duplicate projects pile up on the platform during
			 * onboarding. Returns the list of slugs that were archived (so
			 * the UI can confirm) and any errors per-slug.
			 *
			 * `mode: "preview"` returns the diff WITHOUT archiving, so the
			 * UI can show a confirm step before the destructive action.
			 */
			/**
			 * Crawl a web base URL to discover internal routes. Used by the
			 * web wizard's Phase 2 to give the user a preview of what
			 * flows will get auto-created before they commit. Bun-side
			 * fetch (no CORS), parses <a href> + canonical/og link tags,
			 * follows same-origin links one level deep. Returns absolute
			 * paths relative to the base URL's pathname. Best-effort:
			 * SPAs without server-rendered links return just "/". User
			 * always has the option to skip discovery and start with a
			 * blank flow tree.
			 */
			discoverWebRoutes: {
				params: {
					baseUrl: string;
					/** Max routes to return — defaults to 50 so the UI stays usable. */
					limit?: number;
				};
				response:
					| {
							ok: true;
							baseUrl: string;
							routes: Array<{ path: string; title?: string }>;
							/** Routes that were skipped (off-origin, hash-only, etc.) for transparency. */
							skipped: number;
							/** "html" / "spa" — if just "/" was found and the page looks SPA-y, hint at that. */
							hint: "ok" | "spa" | "auth-wall" | "blocked";
					  }
					| { ok: false; error: string };
			};
			cleanupUnsyncedProjects: {
				params: {
					platformUrl: string;
					setupToken: string;
					platform?: "web" | "ios" | "android";
					mode: "preview" | "archive";
				};
				response:
					| {
							ok: true;
							galleryOnly: Array<{ slug: string; name: string; platform: string }>;
							archived: string[];
							errors: Array<{ slug: string; error: string }>;
					  }
					| { ok: false; error: string };
			};
		};
		messages: {
			/**
			 * Streamed during the new wizard's Phase 3 install. Bun emits
			 * one event per step transition (`started` → optional
			 * `progress` lines → `succeeded`/`failed`/`rolled-back`).
			 * The view's stepper UI reads these in real time.
			 */
			onInitProgress: InstallProgressMessage;
			/** Pushed once a downloaded update is ready; view shows the restart banner. */
			onUpdateReady: UpdateReadyMessage;
		};
	};
	webview: {
		requests: Record<string, never>;
		messages: Record<string, never>;
	};
};
