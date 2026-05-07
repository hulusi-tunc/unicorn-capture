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
		};
		messages: Record<string, never>;
	};
	webview: {
		requests: Record<string, never>;
		messages: Record<string, never>;
	};
};
