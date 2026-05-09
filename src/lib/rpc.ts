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
 */
export interface RnSnapInfo {
	sessionId: string;
	sequence: number;
	projectId: string;
	route: string;
	navStack?: string[];
	stateHash: string;
	capturedAt: string;
	imagePath: string;
	uploaded?: { ok: true; buildId: string } | { ok: false; error: string };
	/** User-assigned sort position from drag-and-drop. Undefined = no override. */
	position?: number;
	/** Which flow this snap belongs to. Always set. */
	flowId: string;
}

export interface RnFlowScreen {
	declaredId: string;
	name: string;
	route: string;
	stateHash?: string;
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
				params: { projectSlug?: string };
				response:
					| {
							ok: true;
							snap: RnSnapInfo;
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
				};
			};
			deleteSnap: {
				params: { sessionId: string; sequence: number };
				response: { ok: true } | { ok: false; error: string };
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
			listProjects: {
				params: Record<string, never>;
				response: { projects: RnProjectInfo[] };
			};
			removeProject: {
				params: { slug: string };
				response: { ok: true } | { ok: false; error: string };
			};
			refreshProjectFlows: {
				params: { slug: string };
				response:
					| {
							ok: true;
							output: string;
							flowsFound?: number;
							screensFound?: number;
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
		};
		messages: {
			/**
			 * Streamed during the new wizard's Phase 3 install. Bun emits
			 * one event per step transition (`started` → optional
			 * `progress` lines → `succeeded`/`failed`/`rolled-back`).
			 * The view's stepper UI reads these in real time.
			 */
			onInitProgress: InstallProgressMessage;
		};
	};
	webview: {
		requests: Record<string, never>;
		messages: Record<string, never>;
	};
};
