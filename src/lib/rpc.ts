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
	sequence: number;
	projectId: string;
	route: string;
	navStack?: string[];
	stateHash: string;
	capturedAt: string;
	imagePath: string;
	uploaded?: { ok: true; buildId: string } | { ok: false; error: string };
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
					snaps: RnSnapInfo[];
				};
			};
			performSnap: {
				params: Record<string, never>;
				response: { ok: true; snap: RnSnapInfo } | { ok: false; error: string };
			};
			resetSnapSession: {
				params: Record<string, never>;
				response: { ok: true; sessionId: string };
			};
			pickRepoPath: {
				params: Record<string, never>;
				response: { ok: true; path: string } | { ok: false; error: string };
			};
			listProjects: {
				params: Record<string, never>;
				response: { projects: RnProjectInfo[] };
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
		messages: Record<string, never>;
	};
	webview: {
		requests: Record<string, never>;
		messages: Record<string, never>;
	};
};
