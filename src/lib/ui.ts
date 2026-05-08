// Single source for UI strings, defaults — no magic strings/numbers in components.

export const UI = {
	app: { name: "Prisma", tagline: "Visual flow testing & macro recorder" },
	source: {
		kinds: [
			{
				key: "url",
				label: "URL",
				icon: "🔗",
				placeholder: "https://… or /local/path",
			},
			{
				key: "local",
				label: "Local",
				icon: "📁",
				placeholder: "Drop folder or archive (.zip / .tar.gz)",
			},
			{
				key: "iossim",
				label: "iOS Sim",
				icon: "📱",
				placeholder: "Capture from a running iOS Simulator + snap-bridge",
			},
		] as const,
		archiveExts: [".zip", ".tar", ".tar.gz", ".tgz"] as const,
	},
	rn: {
		title: "iOS Simulator",
		bridge: {
			waiting: "Waiting for snap-bridge to connect…",
			connected: "Bridge connected",
			noBridge:
				"No snap-bridge connected. In your RN app's root layout, install @unicorn-studio/snap-bridge and call installSnapBridge({projectId}) once. Then setSnapState({route, navStack}) on every nav change.",
		},
		snap: {
			button: "📸 Snap",
			busy: "Capturing…",
			emptyHint:
				"Press the button (or Cmd+Shift+S) to capture the current screen.",
		},
		recent: { title: "This session", empty: "No snaps yet — try one!" },
	},
	views: [
		{ key: "steps", label: "Steps" },
		{ key: "results-a", label: "Grid", needsRun: true },
		{ key: "results-b", label: "Timeline", needsRun: true },
	] as const,
	actions: {
		run: "▶ Run",
		stop: "■ Stop",
		record: "● Record",
		pause: "⏸ Pause",
		resume: "▶ Resume",
		reload: "↻",
		export: "Export YAML",
		import: "Import YAML",
		newScenario: "+ New",
		newFlow: "+ Flow",
		newStep: "+ Step",
		clear: "Clear",
		dup: "Dup",
		del: "Del",
		moveUp: "↑",
		moveDown: "↓",
		theme: "◐",
		openTimeline: "Open as timeline →",
	},
	labels: {
		source: "Source",
		device: "Device",
		scenarios: "Scenarios",
		flows: "Flows",
		steps: "Steps",
		log: "Log",
		liveAt: "Live @",
		idle: "Idle",
		noSource: "no source loaded",
		noActivity: "No activity yet",
		empty: {
			source: "Load a source (URL, folder, or archive) to start.",
			recordHint: "Click <b>Record</b> to capture user flows.",
			noFlow: "No flow selected",
			noSteps:
				"No steps yet. Click <b>Record</b> in the preview, or add steps manually.",
			noRun: "No run yet",
		},
		entryArrow: "↳",
		clickToBrowse: "or click to browse",
		defaultShots: "Default screenshots",
		fullTimeline: "Show full timeline",
		processing: "Processing…",
	},
	defaults: {
		framePx: { width: 1440, height: 900 },
		stepTimeoutMs: 5000,
		stepRunTimeoutMs: 30000,
		recordTypeDebounceMs: 400,
		recordWaitThresholdMs: 300,
		recordWaitMaxMs: 5000,
		recordWaitRoundMs: 100,
		urlPollMs: 250,
		runnerReadyTimeoutMs: 5000,
		logHistory: 200,
		previewPad: 48,
	},
	logLevels: ["info", "success", "error", "warn"] as const,
} as const;

export type SourceKind = (typeof UI.source.kinds)[number]["key"];
export type ViewKey = (typeof UI.views)[number]["key"];
export type LogLevel = (typeof UI.logLevels)[number];

const THEME_KEY = "prisma:theme";
export type Theme = "light" | "dark";

export const theme = {
	get(): Theme {
		try {
			const stored = localStorage.getItem(THEME_KEY) as Theme | null;
			if (stored === "light" || stored === "dark") return stored;
		} catch {}
		return matchMedia?.("(prefers-color-scheme: light)").matches
			? "light"
			: "dark";
	},
	set(t: Theme): void {
		try {
			localStorage.setItem(THEME_KEY, t);
		} catch {}
		document.documentElement.dataset.theme = t;
	},
	toggle(): Theme {
		const next: Theme = theme.get() === "dark" ? "light" : "dark";
		theme.set(next);
		return next;
	},
	init(): void {
		theme.set(theme.get());
	},
};
