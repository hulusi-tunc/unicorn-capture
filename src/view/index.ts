import { Electroview } from "electrobun/view";
import type {
	FlowResult,
	RnFlow,
	RnInitOutcome,
	RnInitStep,
	RnProjectInfo,
	RnSnapInfo,
	RunResult,
	ScenarioRunnerRPC,
	SourceInput,
	StepResult,
} from "../lib/rpc";
import {
	ACTION_SPEC,
	type ActionType,
	type Device,
	type FlowStep,
	type Scenario,
	validateDeviceConfig,
	validateScenario,
} from "../lib/schemas";
import { Store } from "../lib/store";
import {
	type LogLevel,
	type SourceKind,
	theme,
	UI,
	type ViewKey,
} from "../lib/ui";

// ─── HELPERS ───
const esc = (s: any): string =>
	String(s ?? "").replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			]!,
	);
const $ = <T extends HTMLElement = HTMLElement>(
	sel: string,
	root: ParentNode = document,
) => root.querySelector<T>(sel);
const $$ = <T extends HTMLElement = HTMLElement>(
	sel: string,
	root: ParentNode = document,
) => Array.from(root.querySelectorAll<T>(sel));

// ─── STATE ───
interface AppState {
	source: { kind: SourceKind; url: string; path: string };
	baseUrl: string | null;
	entry: string | null;
	devices: Device[];
	deviceIdx: number;
	scenarios: Scenario[];
	scenarioIdx: number;
	currentFlowIdx: number;
	recording: "idle" | "recording" | "paused";
	view: ViewKey;
	run: RunResult | null;
	progress: { flowIdx: number; pct: number; label: string }[];
	logs: { msg: string; level: LogLevel }[];
	timelineFlow: number;
	timelineCollapsed: Set<string>;
	timelineFull: boolean;
	error: string | null;
	expanded: Set<string>; // step uids that are expanded in editor
	customViewport: { width: number; height: number } | null;
	projectKey: string | null;
	rn: {
		clientCount: number;
		projects: string[];
		sessionId: string;
		snaps: RnSnapInfo[];
		flows: RnFlow[];
		pendingUploads: number;
		pushing: boolean; // upload-pending in flight
		busy: boolean;
		error: string | null;
		selectedIdx: number; // index into snaps[] for the focused thumbnail
		registry: RnProjectInfo[]; // known projects from ~/Library/.../projects.json
		/**
		 * Slug of the project the user is currently focused on. The grid
		 * filters its snaps + flows to this project. Null = show every
		 * project's snaps mixed together (only useful for debugging).
		 */
		selectedProjectSlug: string | null;
		wizard: WizardState;
	};
}

interface WizardState {
	open: boolean;
	repoPath: string;
	slug: string;
	name: string;
	platformUrl: string;
	platform: "ios" | "android" | "web";
	setupToken: string;
	busy: boolean;
	error: string | null;
	steps: RnInitStep[];
	manualSnippet: string | null;
}

function freshWizardState(): WizardState {
	return {
		open: false,
		repoPath: "",
		slug: "",
		name: "",
		platformUrl: "http://localhost:3010",
		platform: "ios",
		setupToken: "",
		busy: false,
		error: null,
		steps: [],
		manualSnippet: null,
	};
}

interface ProjectState {
	scenarios: Scenario[];
	scenarioIdx: number;
	currentFlowIdx: number;
	deviceIdx: number;
}

function projectKey(input: SourceInput): string {
	return input.kind === "url" ? `url:${input.url}` : `path:${input.path}`;
}
function loadProject(key: string): ProjectState | null {
	try {
		const raw = localStorage.getItem(`prisma:project:${key}`);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}
function saveProject(key: string, data: ProjectState): void {
	try {
		localStorage.setItem(`prisma:project:${key}`, JSON.stringify(data));
	} catch {}
}

// step uid: scenarioIdx-flowIdx-stepIdx — recomputed each render, no leak on schema
const stepUid = (si: number, fi: number, sti: number) => `${si}/${fi}/${sti}`;

const state = new Store<AppState>({
	source: { kind: "local", url: "", path: "" },
	baseUrl: null,
	entry: null,
	devices: [],
	deviceIdx: 0,
	scenarios: [],
	scenarioIdx: 0,
	currentFlowIdx: 0,
	recording: "idle",
	view: "steps",
	run: null,
	progress: [],
	logs: [],
	timelineFlow: 0,
	timelineCollapsed: new Set(),
	timelineFull: true,
	error: null,
	expanded: new Set(),
	customViewport: null,
	projectKey: null,
	rn: {
		clientCount: 0,
		projects: [],
		sessionId: "",
		snaps: [],
		flows: [],
		pendingUploads: 0,
		pushing: false,
		busy: false,
		error: null,
		selectedIdx: -1,
		registry: [],
		selectedProjectSlug: null,
		wizard: freshWizardState(),
	},
});

// Auto-save scenarios+device per source when projectKey is set.
let lastSaved = "";
state.subscribe((s) => {
	if (!s.projectKey) return;
	const snap: ProjectState = {
		scenarios: s.scenarios,
		scenarioIdx: s.scenarioIdx,
		currentFlowIdx: s.currentFlowIdx,
		deviceIdx: s.deviceIdx,
	};
	const enc = JSON.stringify(snap);
	if (enc !== lastSaved) {
		lastSaved = enc;
		saveProject(s.projectKey, snap);
	}
});

const currentScenario = () => state.get().scenarios[state.get().scenarioIdx];
const currentFlow = () => currentScenario()?.flows[state.get().currentFlowIdx];

const log = (msg: string, level: LogLevel = "info") => {
	state.set((s) => ({
		...s,
		logs: [...s.logs.slice(-(UI.defaults.logHistory - 1)), { msg, level }],
	}));
	showToast(msg, level);
};

/**
 * Bottom-right toast for log events. RN view doesn't render the inspector
 * log panel that the old scenario-runner UI has, so this is how the user
 * sees background activity (refresh-flows results, push outcomes, etc.).
 * Errors stick longer and stay until manually dismissed.
 */
let toastContainer: HTMLDivElement | null = null;
function showToast(msg: string, level: LogLevel): void {
	if (typeof document === "undefined") return;
	if (!toastContainer) {
		toastContainer = document.createElement("div");
		toastContainer.className = "rn-toast-stack";
		document.body.appendChild(toastContainer);
	}
	const toast = document.createElement("div");
	toast.className = `rn-toast rn-toast-${level}`;
	toast.textContent = msg;
	const closeBtn = document.createElement("button");
	closeBtn.className = "rn-toast-close";
	closeBtn.type = "button";
	closeBtn.textContent = "×";
	closeBtn.setAttribute("aria-label", "Dismiss");
	toast.appendChild(closeBtn);
	toastContainer.appendChild(toast);
	const dismiss = () => {
		toast.classList.add("rn-toast-leaving");
		setTimeout(() => toast.remove(), 220);
	};
	closeBtn.addEventListener("click", dismiss);
	const ttl = level === "error" ? 8000 : level === "warn" ? 6000 : 3500;
	setTimeout(dismiss, ttl);
}

// ─── RPC ───
// 10 min timeout — covers user-interactive RPCs (file picker), source extraction, full runs.
const rpc = Electroview.defineRPC<ScenarioRunnerRPC>({
	maxRequestTime: 600000,
	handlers: { requests: {}, messages: {} },
});
const electroview = new Electroview({ rpc });
const req = (electroview.rpc as any).request;

// ─── ATOMS (template fns, no inline styles) ───
const _cls = (...xs: (string | false | undefined | null)[]) =>
	xs.filter(Boolean).join(" ");

const tabs = (
	items: { key: string; label: string; disabled?: boolean }[],
	active: string,
	attr: string,
) =>
	`<div class="tabs">${items
		.map(
			(i) =>
				`<button class="tab ${active === i.key ? "active" : ""}" ${attr}="${i.key}" ${i.disabled ? "disabled" : ""}>${esc(i.label)}</button>`,
		)
		.join("")}</div>`;

type SectionAction = { label: string; act: string; title?: string };
const sectionHeader = (
	title: string,
	actions?: SectionAction[] | SectionAction,
) => {
	const list: SectionAction[] = Array.isArray(actions)
		? actions
		: actions
			? [actions]
			: [];
	return `
	<div class="section-title row">
		<span>${esc(title)}</span>
		<span class="row" style="gap:4px">
			${list.map((a) => `<button class="btn btn-ghost btn-sm" data-act="${a.act}"${a.title ? ` title="${esc(a.title)}"` : ""}>${esc(a.label)}</button>`).join("")}
		</span>
	</div>`;
};

const libraryItem = (
	active: boolean,
	name: string,
	count: string,
	attr: string,
	val: string | number,
) => `
	<div class="library-item ${active ? "active" : ""}" ${attr}="${val}">
		<span class="name">${esc(name)}</span>
		<span class="count">${esc(count)}</span>
	</div>`;

const empty = (icon: string | null, body: string) => `
	<div class="empty">
		${icon ? `<div class="empty-icon">${icon}</div>` : ""}
		<div class="empty-text">${body}</div>
	</div>`;

const banner = (kind: "success" | "error" | "warn", msg: string) =>
	`<div class="banner ${kind} mt-2">${esc(msg)}</div>`;

const dot = (status: string) => `<span class="dot ${status}"></span>`;

const stepThumb = (label: string, src?: string) => `
	<div class="step-thumb">
		${src ? `<img src="file://${esc(src)}" alt="${esc(label)}">` : `<span>${esc(label)}</span>`}
	</div>`;

// ─── HEADER ───
function renderHeader(): string {
	const s = state.get();
	const canRun =
		!!s.baseUrl && !!s.devices.length && (currentFlow()?.steps.length ?? 0) > 0;
	return `
		<header class="header">
			<h1><img src="logo.svg" class="brand-mark" alt=""><span class="brand-wordmark">${esc(UI.app.name)}</span></h1>
			<div class="header-actions">
				<button class="btn btn-ghost btn-icon btn-sm" data-act="theme" title="Toggle theme">${UI.actions.theme}</button>
				<button class="btn btn-primary" data-act="run" ${canRun ? "" : "disabled"}>${UI.actions.run}</button>
			</div>
		</header>`;
}

// ─── SIDEBAR ───
function renderSidebar(): string {
	const s = state.get();
	const sc = currentScenario();
	return `
		<aside class="sidebar">
			<div class="scrollable">
				<div class="section">
					${sectionHeader(UI.labels.source)}
					${tabs(
						UI.source.kinds.map((k) => ({ key: k.key, label: k.label })),
						s.source.kind,
						"data-src-tab",
					)}
					${s.source.kind === "url" ? renderUrlInput(s.source.url) : renderDropzone(s.source.kind, s.source.path)}
					${s.entry ? `<div class="entry-point">${UI.labels.entryArrow} ${esc(s.entry)}</div>` : ""}
					${s.baseUrl ? banner("success", `${UI.labels.liveAt} ${s.baseUrl}`) : ""}
					${s.error ? banner("error", s.error) : ""}
				</div>

				<div class="section">
					${sectionHeader(UI.labels.device)}
					${renderDeviceSelect(s.devices, s.deviceIdx)}
				</div>

				<div class="section">
					${sectionHeader(UI.labels.scenarios, [
						{ label: "↑", act: "import-yaml", title: "Import YAML" },
						{ label: "↓", act: "export-yaml", title: "Export YAML" },
						{ label: UI.actions.newScenario, act: "add-scenario" },
					])}
					${s.scenarios.map((sc, i) => libraryItem(i === s.scenarioIdx, sc.name, `${sc.flows.length} flow${sc.flows.length === 1 ? "" : "s"}`, "data-scenario-idx", i)).join("")}
				</div>

				${
					sc
						? `
					<div class="section">
						${sectionHeader(UI.labels.flows, { label: UI.actions.newFlow, act: "add-flow" })}
						<div class="field">
							<input class="input" type="text" data-scenario-name value="${esc(sc.name)}" placeholder="Scenario name">
						</div>
						${sc.flows.map((f, i) => libraryItem(i === s.currentFlowIdx, f.name, `${f.steps.length} step${f.steps.length === 1 ? "" : "s"}`, "data-side-flow-idx", i)).join("")}
					</div>
				`
						: ""
				}
			</div>
		</aside>`;
}

const renderUrlInput = (val: string) => `
	<div class="field">
		<input class="input" type="url" placeholder="${esc(UI.source.kinds[0].placeholder)}" data-src-url value="${esc(val)}">
	</div>
	<button class="btn btn-secondary block" data-act="src-load">Load URL</button>`;

const renderDropzone = (kind: SourceKind, path: string) => {
	const meta = UI.source.kinds.find((k) => k.key === kind)!;
	return `
	<div class="dropzone" data-src-drop data-src-kind="${kind}">
		<div class="dropzone-icon">${meta.icon}</div>
		<div class="dropzone-text">${esc(meta.placeholder)}</div>
		<div class="dropzone-hint">${path ? esc(path) : esc(UI.labels.clickToBrowse)}</div>
	</div>`;
};

function renderDeviceSelect(devices: Device[], idx: number): string {
	if (!devices.length)
		return `<select class="select" disabled><option>${UI.labels.processing}</option></select>`;
	const groups = new Map<string, { d: Device; i: number }[]>();
	devices.forEach((d, i) => {
		const cat = d.category || "other";
		if (!groups.has(cat)) groups.set(cat, []);
		groups.get(cat)!.push({ d, i });
	});
	const order = [
		"mobile-small",
		"mobile",
		"mobile-large",
		"foldable-folded",
		"foldable-open",
		"tablet-small",
		"tablet",
		"laptop",
		"desktop",
		"ultrawide",
		"other",
		"custom",
	];
	return `<select class="select" data-device>${order
		.filter((c) => groups.has(c))
		.map(
			(cat) =>
				`<optgroup label="${esc(cat)}">${groups
					.get(cat)!
					.map(
						({ d, i }) =>
							`<option value="${i}" ${i === idx ? "selected" : ""}>${esc(d.name)} · ${d.viewport.width}×${d.viewport.height}</option>`,
					)
					.join("")}</optgroup>`,
		)
		.join("")}</select>`;
}

// ─── PREVIEW (stable shell — iframe never re-rendered) ───
function buildPreviewShell(): string {
	return `
		<section class="workspace">
			<div class="preview-bar" id="preview-bar"></div>
			<div class="preview-frame-wrap" id="preview-stage">
				<div class="ruler-corner"></div>
				<div class="ruler ruler-top" id="ruler-top"></div>
				<div class="ruler ruler-left" id="ruler-left"></div>
				<div class="preview-content" id="preview-content">
					<div id="preview-rec-indicator" class="hidden rec-indicator">REC</div>
					<div id="preview-empty" class="empty">
						<div class="empty-icon">🎬</div>
						<div class="empty-text">${UI.labels.empty.source}<br>${UI.labels.empty.recordHint}</div>
					</div>
					<div id="preview-viewport" class="hidden viewport">
						<iframe id="preview-iframe"></iframe>
					</div>
				</div>
			</div>
			<div class="preview-footer" id="preview-footer"></div>
		</section>`;
}

function renderPreviewBar(): void {
	const s = state.get();
	// Use root path "/" for default index entries — SPA routers (expo-router, react-router, etc.)
	// often have route tables that don't include /index.html. The static-server resolves "/" → index.html.
	const usesRoot = !s.entry || /^index\.html?$/i.test(s.entry);
	const url = s.baseUrl
		? usesRoot
			? `${s.baseUrl}/`
			: `${s.baseUrl}/${s.entry}`
		: "";
	const dev = s.devices[s.deviceIdx];
	const vp = s.customViewport || dev?.viewport || UI.defaults.framePx;
	const bar = $("#preview-bar");
	if (!bar) return;
	const recBadge =
		s.recording === "recording"
			? `<span class="rec-pill rec-on">● REC</span>`
			: s.recording === "paused"
				? `<span class="rec-pill rec-pause">⏸ PAUSED</span>`
				: "";
	bar.innerHTML = `
		<button class="btn btn-ghost btn-sm" data-act="reload-preview" ${s.baseUrl ? "" : "disabled"}>${UI.actions.reload}</button>
		<div class="preview-url">${esc(url || UI.labels.noSource)}</div>
		${recBadge}
		<span class="toolbar-meta">${vp.width}×${vp.height}</span>`;
	bar
		.querySelector("[data-act=reload-preview]")
		?.addEventListener("click", reloadPreview);
}

function syncPreviewIframe(): void {
	const s = state.get();
	// Use root path "/" for default index entries — SPA routers (expo-router, react-router, etc.)
	// often have route tables that don't include /index.html. The static-server resolves "/" → index.html.
	const usesRoot = !s.entry || /^index\.html?$/i.test(s.entry);
	const url = s.baseUrl
		? usesRoot
			? `${s.baseUrl}/`
			: `${s.baseUrl}/${s.entry}`
		: "";
	const f = $<HTMLIFrameElement>("#preview-iframe");
	const vpEl = $<HTMLElement>("#preview-viewport");
	const emptyEl = $<HTMLElement>("#preview-empty");
	const recInd = $<HTMLElement>("#preview-rec-indicator");
	if (!f || !vpEl || !emptyEl || !recInd) return;

	if (url) {
		emptyEl.classList.add("hidden");
		vpEl.classList.remove("hidden");
		const dev = s.devices[s.deviceIdx];
		const vp = s.customViewport || dev?.viewport || UI.defaults.framePx;
		vpEl.style.width = `${vp.width}px`;
		vpEl.style.height = `${vp.height}px`;
		if (f.dataset.url !== url) {
			f.src = url;
			f.dataset.url = url;
		}
	} else {
		emptyEl.classList.remove("hidden");
		vpEl.classList.add("hidden");
	}
	recInd.classList.toggle("hidden", s.recording !== "recording");
	fitViewport();
}

function renderPreviewFooter(): void {
	const s = state.get();
	const f = $("#preview-footer");
	if (!f) return;
	f.innerHTML = s.progress.length
		? `<div class="progress">${s.progress
				.map(
					(p) => `
			<div class="progress-row">
				<span class="progress-name">${esc(p.label)}</span>
				<span class="progress-pct">${p.pct}%</span>
				<div class="progress-bar"><div class="progress-fill" style="width:${p.pct}%"></div></div>
			</div>
		`,
				)
				.join("")}</div>`
		: `<div class="muted-center">${UI.labels.idle}</div>`;
}

// ─── INSPECTOR ───
function renderInspector(): string {
	const s = state.get();
	const tabsItems = UI.views.map((v) => ({
		key: v.key,
		label: v.label,
		disabled: !!(v as any).needsRun && !s.run,
	}));
	return `
		<aside class="inspector">
			${tabs(tabsItems, s.view, "data-view")}
			<div class="inspector-body">
				${s.view === "steps" ? renderStepEditor() : s.view === "results-a" ? renderResultsA() : renderResultsB()}
			</div>
			<div class="splitter h" data-split="inspector-log"></div>
			${renderLogPanel()}
		</aside>`;
}

function renderRecorderBar(): string {
	const s = state.get();
	const ready = !!s.baseUrl;
	if (s.recording === "recording") {
		return `
			<div class="recorder-bar recording">
				<button class="btn btn-secondary btn-sm" data-act="rec-pause">${UI.actions.pause}</button>
				<button class="btn btn-danger-solid btn-sm" data-act="rec-stop">${UI.actions.stop}</button>
				<span class="rec-status"><span class="dot running"></span>Recording — click in preview</span>
			</div>`;
	}
	if (s.recording === "paused") {
		return `
			<div class="recorder-bar paused">
				<button class="btn btn-primary btn-sm" data-act="rec-resume">${UI.actions.resume}</button>
				<button class="btn btn-danger-solid btn-sm" data-act="rec-stop">${UI.actions.stop}</button>
				<span class="rec-status"><span class="dot pending"></span>Paused — replay or edit steps</span>
			</div>`;
	}
	return `
		<div class="recorder-bar idle">
			<button class="btn btn-primary btn-sm" data-act="rec-start" ${ready ? "" : "disabled"}>${UI.actions.record}</button>
			<span class="rec-status">${ready ? "Ready" : "Load a source first"}</span>
		</div>`;
}

function renderStepEditor(): string {
	const sc = currentScenario();
	const flow = currentFlow();
	const scenarioShots = sc?.takeScreenshots ?? true;

	if (!sc) {
		return `
			${renderRecorderBar()}
			<div class="editor-head">
				<button class="btn btn-primary btn-sm" data-act="add-scenario">${esc(UI.actions.newScenario)} scenario</button>
			</div>
			${empty(null, "No scenarios yet — create one or click Record to start.")}`;
	}
	if (!flow) {
		return `
			${renderRecorderBar()}
			<div class="editor-head">
				<button class="btn btn-primary btn-sm" data-act="add-flow">${esc(UI.actions.newFlow)}</button>
			</div>
			${empty(null, `${UI.labels.empty.noFlow} — add a flow or click Record.`)}`;
	}

	return `
		${renderRecorderBar()}
		<div class="editor-head">
			<input class="input mb-2" type="text" data-flow-name value="${esc(flow.name)}" placeholder="Flow name">
			<div class="row">
				<button class="btn btn-ghost btn-sm" data-act="add-step">${esc(UI.actions.newStep)}</button>
				<button class="btn btn-ghost btn-sm" data-act="clear-flow">${esc(UI.actions.clear)}</button>
				<label class="checkbox-label ml-auto">
					<input type="checkbox" data-scenario-shots ${scenarioShots ? "checked" : ""}>
					${esc(UI.labels.defaultShots)}
				</label>
			</div>
		</div>
		<div class="steps-list">
			${
				flow.steps.length === 0
					? empty(null, UI.labels.empty.noSteps)
					: flow.steps
							.map((step, i) =>
								renderStepRow(step, i, flow.steps.length, scenarioShots),
							)
							.join("")
			}
		</div>`;
}

function renderStepRow(
	step: FlowStep,
	idx: number,
	total: number,
	scenarioShots: boolean,
): string {
	const s = state.get();
	const uid = stepUid(s.scenarioIdx, s.currentFlowIdx, idx);
	const expanded = s.expanded.has(uid);
	// screenshot logic: explicit flag wins; else inherit scenarioShots; screenshot action always shoots
	const shotOn =
		step.action === "screenshot" || ((step as any).screenshot ?? scenarioShots);
	const detail = stepDetail(step);
	const spec = ACTION_SPEC[step.action as ActionType];

	return `
		<div class="step-row ${expanded ? "expanded" : ""}" data-step-idx="${idx}">
			<div class="step-row-head" data-act="toggle-step">
				<span class="step-row-num">${idx + 1}</span>
				<span class="step-row-action">${esc(step.action)}</span>
				<span class="step-row-detail">${esc(detail)}</span>
				<span class="step-row-shot ${shotOn ? "on" : ""}" title="Screenshot on/off" data-act="toggle-shot">📸</span>
			</div>
			<div class="step-row-body">
				<div class="step-row-grid">
					<label>Action</label>
					<select class="input" data-field="action">
						${Object.keys(ACTION_SPEC)
							.map(
								(a) =>
									`<option value="${a}" ${step.action === a ? "selected" : ""}>${a}</option>`,
							)
							.join("")}
					</select>
					${(spec?.fields || []).map((f) => fieldRow(f, step)).join("")}
				</div>
				<div class="step-row-actions">
					<button class="btn btn-ghost btn-sm" data-act="step-up" ${idx === 0 ? "disabled" : ""}>${UI.actions.moveUp}</button>
					<button class="btn btn-ghost btn-sm" data-act="step-down" ${idx === total - 1 ? "disabled" : ""}>${UI.actions.moveDown}</button>
					<button class="btn btn-ghost btn-sm" data-act="step-dup">${UI.actions.dup}</button>
					<button class="btn btn-ghost btn-sm btn-danger" data-act="step-del">${UI.actions.del}</button>
				</div>
			</div>
		</div>`;
}

const FIELD_META: Record<
	string,
	{ label: string; type?: string; ph?: string }
> = {
	selector: { label: "Selector", ph: "CSS selector" },
	url: { label: "URL", ph: "/path or https://…" },
	value: { label: "Value", ph: "text" },
	ms: { label: "Wait ms", type: "number", ph: "0" },
	delay: { label: "Delay ms", type: "number", ph: "0" },
	timeout: {
		label: "Timeout",
		type: "number",
		ph: String(UI.defaults.stepTimeoutMs),
	},
	script: { label: "Script", ph: "JS expression" },
	name: { label: "Name", ph: "step name" },
	x: { label: "X", type: "number", ph: "0" },
	y: { label: "Y", type: "number", ph: "0" },
	waitUntil: { label: "Wait until", ph: "load|networkidle" },
	fullPage: { label: "Full page", ph: "true|false" },
};

function fieldRow(field: string, step: any): string {
	const m = FIELD_META[field];
	if (!m) return "";
	const v = step[field] ?? "";
	return `
		<label>${m.label}</label>
		<input class="input" ${m.type ? `type="${m.type}"` : ""} data-field="${field}" value="${esc(v)}" placeholder="${esc(m.ph || "")}">`;
}

function stepDetail(step: FlowStep): string {
	switch (step.action) {
		case "navigate":
			return step.url || "";
		case "type":
			return `${step.selector || ""} ← "${step.value || ""}"`;
		case "wait":
			return step.ms ? `${step.ms}ms` : step.selector || "";
		case "evaluate":
			return step.script || "";
		default:
			return step.selector || "";
	}
}

// ─── RESULTS GRID (Layout A) ───
function renderResultsA(): string {
	const run = state.get().run;
	if (!run) return empty(null, UI.labels.empty.noRun);
	return `
		<div class="layout-a">
			${run.flows
				.map(
					(f) => `
				<div class="flow-row">
					<div class="flow-meta">
						<div class="flow-name">${esc(f.name)}</div>
						<div class="flow-stats">
							<span class="flow-stat">${dot(f.status === "passed" ? "passed" : f.status === "failed" ? "failed" : "skipped")}${f.status}</span>
							<span class="flow-stat">${f.steps.length} steps</span>
						</div>
						<button class="btn btn-ghost btn-sm" data-act="open-timeline" data-grid-flow-idx="${f.flowIdx}">${esc(UI.actions.openTimeline)}</button>
					</div>
					<div class="flow-steps">
						${f.steps.map((st) => renderStepCard(st)).join("")}
					</div>
				</div>
			`,
				)
				.join("")}
		</div>`;
}

function renderStepCard(st: StepResult): string {
	return `
		<div class="step-card" title="${esc(st.error || st.action)}">
			${stepThumb(st.action, st.screenshot)}
			<div class="step-info">
				<div class="step-action">${dot(st.status)}${esc(st.action)}</div>
				<div class="step-label">#${st.stepIdx + 1} · ${st.duration}ms</div>
			</div>
		</div>`;
}

// ─── RESULTS TIMELINE (Layout B) ───
function renderResultsB(): string {
	const s = state.get();
	if (!s.run) return empty(null, UI.labels.empty.noRun);
	const flow = s.run.flows[s.timelineFlow] || s.run.flows[0];
	if (!flow) return empty(null, "No flow");
	return `
		<div class="timeline-head">
			<select class="select" data-timeline-flow>
				${s.run.flows.map((f, i) => `<option value="${i}" ${i === s.timelineFlow ? "selected" : ""}>${esc(f.name)}</option>`).join("")}
			</select>
			<label class="checkbox-label">
				<input type="checkbox" data-timeline-full ${s.timelineFull ? "checked" : ""}>
				${esc(UI.labels.fullTimeline)}
			</label>
		</div>
		<div class="layout-b">${renderChain(flow, s.timelineCollapsed, s.timelineFull)}</div>`;
}

function renderChain(
	flow: FlowResult,
	collapsed: Set<string>,
	full: boolean,
): string {
	if (!flow.steps.length) return empty(null, UI.labels.empty.noSteps);
	const walk = (i: number): string => {
		if (i >= flow.steps.length) return "";
		const st = flow.steps[i];
		const id = `${flow.flowIdx}-${i}`;
		const isC = collapsed.has(id);
		const showChild = full || !isC;
		const hasChild = i + 1 < flow.steps.length;
		return `
			<div class="tree-node ${isC && !full ? "tree-collapsed" : ""}">
				<div class="tree-card" data-tree-id="${id}">
					<div class="tree-card-head">
						${dot(st.status)}
						<span class="idx">#${st.stepIdx + 1}</span>
						<span class="act">${esc(st.action)}</span>
					</div>
					${stepThumb(st.action, st.screenshot)}
					<div class="tree-card-foot">
						<span>${st.duration}ms</span>
						${hasChild ? `<button class="tree-collapse" data-act="tree-collapse" data-id="${id}">${isC ? "▼" : "▲"}</button>` : ""}
					</div>
				</div>
				${showChild && hasChild ? `<div class="tree-edge"></div><div class="tree-children">${walk(i + 1)}</div>` : ""}
			</div>`;
	};
	return `<div class="tree">${walk(0)}</div>`;
}

// ─── LOG PANEL ───
function renderLogPanel(): string {
	const logs = state.get().logs;
	return `
		<div class="log-panel">
			<div class="section-title">${UI.labels.log}</div>
			<div class="log">
				${
					logs.length
						? logs
								.slice(-100)
								.map(
									(l) => `<div class="log-line ${l.level}">${esc(l.msg)}</div>`,
								)
								.join("")
						: `<div class="log-empty">${UI.labels.noActivity}</div>`
				}
			</div>
		</div>`;
}

// ─── RENDER (targeted, NOT a full page wipe) ───
let initialized = false;

function render(): void {
	const s = state.get();
	const inIosSim = s.source.kind === "iossim";

	// iossim lives in its own persistent #rn-root tree. Toggle visibility
	// instead of rebuilding — listeners stay alive across mode switches.
	ensureRnMounted();
	setRnVisible(inIosSim);
	setAppVisible(!inIosSim);
	if (inIosSim) {
		applyRnState(s);
		return;
	}

	if (!initialized) {
		const root = $("#app")!;
		root.innerHTML = `${renderHeader()}<div class="layout">${renderSidebar()}<div class="splitter" data-split="sidebar-preview"></div>${buildPreviewShell()}<div class="splitter" data-split="preview-inspector"></div>${renderInspector()}</div>`;
		initialized = true;
	} else {
		// Replace only header, sidebar, inspector — preview iframe stays mounted.
		const layout = $(".layout");
		if (!layout) return;
		const sidebar = layout.querySelector(".sidebar");
		const inspector = layout.querySelector(".inspector");
		const newHeader = $(".header");
		if (newHeader) newHeader.outerHTML = renderHeader();
		if (sidebar) sidebar.outerHTML = renderSidebar();
		if (inspector) inspector.outerHTML = renderInspector();
	}
	renderPreviewBar();
	renderPreviewFooter();
	syncPreviewIframe();
	bindEvents();
	applyPaneSizes();
	bindSplitters();
}

// ─── EVENTS ───
function bindEvents(): void {
	// Header
	$("[data-act=run]")?.addEventListener("click", handleRun);
	$("[data-act=export-yaml]")?.addEventListener("click", handleExport);
	$("[data-act=import-yaml]")?.addEventListener("click", handleImport);
	$("[data-act=rec-start]")?.addEventListener("click", startRecording);
	$("[data-act=rec-pause]")?.addEventListener("click", pauseRecording);
	$("[data-act=rec-resume]")?.addEventListener("click", resumeRecording);
	$("[data-act=rec-stop]")?.addEventListener("click", stopRecording);
	$("[data-act=theme]")?.addEventListener("click", () => {
		theme.toggle();
	});

	// Source tabs
	$$("[data-src-tab]").forEach((el) =>
		el.addEventListener("click", () => {
			state.set((s) => ({
				...s,
				source: {
					...s.source,
					kind: el.getAttribute("data-src-tab") as SourceKind,
				},
				error: null,
			}));
		}),
	);
	$<HTMLInputElement>("[data-src-url]")?.addEventListener("change", (e) => {
		state.set((s) => ({
			...s,
			source: { ...s.source, url: (e.target as HTMLInputElement).value },
		}));
	});
	$("[data-act=src-load]")?.addEventListener("click", () => {
		const raw = state.get().source.url.trim();
		log(`Load URL clicked: "${raw}"`);
		if (!raw) {
			log("Empty URL — nothing to load", "warn");
			return;
		}
		if (/^https?:\/\//i.test(raw)) {
			loadSource({ kind: "url", url: raw });
			return;
		}
		const path = raw.startsWith("file://") ? raw.slice(7) : raw;
		if (path.startsWith("/") || /^[A-Za-z]:\\/.test(path)) {
			const kind = inferLocalKind(path);
			loadSource({ kind, path });
			return;
		}
		loadSource({ kind: "url", url: raw });
	});

	const dropzone = $("[data-src-drop]");
	if (dropzone) {
		dropzone.addEventListener("dragover", (e) => {
			e.preventDefault();
			dropzone.classList.add("drag-over");
		});
		dropzone.addEventListener("dragleave", () =>
			dropzone.classList.remove("drag-over"),
		);
		dropzone.addEventListener("drop", async (e: any) => {
			e.preventDefault();
			dropzone.classList.remove("drag-over");
			const files: FileList | undefined = e.dataTransfer?.files;
			log(`drop: ${files?.length ?? 0} item(s)`);
			if (!files?.length) return;
			const f0 = files[0] as any;
			const p = f0?.path as string | undefined;
			log(
				`drop[0]: name=${f0.name} path=${p ? p : "(missing)"} type=${f0.type || "(none)"}`,
			);
			if (!p) {
				log(
					"WebKit drop event has no path — opening native picker as fallback.",
					"warn",
				);
				const r = await req.pickPath({ kind: "local" });
				if (!r.ok) {
					if (r.error && r.error !== "Canceled") state.set({ error: r.error });
					return;
				}
				const inferred: "folder" | "archive" = r.inferredKind || "folder";
				state.set((st) => ({
					...st,
					source: { ...st.source, path: r.path! },
					error: null,
				}));
				await loadSource({ kind: inferred, path: r.path! });
				return;
			}
			handleFiles(files);
		});
		// Click → native picker — accepts BOTH folders and archives, server infers kind from extension.
		dropzone.addEventListener("click", async () => {
			log("Dropzone click → opening native picker…");
			try {
				const r = await req.pickPath({ kind: "local" });
				log(
					`pickPath → ok=${r.ok}, path=${r.path ?? "—"}, inferred=${r.inferredKind ?? "—"}, error=${r.error ?? "—"}`,
				);
				if (!r.ok) {
					if (r.error && r.error !== "Canceled") {
						state.set({ error: r.error });
						log(`Picker error: ${r.error}`, "error");
					} else {
						log("Picker canceled");
					}
					return;
				}
				const inferred: "folder" | "archive" = r.inferredKind || "folder";
				state.set((st) => ({
					...st,
					source: { ...st.source, path: r.path! },
					error: null,
				}));
				await loadSource({ kind: inferred, path: r.path! });
			} catch (e: any) {
				log(`Picker exception: ${e?.message || e}`, "error");
			}
		});
	}

	$<HTMLSelectElement>("[data-device]")?.addEventListener("change", (e) => {
		state.set({
			deviceIdx: parseInt((e.target as HTMLSelectElement).value, 10),
			customViewport: null,
		});
	});

	// Sidebar library — distinct attr
	$$("[data-scenario-idx]").forEach((el) =>
		el.addEventListener("click", () => {
			state.set({
				scenarioIdx: parseInt(el.getAttribute("data-scenario-idx")!, 10),
				currentFlowIdx: 0,
			});
		}),
	);
	$$("[data-side-flow-idx]").forEach((el) =>
		el.addEventListener("click", () => {
			state.set({
				currentFlowIdx: parseInt(el.getAttribute("data-side-flow-idx")!, 10),
			});
		}),
	);

	$("[data-act=add-scenario]")?.addEventListener("click", () => {
		state.set((s) => ({
			...s,
			scenarios: [
				...s.scenarios,
				{
					name: `Scenario ${s.scenarios.length + 1}`,
					takeScreenshots: true,
					flows: [{ name: "Flow 1", steps: [] }],
				},
			],
			scenarioIdx: s.scenarios.length,
			currentFlowIdx: 0,
		}));
	});
	$("[data-act=add-flow]")?.addEventListener("click", () => {
		mutateScenario((sc) => {
			sc.flows.push({ name: `Flow ${sc.flows.length + 1}`, steps: [] });
		});
		state.set({ currentFlowIdx: currentScenario().flows.length - 1 });
	});
	$<HTMLInputElement>("[data-scenario-name]")?.addEventListener(
		"change",
		(e) => {
			mutateScenario((sc) => {
				sc.name = (e.target as HTMLInputElement).value || "Untitled";
			});
		},
	);

	// Inspector tabs
	$$("[data-view]").forEach((el) =>
		el.addEventListener("click", () => {
			state.set({ view: el.getAttribute("data-view") as ViewKey });
		}),
	);

	// Step editor
	$<HTMLInputElement>("[data-flow-name]")?.addEventListener("change", (e) => {
		mutateFlow((f) => {
			f.name = (e.target as HTMLInputElement).value || "Untitled";
		});
	});
	$<HTMLInputElement>("[data-scenario-shots]")?.addEventListener(
		"change",
		(e) => {
			mutateScenario((sc) => {
				sc.takeScreenshots = (e.target as HTMLInputElement).checked;
			});
		},
	);
	$("[data-act=add-step]")?.addEventListener("click", () =>
		mutateFlow((f) => f.steps.push({ action: "click", selector: "" })),
	);
	$("[data-act=clear-flow]")?.addEventListener("click", () => {
		if (confirm("Clear all steps in this flow?"))
			mutateFlow((f) => {
				f.steps = [];
			});
	});

	$$("[data-step-idx]").forEach((row) => {
		const idx = parseInt(row.getAttribute("data-step-idx")!, 10);
		const s = state.get();
		const uid = stepUid(s.scenarioIdx, s.currentFlowIdx, idx);

		row
			.querySelector("[data-act=toggle-step]")
			?.addEventListener("click", (e) => {
				if ((e.target as HTMLElement).closest("[data-act=toggle-shot]")) return;
				state.set((st) => {
					const next = new Set(st.expanded);
					next.has(uid) ? next.delete(uid) : next.add(uid);
					return { ...st, expanded: next };
				});
			});
		row
			.querySelector("[data-act=toggle-shot]")
			?.addEventListener("click", (e) => {
				e.stopPropagation();
				mutateFlow((f) => {
					const sc = currentScenario();
					const def = sc.takeScreenshots ?? true;
					const cur = (f.steps[idx] as any).screenshot ?? def;
					(f.steps[idx] as any).screenshot = !cur;
				});
			});
		row.querySelector("[data-act=step-up]")?.addEventListener("click", () =>
			mutateFlow((f) => {
				if (idx > 0)
					[f.steps[idx - 1], f.steps[idx]] = [f.steps[idx], f.steps[idx - 1]];
			}),
		);
		row.querySelector("[data-act=step-down]")?.addEventListener("click", () =>
			mutateFlow((f) => {
				if (idx < f.steps.length - 1)
					[f.steps[idx + 1], f.steps[idx]] = [f.steps[idx], f.steps[idx + 1]];
			}),
		);
		row.querySelector("[data-act=step-dup]")?.addEventListener("click", () =>
			mutateFlow((f) => {
				f.steps.splice(idx + 1, 0, JSON.parse(JSON.stringify(f.steps[idx])));
			}),
		);
		row.querySelector("[data-act=step-del]")?.addEventListener("click", () =>
			mutateFlow((f) => {
				f.steps.splice(idx, 1);
			}),
		);

		row
			.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field]")
			.forEach((inp) => {
				inp.addEventListener("change", () => {
					const field = inp.getAttribute("data-field")!;
					mutateFlow((f) => {
						const step = f.steps[idx] as any;
						const v = inp.value;
						if (["ms", "timeout", "delay", "x", "y"].includes(field))
							step[field] = v ? Number(v) : undefined;
						else step[field] = v || undefined;
					});
				});
			});
	});

	// Timeline (Layout B)
	$<HTMLSelectElement>("[data-timeline-flow]")?.addEventListener(
		"change",
		(e) => {
			state.set({
				timelineFlow: parseInt((e.target as HTMLSelectElement).value, 10),
			});
		},
	);
	$<HTMLInputElement>("[data-timeline-full]")?.addEventListener(
		"change",
		(e) => {
			state.set({ timelineFull: (e.target as HTMLInputElement).checked });
		},
	);
	$$("[data-act=tree-collapse]").forEach((el) =>
		el.addEventListener("click", (e) => {
			e.stopPropagation();
			const id = el.getAttribute("data-id")!;
			state.set((s) => {
				const next = new Set(s.timelineCollapsed);
				next.has(id) ? next.delete(id) : next.add(id);
				return { ...s, timelineCollapsed: next };
			});
		}),
	);
	// Grid → open as timeline (distinct attr from sidebar flow list)
	$$("[data-act=open-timeline]").forEach((el) =>
		el.addEventListener("click", () => {
			state.set({
				view: "results-b",
				timelineFlow: parseInt(el.getAttribute("data-grid-flow-idx")!, 10),
			});
		}),
	);
}

// ─── MUTATIONS ───
function mutateScenario(fn: (sc: Scenario) => void) {
	const s = state.get();
	const scenarios = s.scenarios.map((sc, i) => {
		if (i !== s.scenarioIdx) return sc;
		const next = JSON.parse(JSON.stringify(sc));
		fn(next);
		return next;
	});
	state.set({ scenarios });
}
function mutateFlow(fn: (f: any) => void) {
	mutateScenario((sc) => {
		fn(sc.flows[state.get().currentFlowIdx]);
	});
}

// ─── SOURCE ───
let currentSourceCleanup: (() => void) | null = null;

function inferLocalKind(path: string): "folder" | "archive" {
	const lower = path.toLowerCase();
	for (const ext of UI.source.archiveExts)
		if (lower.endsWith(ext)) return "archive";
	return "folder";
}

async function handleFiles(files?: FileList | null) {
	if (!files?.length) return;
	const f0 = files[0] as any;
	const fullPath = f0.path as string | undefined;
	if (!fullPath) {
		state.set({
			error: "Path not available — try the click-to-browse picker.",
		});
		return;
	}
	// Infer kind from the actual dropped item.
	const kind = inferLocalKind(fullPath);
	let path = fullPath;
	if (kind === "folder") {
		// If a file inside a folder was dropped, climb up to the folder.
		const rel = (f0.webkitRelativePath || "").split("/")[0];
		if (rel && fullPath.includes(`/${rel}/`)) {
			path = fullPath.slice(0, fullPath.indexOf(`/${rel}/`) + rel.length + 1);
		} else if (!rel && f0.type) {
			// dropped a file (not a folder) — climb to its parent.
			path = fullPath.split("/").slice(0, -1).join("/");
		}
	}
	state.set((st) => ({ ...st, source: { ...st.source, path } }));
	await loadSource({ kind, path });
}

async function loadSource(input: SourceInput) {
	const desc = input.kind === "url" ? input.url : input.path;
	state.set({ error: null });
	log(`Loading ${input.kind}: ${desc}`);
	if (currentSourceCleanup) {
		log("Cleaning up previous source…");
		try {
			await req.cleanupSources({});
		} catch (e: any) {
			log(`cleanup err: ${e?.message}`, "warn");
		}
		currentSourceCleanup = null;
	}
	try {
		log("Calling resolveSource RPC…");
		const r = await req.resolveSource(input);
		log(
			`resolveSource → ok=${r.ok}, baseUrl=${r.baseUrl ?? "—"}, entry=${r.entry ?? "—"}, error=${r.error ?? "—"}`,
		);
		if (!r.ok) {
			state.set({ error: r.error || "Failed to load source" });
			log(`Source error: ${r.error}`, "error");
			return;
		}
		// Restore previously saved scenarios for this project (or start empty).
		const key = projectKey(input);
		const cached = loadProject(key);
		state.set((s) => ({
			...s,
			baseUrl: r.baseUrl || null,
			entry: r.entry || null,
			projectKey: key,
			scenarios: cached?.scenarios || [],
			scenarioIdx: cached?.scenarioIdx ?? 0,
			currentFlowIdx: cached?.currentFlowIdx ?? 0,
			deviceIdx: cached?.deviceIdx ?? s.deviceIdx,
		}));
		currentSourceCleanup = () => {};
		log(
			`Source ready → ${r.baseUrl}${r.entry ? `/${r.entry}` : ""}`,
			"success",
		);
		if (cached)
			log(
				`Restored ${cached.scenarios.length} saved scenario(s) for this project`,
				"success",
			);
		else log(`No saved scenarios — start by clicking ● Record`);
	} catch (e: any) {
		state.set({ error: e.message });
		log(`Source error: ${e.message}`, "error");
	}
}

// ─── PREVIEW CONTROL ───
function reloadPreview() {
	const f = $<HTMLIFrameElement>("#preview-iframe");
	if (f) f.src = f.src;
}

function ensureRecordingTarget(): boolean {
	const s = state.get();
	if (!s.scenarios.length) {
		state.set((st) => ({
			...st,
			scenarios: [
				{
					name: "Recording",
					takeScreenshots: true,
					flows: [{ name: "Flow 1", steps: [] }],
				},
			],
			scenarioIdx: 0,
			currentFlowIdx: 0,
		}));
		return true;
	}
	const sc = currentScenario();
	if (!sc.flows.length) {
		mutateScenario((s) => {
			s.flows.push({ name: "Flow 1", steps: [] });
		});
		state.set({ currentFlowIdx: 0 });
		return true;
	}
	return true;
}

function postCmd(cmd: "start" | "pause" | "resume" | "stop"): void {
	const f = $<HTMLIFrameElement>("#preview-iframe");
	f?.contentWindow?.postMessage({ __scenrun_cmd: true, cmd }, "*");
}

function startRecording(): void {
	if (runInFlight) {
		log("Cannot record while running.", "warn");
		return;
	}
	if (!ensureRecordingTarget()) return;
	state.set({ recording: "recording" });
	postCmd("start");
	log("Recording started", "info");
}
function pauseRecording(): void {
	state.set({ recording: "paused" });
	postCmd("pause");
	log("Recording paused — you can replay or edit steps", "info");
}
function resumeRecording(): void {
	if (runInFlight) {
		log("Cannot record while running.", "warn");
		return;
	}
	state.set({ recording: "recording" });
	postCmd("resume");
	log("Recording resumed", "info");
}
function stopRecording(): void {
	state.set({ recording: "idle" });
	postCmd("stop");
	log("Recording stopped", "info");
}

// ─── REPLAY ───
const pendingReplies = new Map<string, (r: any) => void>();
let runInFlight = false;

function sendStepToFrame(
	step: FlowStep,
	timeoutMs = UI.defaults.stepRunTimeoutMs,
): Promise<{ ok: boolean; error?: string }> {
	const f = $<HTMLIFrameElement>("#preview-iframe");
	if (!f?.contentWindow)
		return Promise.resolve({ ok: false, error: "iframe not ready" });
	const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const clean: any = { ...step };
	for (const k of Object.keys(clean))
		if (k.startsWith("__") || k === "screenshot") delete clean[k];
	return new Promise((resolve) => {
		const t = setTimeout(() => {
			pendingReplies.delete(id);
			resolve({ ok: false, error: "step timeout" });
		}, timeoutMs);
		pendingReplies.set(id, (r) => {
			clearTimeout(t);
			resolve(r);
		});
		f.contentWindow!.postMessage({ __scenrun_run: true, id, step: clean }, "*");
	});
}

function waitForFrameReady(
	timeoutMs = UI.defaults.runnerReadyTimeoutMs,
): Promise<void> {
	return new Promise((resolve) => {
		const f = $<HTMLIFrameElement>("#preview-iframe");
		if (!f) return resolve();
		const t = setTimeout(() => resolve(), timeoutMs);
		const onReady = (e: MessageEvent) => {
			const d: any = e.data;
			if (d?.__scenrun_runner && d.kind === "runner-ready") {
				clearTimeout(t);
				window.removeEventListener("message", onReady);
				resolve();
			}
		};
		window.addEventListener("message", onReady);
	});
}

async function captureCurrentRect(name: string): Promise<string | null> {
	const vp = $<HTMLElement>("#preview-viewport");
	if (!vp) return null;
	const rect = vp.getBoundingClientRect();
	const x = window.screenX + rect.left;
	const y =
		window.screenY + rect.top + (window.outerHeight - window.innerHeight);
	if (rect.width <= 0 || rect.height <= 0) return null;
	const r = await req.captureRect({
		x: Math.max(0, x),
		y: Math.max(0, y),
		width: rect.width,
		height: rect.height,
		name,
	});
	if (r.ok) return r.path as string;
	log(`Screenshot failed: ${r.error}`, "error");
	return null;
}

async function handleRun() {
	if (runInFlight) {
		log("Run already in progress.", "warn");
		return;
	}
	const s = state.get();
	const sc = currentScenario();
	const dev = s.devices[s.deviceIdx];
	if (!sc || !dev || !s.baseUrl) return;
	runInFlight = true;

	state.set({
		progress: [],
		logs: [],
		run: null,
		error: null,
		view: "steps",
		recording: "idle",
	});
	log(`Starting run: ${sc.name} on ${dev.name}`);

	pendingReplies.clear();
	reloadPreview();
	await waitForFrameReady();

	const startTs = Date.now();
	const scenarioShots = sc.takeScreenshots ?? true;
	const flows: FlowResult[] = [];
	let anyFailed = false;

	try {
		for (let fi = 0; fi < sc.flows.length; fi++) {
			const flow = sc.flows[fi];
			const flowResult: FlowResult = {
				flowIdx: fi,
				name: flow.name,
				status: "running",
				steps: [],
			};
			flows.push(flowResult);
			let flowFailed = false;

			for (let si = 0; si < flow.steps.length; si++) {
				const step = flow.steps[si] as FlowStep;
				const t0 = Date.now();
				const reply = await sendStepToFrame(step);
				let screenshot: string | undefined;
				const status: "passed" | "failed" = reply.ok ? "passed" : "failed";

				const stepShot = (step as any).screenshot;
				const shotEnabled =
					step.action === "screenshot" || (stepShot ?? scenarioShots);
				if (reply.ok && shotEnabled) {
					const name =
						step.name ||
						`${sc.name}-${flow.name}-${si + 1}`
							.replace(/\s+/g, "-")
							.toLowerCase();
					const path = await captureCurrentRect(name);
					if (path) screenshot = path;
				}

				const result: StepResult = {
					flowIdx: fi,
					stepIdx: si,
					action: step.action,
					status,
					screenshot,
					error: reply.error,
					duration: Date.now() - t0,
				};
				flowResult.steps.push(result);
				log(
					`#${si + 1} ${step.action}: ${status}${reply.error ? ` — ${reply.error}` : ""}`,
					status === "passed" ? "success" : "error",
				);
				const pct = Math.round(((si + 1) / flow.steps.length) * 100);
				const arr = [...state.get().progress];
				arr[fi] = {
					flowIdx: fi,
					pct,
					label: `${flow.name} ${si + 1}/${flow.steps.length}`,
				};
				state.set({ progress: arr });
				if (status === "failed") {
					flowFailed = true;
					anyFailed = true;
				}
			}
			flowResult.status = flowFailed
				? flowResult.steps.some((x) => x.status === "passed")
					? "partial"
					: "failed"
				: "passed";
		}

		const run: RunResult = {
			id: `run-${startTs}-${Math.random().toString(36).slice(2, 8)}`,
			timestamp: new Date(startTs).toISOString(),
			duration: Date.now() - startTs,
			status: !flows.length
				? "failed"
				: anyFailed
					? flows.some((f) => f.status === "passed")
						? "partial"
						: "failed"
					: "completed",
			scenarioName: sc.name,
			deviceName: dev.name,
			baseUrl: s.baseUrl,
			flows,
		};
		state.set({ run, view: "results-a" });
		log(
			`Run ${run.status} in ${(run.duration / 1000).toFixed(1)}s`,
			run.status === "completed" ? "success" : "warn",
		);
	} finally {
		runInFlight = false;
	}
}

// ─── EXPORT / IMPORT ───
async function handleExport() {
	const sc = currentScenario();
	const yaml = (await import("js-yaml")).default.dump(
		JSON.parse(JSON.stringify(sc)),
	);
	const blob = new Blob([yaml], { type: "text/yaml" });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = `${sc.name.replace(/\s+/g, "-").toLowerCase()}.yaml`;
	a.click();
}

async function handleImport() {
	const inp = document.createElement("input");
	inp.type = "file";
	inp.accept = ".yaml,.yml,.json";
	inp.onchange = async () => {
		const f = inp.files?.[0];
		if (!f) return;
		const text = await f.text();
		const r = validateScenario(
			text,
			f.name.endsWith(".json") ? "json" : "yaml",
		);
		if (!r.ok) {
			state.set({ error: r.error });
			return;
		}
		state.set((s) => ({
			...s,
			scenarios: [...s.scenarios, r.value],
			scenarioIdx: s.scenarios.length,
			currentFlowIdx: 0,
			view: "steps",
		}));
		log(`Imported: ${r.value.name}`, "success");
	};
	inp.click();
}

// ─── MESSAGES FROM IFRAME (recorder + runner) ───
window.addEventListener("message", (e) => {
	const d = e.data;
	if (d?.__scenrun_runner && d.kind === "step-done") {
		const cb = pendingReplies.get(d.id);
		if (cb) {
			pendingReplies.delete(d.id);
			cb(d.result);
		}
		return;
	}
	if (!d?.__scenrun) return;
	if (d.kind === "step") {
		if (runInFlight) return; // never accept recorded events during a run
		if (state.get().recording !== "recording") return; // ignore stale events while paused/idle
		const step = d.step;
		const flow = currentFlow();
		if (!flow) return;
		const last = flow.steps[flow.steps.length - 1] as any;
		if (
			step.action === "type" &&
			last?.action === "type" &&
			last.selector === step.selector
		) {
			mutateFlow((f) => {
				(f.steps[f.steps.length - 1] as any).value = step.value;
			});
			return;
		}
		if (
			last?.__ts &&
			step.ts - last.__ts > UI.defaults.recordWaitThresholdMs &&
			step.action !== "navigate"
		) {
			const delta = Math.min(step.ts - last.__ts, UI.defaults.recordWaitMaxMs);
			mutateFlow((f) => {
				f.steps.push({
					action: "wait",
					ms:
						Math.round(delta / UI.defaults.recordWaitRoundMs) *
						UI.defaults.recordWaitRoundMs,
				} as FlowStep);
			});
		}
		mutateFlow((f) => {
			const newStep: FlowStep = {
				action: step.action,
				selector: step.selector,
				value: step.value,
				url: step.url,
			};
			(newStep as any).__ts = step.ts;
			f.steps.push(newStep);
		});
		log(`rec: ${step.action}${step.selector ? ` ${step.selector}` : ""}`);
	} else if (d.kind === "ready") {
		log(`Preview ready: ${d.url}`);
		if (state.get().recording === "recording") postCmd("start");
	} else if (d.kind === "status") {
		log(`Recorder status: ${d.recording ? "ON" : "OFF"}`);
	} else if (d.kind === "iframe-error") {
		log(`iframe: ${d.message}`, (d.level as any) || "error");
	}
});

// ─── VIEWPORT FIT ───
function fitViewport(): void {
	const content = $<HTMLElement>("#preview-content");
	const vp = $<HTMLElement>("#preview-viewport");
	if (!content || !vp || vp.classList.contains("hidden")) return;
	const s = state.get();
	const dev = s.devices[s.deviceIdx];
	const dims = s.customViewport || dev?.viewport;
	if (!dims) return;
	const aw = content.clientWidth;
	const ah = content.clientHeight;
	const scale = Math.min(1, aw / dims.width, ah / dims.height);
	vp.style.transform = `scale(${scale})`;
	vp.style.marginBottom = `${(scale - 1) * dims.height}px`;
	vp.style.marginRight = `${(scale - 1) * dims.width}px`;
	renderRulers(
		dims.width,
		dims.height,
		scale,
		content.scrollLeft,
		content.scrollTop,
	);
}

// ─── RULERS ───
function renderRulers(
	deviceW: number,
	deviceH: number,
	scale: number,
	scrollX = 0,
	scrollY = 0,
): void {
	const top = $<HTMLElement>("#ruler-top");
	const left = $<HTMLElement>("#ruler-left");
	if (top) top.innerHTML = buildRulerSvg("h", deviceW, scale, scrollX);
	if (left) left.innerHTML = buildRulerSvg("v", deviceH, scale, scrollY);
}

function buildRulerSvg(
	axis: "h" | "v",
	deviceLen: number,
	scale: number,
	scroll: number,
): string {
	const T = 22; // thickness
	const visualLen = deviceLen * scale;
	const offset = -scroll;
	const ticks: string[] = [];
	const minorEvery = scale < 0.4 ? 50 : scale < 1 ? 20 : 10;
	const labelEvery = scale < 0.4 ? 200 : scale < 1 ? 100 : 50;
	for (let i = 0; i <= deviceLen; i += minorEvery) {
		const pos = i * scale + offset;
		if (pos < -10 || pos > visualLen + 10) continue;
		const isMajor = i % labelEvery === 0;
		const isHalf = !isMajor && i % (labelEvery / 2) === 0;
		const tickLen = isMajor ? T - 6 : isHalf ? 8 : 4;
		if (axis === "h") {
			ticks.push(
				`<line x1="${pos}" y1="${T - tickLen}" x2="${pos}" y2="${T}" stroke="currentColor" stroke-width="1" opacity="${isMajor ? 0.9 : 0.5}"/>`,
			);
			if (isMajor && i > 0)
				ticks.push(
					`<text x="${pos + 2}" y="${T - tickLen - 2}" font-size="9" fill="currentColor" opacity="0.8">${i}</text>`,
				);
		} else {
			ticks.push(
				`<line x1="${T - tickLen}" y1="${pos}" x2="${T}" y2="${pos}" stroke="currentColor" stroke-width="1" opacity="${isMajor ? 0.9 : 0.5}"/>`,
			);
			if (isMajor && i > 0)
				ticks.push(
					`<text x="2" y="${pos + 8}" font-size="9" fill="currentColor" opacity="0.8">${i}</text>`,
				);
		}
	}
	if (axis === "h") {
		return `<svg width="100%" height="${T}" preserveAspectRatio="none" style="display:block">${ticks.join("")}</svg>`;
	}
	return `<svg width="${T}" height="100%" preserveAspectRatio="none" style="display:block">${ticks.join("")}</svg>`;
}

window.addEventListener("resize", fitViewport);
// Re-render rulers when content area scrolls
document.addEventListener(
	"scroll",
	(e) => {
		if ((e.target as HTMLElement)?.id === "preview-content") fitViewport();
	},
	true,
);

// ─── BOOT ───
// ─── RESIZABLE PANES ───
const PANE_DEFAULTS: Record<string, number> = {
	"sidebar-preview": 300, // sidebar width
	"preview-inspector": 360, // inspector width
	"inspector-log": 200, // log panel height
};
const paneKey = (id: string) => `prisma:pane:${id}`;
function loadPaneSize(id: string): number {
	try {
		const v = parseInt(localStorage.getItem(paneKey(id)) || "", 10);
		if (Number.isFinite(v) && v > 50) return v;
	} catch {}
	return PANE_DEFAULTS[id];
}
function savePaneSize(id: string, v: number): void {
	try {
		localStorage.setItem(paneKey(id), String(v));
	} catch {}
}
function applyPaneSizes(): void {
	const sb = document.querySelector<HTMLElement>(".sidebar");
	if (sb) sb.style.flexBasis = `${loadPaneSize("sidebar-preview")}px`;
	const insp = document.querySelector<HTMLElement>(".inspector");
	if (insp) insp.style.flexBasis = `${loadPaneSize("preview-inspector")}px`;
	const log = document.querySelector<HTMLElement>(".inspector .log-panel");
	if (log) log.style.height = `${loadPaneSize("inspector-log")}px`;
}
function bindSplitters(): void {
	document.querySelectorAll<HTMLElement>(".splitter").forEach((el) => {
		const id = el.getAttribute("data-split")!;
		const horizontal = el.classList.contains("h");
		el.addEventListener("dblclick", () => {
			savePaneSize(id, PANE_DEFAULTS[id]);
			applyPaneSizes();
		});
		el.addEventListener("mousedown", (e) => {
			e.preventDefault();
			el.classList.add("dragging");
			document.body.style.cursor = horizontal ? "row-resize" : "col-resize";
			document.body.style.userSelect = "none";
			const startPos = horizontal ? e.clientY : e.clientX;
			const target =
				id === "sidebar-preview"
					? document.querySelector<HTMLElement>(".sidebar")
					: id === "preview-inspector"
						? document.querySelector<HTMLElement>(".inspector")
						: document.querySelector<HTMLElement>(".inspector .log-panel");
			if (!target) return;
			const startSize = horizontal ? target.offsetHeight : target.offsetWidth;
			const dir = id === "preview-inspector" ? -1 : 1;
			const onMove = (m: MouseEvent) => {
				const delta =
					(horizontal ? m.clientY - startPos : m.clientX - startPos) * dir;
				const next = Math.max(80, Math.min(900, startSize + delta));
				if (horizontal) target.style.height = `${next}px`;
				else target.style.flexBasis = `${next}px`;
				savePaneSize(id, next);
			};
			const onUp = () => {
				el.classList.remove("dragging");
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
				fitViewport();
			};
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		});
	});
}

theme.init();
state.subscribe(() => render());

log(`${UI.app.name} ready — drop a folder/zip or paste a URL to begin.`);

(async () => {
	log("Loading config…");
	try {
		const cfg = await req.getConfig({});
		log(
			`Config received — devices.yaml: ${cfg.devicesYaml ? `${cfg.devicesYaml.length}B` : "EMPTY"}, scenarios.yaml: ${cfg.scenarioYaml ? `${cfg.scenarioYaml.length}B` : "EMPTY"}`,
		);
		if (cfg.devicesYaml) {
			const dr = validateDeviceConfig(cfg.devicesYaml);
			if (dr.ok) {
				state.set({ devices: dr.value.devices });
				log(`Loaded ${dr.value.devices.length} device presets`, "success");
			} else log(`Invalid devices.yaml: ${dr.error}`, "error");
		} else
			log(
				"devices.yaml not found in bundle — device list will be empty",
				"warn",
			);
		// Sample scenario intentionally not auto-loaded — library starts empty.
	} catch (e: any) {
		log(`Config load failed: ${e?.message || e}`, "error");
	}
})();
// ─── iOS SIMULATOR (RN snap) MODE ─── persistent DOM, no innerHTML rebuilds ─
//
// The previous attempt rebuilt #app's innerHTML on every state change. In
// WKWebView that killed click events in subtle ways. Now the iOS Sim view
// lives in its own <div id="rn-root"> sibling of <div id="app">. The DOM
// tree is built once with createElement; state changes only touch text,
// attributes, classes, or visibility — never replace nodes. Listeners are
// attached once and stay alive across mode switches and state updates.

interface RnRefs {
	root: HTMLDivElement;
	header: HTMLElement;
	headerSnapBtn: HTMLButtonElement;
	headerPushBtn: HTMLButtonElement;
	headerNewSessionBtn: HTMLButtonElement;
	sourceTabsBox: HTMLDivElement;
	sourceTabBtns: { url: HTMLButtonElement; local: HTMLButtonElement; iossim: HTMLButtonElement };
	projectsList: HTMLDivElement;
	projectsAddBtn: HTMLButtonElement;
	flowsList: HTMLDivElement;
	bridgeDot: HTMLSpanElement;
	bridgeTitle: HTMLDivElement;
	bridgeSub: HTMLDivElement;
	bridgeHint: HTMLParagraphElement;
	sessionIdText: HTMLDivElement;
	sessionCountText: HTMLDivElement;
	previewBox: HTMLDivElement;
	recentBox: HTMLDivElement;
	// modal
	modalBackdrop: HTMLDivElement;
	modalRepoInput: HTMLInputElement;
	modalSlugInput: HTMLInputElement;
	modalNameInput: HTMLInputElement;
	modalUrlInput: HTMLInputElement;
	modalTokenInput: HTMLInputElement;
	modalBrowseBtn: HTMLButtonElement;
	modalCancelBtn: HTMLButtonElement;
	modalSubmitBtn: HTMLButtonElement;
	modalCloseBtn: HTMLButtonElement;
	modalStepsBox: HTMLDivElement;
	modalErrorBox: HTMLDivElement;
	modalManualBox: HTMLDivElement;
	modalManualPre: HTMLPreElement;
}

let rnRefs: RnRefs | null = null;
let rnSelectedSeq: number | null = null;
let rnPollTimer: ReturnType<typeof setInterval> | null = null;

function ce<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	if (className) e.className = className;
	return e;
}

function toFileUrl(absPath: string): string {
	// WKWebView blocks file:// from a views:// origin. Route through the
	// snap-server's HTTP endpoint instead.
	return `http://localhost:9876/img?path=${encodeURIComponent(absPath)}`;
}

function routeShortLabel(snap: RnSnapInfo): string {
	const stack = snap.navStack ?? [];
	const parts = stack.filter((seg) => seg && !seg.startsWith("(") && !seg.startsWith("["));
	if (parts.length === 0) return stack.length === 0 ? "welcome" : "home";
	return parts.join("/");
}

function buildRnLayout(): RnRefs {
	const root = ce("div", "rn-root");
	root.id = "rn-root";
	root.style.display = "none"; // hidden until iossim mode

	// ── HEADER ──
	const header = ce("header", "header");
	const h1 = ce("h1");
	const brandImg = ce("img", "brand-mark");
	brandImg.src = "logo.svg";
	brandImg.alt = "";
	const brandName = ce("span", "brand-wordmark");
	brandName.textContent = UI.app.name;
	h1.append(brandImg, brandName);
	const headerActions = ce("div", "header-actions");
	const headerThemeBtn = ce("button", "btn btn-ghost btn-icon btn-sm");
	headerThemeBtn.title = "Toggle theme";
	headerThemeBtn.textContent = UI.actions.theme;
	const headerNewSessionBtn = ce("button", "btn btn-ghost btn-sm");
	headerNewSessionBtn.title = "Start a new session";
	headerNewSessionBtn.textContent = "↻ New session";
	const headerPushBtn = ce("button", "btn btn-secondary");
	headerPushBtn.title = "Upload pending snaps to the gallery platform";
	headerPushBtn.textContent = "↑ Push to web";
	const headerSnapBtn = ce("button", "btn btn-primary");
	headerSnapBtn.textContent = UI.rn.snap.button;
	headerActions.append(headerThemeBtn, headerNewSessionBtn, headerPushBtn, headerSnapBtn);
	header.append(h1, headerActions);

	// ── LAYOUT ──
	const layout = ce("div", "rn-layout");
	// Restore collapsed state from prior session.
	if (loadSidebarCollapsed()) layout.classList.add("rn-layout-collapsed");

	// SIDEBAR
	const sidebar = ce("aside", "rn-sidebar");

	// Collapse / expand toggle. Sticks to the top-right of the sidebar; when
	// the sidebar is collapsed, a mirror "expand" button shows on the canvas.
	const sidebarCollapseBtn = ce("button", "rn-sidebar-collapse");
	sidebarCollapseBtn.type = "button";
	sidebarCollapseBtn.title = "Collapse sidebar";
	sidebarCollapseBtn.setAttribute("aria-label", "Collapse sidebar");
	sidebarCollapseBtn.textContent = "«";
	sidebarCollapseBtn.addEventListener("click", () => {
		layout.classList.add("rn-layout-collapsed");
		saveSidebarCollapsed(true);
	});

	const sidebarExpandBtn = ce("button", "rn-sidebar-expand");
	sidebarExpandBtn.type = "button";
	sidebarExpandBtn.title = "Show sidebar";
	sidebarExpandBtn.setAttribute("aria-label", "Show sidebar");
	sidebarExpandBtn.textContent = "»";
	sidebarExpandBtn.addEventListener("click", () => {
		layout.classList.remove("rn-layout-collapsed");
		saveSidebarCollapsed(false);
	});

	// Source section
	const sourceSection = ce("div", "section");
	const sourceTitle = ce("div", "section-title row");
	const sourceTitleSpan = ce("span");
	sourceTitleSpan.textContent = UI.labels.source;
	sourceTitle.appendChild(sourceTitleSpan);
	const sourceTabsBox = ce("div", "tabs");
	const tabBtnUrl = ce("button", "tab");
	tabBtnUrl.textContent = "URL";
	const tabBtnLocal = ce("button", "tab");
	tabBtnLocal.textContent = "Local";
	const tabBtnIosSim = ce("button", "tab active");
	tabBtnIosSim.textContent = "iOS Sim";
	sourceTabsBox.append(tabBtnUrl, tabBtnLocal, tabBtnIosSim);
	sourceSection.append(sourceTitle, sourceTabsBox);

	// Projects section
	const projectsSection = ce("div", "section");
	const projectsTitle = ce("div", "section-title row");
	const projectsTitleSpan = ce("span");
	projectsTitleSpan.textContent = "Projects";
	const projectsAddBtn = ce("button", "btn btn-primary btn-sm");
	projectsAddBtn.textContent = "+ Add";
	projectsAddBtn.title = "Add a new project";
	const projectsTitleActions = ce("span", "row");
	projectsTitleActions.style.gap = "4px";
	projectsTitleActions.appendChild(projectsAddBtn);
	projectsTitle.append(projectsTitleSpan, projectsTitleActions);
	const projectsList = ce("div", "rn-projects");
	projectsSection.append(projectsTitle, projectsList);

	// Flows section — tree of flows in the active project, click to focus
	const flowsSection = ce("div", "section");
	const flowsTitle = ce("div", "section-title");
	flowsTitle.textContent = "Flows";
	const flowsList = ce("div", "rn-flows-side");
	flowsSection.append(flowsTitle, flowsList);

	// Bridge section
	const bridgeSection = ce("div", "section");
	const bridgeTitleHeader = ce("div", "section-title");
	bridgeTitleHeader.textContent = UI.rn.title;
	const bridgeStatus = ce("div", "rn-status");
	const bridgeDot = ce("span", "dot warn");
	const bridgeTextWrap = ce("div");
	const bridgeTitle = ce("div", "rn-status-title");
	bridgeTitle.textContent = UI.rn.bridge.waiting;
	const bridgeSub = ce("div", "rn-status-sub");
	bridgeSub.textContent = "port 9876";
	bridgeTextWrap.append(bridgeTitle, bridgeSub);
	bridgeStatus.append(bridgeDot, bridgeTextWrap);
	const bridgeHint = ce("p", "rn-hint");
	bridgeHint.textContent = UI.rn.bridge.noBridge;
	bridgeSection.append(bridgeTitleHeader, bridgeStatus, bridgeHint);

	// Session section
	const sessionSection = ce("div", "section");
	const sessionTitle = ce("div", "section-title");
	sessionTitle.textContent = UI.rn.recent.title;
	const sessionMeta = ce("div", "rn-session-meta");
	const sessionIdText = ce("div", "rn-session-id");
	sessionIdText.textContent = "—";
	const sessionCountText = ce("div", "rn-session-count");
	sessionCountText.textContent = "0 snaps";
	sessionMeta.append(sessionIdText, sessionCountText);
	sessionSection.append(sessionTitle, sessionMeta);

	sidebar.append(sidebarCollapseBtn, sourceSection, projectsSection, flowsSection, bridgeSection, sessionSection);

	// MAIN — snap grid card. previewBox is kept as the main scroller; we
	// populate it with a grid of snap cards in applyRnState (no separate
	// "preview" + "recent" split anymore).
	const main = ce("main", "rn-main");
	main.appendChild(sidebarExpandBtn);
	const previewBox = ce("div", "rn-grid-scroll");
	main.appendChild(previewBox);
	const recentBox = previewBox; // alias — same container, just renamed in refs

	layout.append(sidebar, main);
	root.append(header, layout);

	// ── MODAL (always in DOM, hidden by default) ──
	const modalBackdrop = ce("div", "rn-modal-backdrop");
	modalBackdrop.style.display = "none";
	const modal = ce("div", "rn-modal");
	const modalHeader = ce("div", "rn-modal-header");
	const modalTitle = ce("div", "rn-modal-title");
	modalTitle.textContent = "Add project";
	const modalCloseBtn = ce("button", "btn btn-ghost btn-sm");
	modalCloseBtn.textContent = "×";
	modalHeader.append(modalTitle, modalCloseBtn);
	const modalBody = ce("div", "rn-modal-body");

	const fields: Array<[string, string, HTMLInputElement, HTMLButtonElement | null]> = [];
	const mkField = (
		label: string,
		placeholder: string,
		type = "text",
		withBrowse = false,
	): { input: HTMLInputElement; browseBtn: HTMLButtonElement | null } => {
		const fieldLabel = ce("label", "rn-field");
		const span = ce("span");
		span.textContent = label;
		fieldLabel.appendChild(span);
		const input = ce("input", "input");
		input.type = type;
		input.placeholder = placeholder;
		let browseBtn: HTMLButtonElement | null = null;
		if (withBrowse) {
			const row = ce("div", "rn-field-row");
			browseBtn = ce("button", "btn btn-secondary btn-sm");
			browseBtn.textContent = "Browse…";
			browseBtn.type = "button";
			row.append(input, browseBtn);
			fieldLabel.appendChild(row);
		} else {
			fieldLabel.appendChild(input);
		}
		modalBody.appendChild(fieldLabel);
		fields.push([label, placeholder, input, browseBtn]);
		return { input, browseBtn };
	};

	const repo = mkField("Repo path", "/path/to/customer-repo", "text", true);
	const slug = mkField("Slug", "acme-fitness");
	const name = mkField("Display name", "Acme Fitness");
	const url = mkField("Platform URL", "http://localhost:3010");
	url.input.value = "http://localhost:3010";
	const token = mkField("Setup token", "setup_…", "password");

	const modalErrorBox = ce("div", "rn-wizard-error");
	modalErrorBox.style.display = "none";
	modalBody.appendChild(modalErrorBox);
	const modalStepsBox = ce("div", "rn-wizard-steps");
	modalStepsBox.style.display = "none";
	modalBody.appendChild(modalStepsBox);
	const modalManualBox = ce("div", "rn-wizard-manual");
	modalManualBox.style.display = "none";
	const modalManualTitle = ce("div", "rn-wizard-manual-title");
	modalManualTitle.textContent = "Couldn't auto-edit your root layout — paste this snippet:";
	const modalManualPre = ce("pre", "rn-wizard-snippet");
	modalManualBox.append(modalManualTitle, modalManualPre);
	modalBody.appendChild(modalManualBox);

	const modalFooter = ce("div", "rn-modal-footer");
	const modalCancelBtn = ce("button", "btn btn-ghost");
	modalCancelBtn.textContent = "Cancel";
	const modalSubmitBtn = ce("button", "btn btn-primary");
	modalSubmitBtn.textContent = "Setup project →";
	modalFooter.append(modalCancelBtn, modalSubmitBtn);

	modal.append(modalHeader, modalBody, modalFooter);
	modalBackdrop.appendChild(modal);
	root.appendChild(modalBackdrop);

	const refs: RnRefs = {
		root,
		header,
		headerSnapBtn,
		headerPushBtn,
		headerNewSessionBtn,
		sourceTabsBox,
		sourceTabBtns: { url: tabBtnUrl, local: tabBtnLocal, iossim: tabBtnIosSim },
		projectsList,
		projectsAddBtn,
		flowsList,
		bridgeDot,
		bridgeTitle,
		bridgeSub,
		bridgeHint,
		sessionIdText,
		sessionCountText,
		previewBox,
		recentBox,
		modalBackdrop,
		modalRepoInput: repo.input,
		modalSlugInput: slug.input,
		modalNameInput: name.input,
		modalUrlInput: url.input,
		modalTokenInput: token.input,
		modalBrowseBtn: repo.browseBtn!,
		modalCancelBtn,
		modalSubmitBtn,
		modalCloseBtn,
		modalStepsBox,
		modalErrorBox,
		modalManualBox,
		modalManualPre,
	};

	// ── EVENT WIRING (once) ──
	tabBtnUrl.addEventListener("click", () => switchSource("url"));
	tabBtnLocal.addEventListener("click", () => switchSource("local"));
	tabBtnIosSim.addEventListener("click", () => switchSource("iossim"));
	headerThemeBtn.addEventListener("click", () => theme.toggle());
	headerNewSessionBtn.addEventListener("click", () => void doResetSession());
	headerSnapBtn.addEventListener("click", () => void doSnap());
	headerPushBtn.addEventListener("click", () => void doPushPending());
	projectsAddBtn.addEventListener("click", () => openWizard());

	modalCloseBtn.addEventListener("click", () => closeWizard());
	modalCancelBtn.addEventListener("click", () => closeWizard());
	modalBackdrop.addEventListener("click", (e) => {
		if (e.target === modalBackdrop) closeWizard();
	});
	repo.browseBtn?.addEventListener("click", () => void doBrowse());
	modalSubmitBtn.addEventListener("click", () => void doSubmitWizard());
	// Auto-fill slug + name when repo path is set
	repo.input.addEventListener("change", () => {
		const path = repo.input.value;
		if (!path) return;
		const auto = path
			.split("/")
			.filter(Boolean)
			.pop()!
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");
		if (!slug.input.value) slug.input.value = auto;
		if (!name.input.value)
			name.input.value = auto.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
	});

	return refs;
}

function ensureRnMounted(): RnRefs {
	if (!rnRefs) {
		rnRefs = buildRnLayout();
		document.body.appendChild(rnRefs.root);
		installDragAutoScroll(rnRefs);
	}
	return rnRefs;
}

/**
 * Edge-of-viewport auto-scroll while dragging. When the cursor sits
 * within EDGE px of the top/bottom of the main scroll area (or
 * left/right of a horizontal strip), the container starts scrolling
 * itself toward that edge. Speed scales with how close to the edge
 * the cursor is. Cleans up on dragend/drop.
 */
function installDragAutoScroll(refs: RnRefs): void {
	const EDGE = 80; // px from edge to start scrolling
	const MAX_SPEED = 18; // px per tick at full pressure
	let lastX = 0;
	let lastY = 0;
	let timer: ReturnType<typeof setInterval> | null = null;

	const isDragging = () => dragSrc !== null || flowDragSrcId !== null;

	const tick = () => {
		// Vertical: main grid scroller (`refs.previewBox`).
		const grid = refs.previewBox;
		const gRect = grid.getBoundingClientRect();
		let dy = 0;
		if (lastY >= gRect.top && lastY <= gRect.bottom) {
			const fromTop = lastY - gRect.top;
			const fromBottom = gRect.bottom - lastY;
			if (fromTop < EDGE) {
				dy = -Math.ceil(((EDGE - fromTop) / EDGE) * MAX_SPEED);
			} else if (fromBottom < EDGE) {
				dy = Math.ceil(((EDGE - fromBottom) / EDGE) * MAX_SPEED);
			}
		}
		if (dy !== 0) grid.scrollTop += dy;

		// Horizontal: the strip currently under the cursor (if any).
		const elAt = document.elementFromPoint(lastX, lastY);
		const strip =
			elAt instanceof HTMLElement
				? (elAt.closest(".rn-strip") as HTMLElement | null)
				: null;
		if (strip) {
			const sRect = strip.getBoundingClientRect();
			const fromLeft = lastX - sRect.left;
			const fromRight = sRect.right - lastX;
			let dx = 0;
			if (fromLeft >= 0 && fromLeft < EDGE) {
				dx = -Math.ceil(((EDGE - fromLeft) / EDGE) * MAX_SPEED);
			} else if (fromRight >= 0 && fromRight < EDGE) {
				dx = Math.ceil(((EDGE - fromRight) / EDGE) * MAX_SPEED);
			}
			if (dx !== 0) strip.scrollLeft += dx;
		}
	};

	const start = () => {
		if (!timer) timer = setInterval(tick, 16);
	};
	const stop = () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	};

	document.addEventListener("dragover", (ev) => {
		if (!isDragging()) return;
		lastX = ev.clientX;
		lastY = ev.clientY;
		start();
	});
	document.addEventListener("dragend", stop);
	document.addEventListener("drop", stop);
}

function setRnVisible(visible: boolean): void {
	if (!rnRefs) return;
	rnRefs.root.style.display = visible ? "flex" : "none";
}

function setAppVisible(visible: boolean): void {
	const app = document.getElementById("app");
	if (app) app.style.display = visible ? "" : "none";
}

function switchSource(kind: SourceKind): void {
	state.set((cur) => ({
		...cur,
		source: { ...cur.source, kind },
		error: null,
	}));
}

function openWizard(): void {
	if (!rnRefs) return;
	rnRefs.modalErrorBox.style.display = "none";
	rnRefs.modalErrorBox.textContent = "";
	rnRefs.modalStepsBox.style.display = "none";
	rnRefs.modalStepsBox.replaceChildren();
	rnRefs.modalManualBox.style.display = "none";
	rnRefs.modalRepoInput.value = "";
	rnRefs.modalSlugInput.value = "";
	rnRefs.modalNameInput.value = "";
	if (!rnRefs.modalUrlInput.value)
		rnRefs.modalUrlInput.value = "http://localhost:3010";
	rnRefs.modalTokenInput.value = "";
	setWizardBusy(false);
	rnRefs.modalBackdrop.style.display = "flex";
}

function closeWizard(): void {
	if (!rnRefs) return;
	rnRefs.modalBackdrop.style.display = "none";
}

function setWizardBusy(busy: boolean): void {
	if (!rnRefs) return;
	const inputs = [
		rnRefs.modalRepoInput,
		rnRefs.modalSlugInput,
		rnRefs.modalNameInput,
		rnRefs.modalUrlInput,
		rnRefs.modalTokenInput,
		rnRefs.modalBrowseBtn,
		rnRefs.modalSubmitBtn,
		rnRefs.modalCancelBtn,
	];
	for (const i of inputs) i.disabled = busy;
	rnRefs.modalSubmitBtn.textContent = busy ? "Setting up…" : "Setup project →";
}

async function doBrowse(): Promise<void> {
	try {
		const r = await req.pickRepoPath({});
		if (!r.ok || !rnRefs) return;
		rnRefs.modalRepoInput.value = r.path;
		rnRefs.modalRepoInput.dispatchEvent(new Event("change"));
	} catch (err) {
		showWizardError((err as Error).message);
	}
}

function showWizardError(msg: string): void {
	if (!rnRefs) return;
	rnRefs.modalErrorBox.textContent = msg;
	rnRefs.modalErrorBox.style.display = "block";
}

async function doSubmitWizard(): Promise<void> {
	if (!rnRefs) return;
	const repoPath = rnRefs.modalRepoInput.value.trim();
	const slug = rnRefs.modalSlugInput.value.trim();
	const name = rnRefs.modalNameInput.value.trim() || slug;
	const platformUrl = rnRefs.modalUrlInput.value.trim();
	const setupToken = rnRefs.modalTokenInput.value.trim();
	if (!repoPath || !slug || !platformUrl || !setupToken) {
		showWizardError("Repo path, slug, platform URL and setup token are required.");
		return;
	}
	rnRefs.modalErrorBox.style.display = "none";
	rnRefs.modalStepsBox.replaceChildren();
	rnRefs.modalStepsBox.style.display = "block";
	rnRefs.modalManualBox.style.display = "none";
	setWizardBusy(true);
	try {
		const result = await req.initProject({
			repoPath,
			slug,
			name,
			platform: "ios",
			platformUrl,
			setupToken,
		});
		renderWizardSteps(result.steps ?? []);
		if (!result.ok) {
			showWizardError(result.error ?? "Unknown error");
			setWizardBusy(false);
			return;
		}
		log(`✓ Project "${result.slug}" set up`, "success");
		await refreshProjectRegistry();
		const inj = result.layoutInjection;
		if (inj && inj.mode === "manual") {
			rnRefs.modalManualPre.textContent = inj.snippet;
			rnRefs.modalManualBox.style.display = "block";
			setWizardBusy(false);
		} else {
			setTimeout(closeWizard, 1500);
		}
	} catch (err) {
		const msg = (err as Error).message;
		showWizardError(msg);
		log(`Setup RPC failed: ${msg}`, "error");
		setWizardBusy(false);
	}
}

function renderWizardSteps(steps: RnInitStep[]): void {
	if (!rnRefs) return;
	const box = rnRefs.modalStepsBox;
	box.replaceChildren();
	for (const s of steps) {
		const row = ce("div", `rn-wizard-step rn-wizard-step-${s.kind}`);
		const icon = ce("span");
		icon.textContent = s.kind === "ok" ? "✓" : s.kind === "warn" ? "!" : s.kind === "error" ? "✗" : "·";
		row.appendChild(icon);
		row.appendChild(document.createTextNode(` ${s.message}`));
		box.appendChild(row);
	}
}

async function doSnap(): Promise<void> {
	if (state.get().rn.busy) return; // double-click guard
	state.set((cur) => ({ ...cur, rn: { ...cur.rn, busy: true } }));
	try {
		const r = await req.performSnap({});
		if (!r.ok) {
			log(r.error, "error");
			return;
		}
		state.set((cur) => ({
			...cur,
			rn: {
				...cur.rn,
				snaps: [...cur.rn.snaps, r.snap],
				selectedIdx: cur.rn.snaps.length,
			},
		}));
		rnSelectedSeq = r.snap.sequence;
		log(`✓ #${r.snap.sequence} ${r.snap.route}`, "success");
		// Diagnostic: tell the user which capture path actually produced
		// the image, so "why is my long page cropped?" debugs itself.
		if (r.captureMethod === "full-page") {
			log("  ↳ full-page via bridge (long content scrolls in viewer)", "info");
		} else if (r.captureMethod === "simctl") {
			const why = r.captureNote
				? r.captureNote.replace(/^[A-Z]/, (c) => c.toLowerCase())
				: "no SnapTarget registered or react-native-view-shot not installed";
			log(`  ↳ viewport-only via simctl (bridge: ${why})`, "warn");
		}
	} finally {
		state.set((cur) => ({ ...cur, rn: { ...cur.rn, busy: false } }));
	}
}

// Drag-and-drop. Source captured at dragstart; cards can move within or
// across flows (cross-flow = re-assign + reorder).
let dragSrc: {
	flowId: string;
	sessionId: string;
	sequence: number;
} | null = null;

// Separate drag track for flow-section reordering — distinct from
// card drag so the two can't be confused on dragover.
let flowDragSrcId: string | null = null;

async function doReorderFlows(orderedIds: string[]): Promise<void> {
	const idx = new Map<string, number>();
	orderedIds.forEach((id, i) => idx.set(id, i));
	state.set((cur) => ({
		...cur,
		rn: {
			...cur.rn,
			flows: [...cur.rn.flows].sort((a, b) => {
				const ai = idx.get(a.id) ?? Number.POSITIVE_INFINITY;
				const bi = idx.get(b.id) ?? Number.POSITIVE_INFINITY;
				return ai - bi;
			}),
		},
	}));
	try {
		await req.reorderFlows({ orderedIds });
	} catch (err) {
		log(`Reorder flows failed: ${(err as Error).message}`, "error");
	}
}

async function doReorder(
	flowId: string,
	ordered: Array<{ sessionId: string; sequence: number }>,
): Promise<void> {
	// Optimistic — apply positions locally so the strip reorders instantly.
	const orderIndex = new Map<string, number>();
	ordered.forEach((id, i) => {
		orderIndex.set(`${id.sessionId}#${id.sequence}`, i + 1);
	});
	state.set((cur) => ({
		...cur,
		rn: {
			...cur.rn,
			snaps: cur.rn.snaps.map((s) => {
				if (s.flowId !== flowId) return s;
				const key = `${s.sessionId}#${s.sequence}`;
				const pos = orderIndex.get(key);
				return pos !== undefined ? { ...s, position: pos } : s;
			}),
		},
	}));
	try {
		await req.reorderSnaps({ flowId, ordered });
	} catch (err) {
		log(`Reorder failed: ${(err as Error).message}`, "error");
	}
}

/**
 * Move one snap into a different flow + reorder. We optimistically update
 * the snap's flowId and the destination's positions, then call the move
 * + reorder RPCs back-to-back. The 1-second poll resyncs anything we got
 * wrong locally.
 */
async function doMoveAndReorder(
	destFlowId: string,
	ordered: Array<{ sessionId: string; sequence: number }>,
	src: { flowId: string; sessionId: string; sequence: number },
): Promise<void> {
	const orderIndex = new Map<string, number>();
	ordered.forEach((id, i) => {
		orderIndex.set(`${id.sessionId}#${id.sequence}`, i + 1);
	});
	const movedKey = `${src.sessionId}#${src.sequence}`;
	state.set((cur) => ({
		...cur,
		rn: {
			...cur.rn,
			snaps: cur.rn.snaps.map((s) => {
				const key = `${s.sessionId}#${s.sequence}`;
				if (key === movedKey) {
					const pos = orderIndex.get(key);
					return { ...s, flowId: destFlowId, position: pos };
				}
				if (s.flowId === destFlowId) {
					const pos = orderIndex.get(key);
					return pos !== undefined ? { ...s, position: pos } : s;
				}
				return s;
			}),
		},
	}));
	try {
		await req.moveSnapsToFlow({
			snapIds: [{ sessionId: src.sessionId, sequence: src.sequence }],
			toFlowId: destFlowId,
		});
		await req.reorderSnaps({ flowId: destFlowId, ordered });
	} catch (err) {
		log(`Move failed: ${(err as Error).message}`, "error");
	}
}

// Pending focus signal — the next render of this flow's section will
// auto-focus + select the title so the user can rename immediately.
let pendingFocusFlowId: string | null = null;

async function doCreateFlow(): Promise<void> {
	const cur = state.get().rn;
	const projectId = cur.selectedProjectSlug;
	if (!projectId) {
		log(
			"Select a project on the left first — flows are scoped per project.",
			"error",
		);
		return;
	}
	// Auto-name within this project's existing flows.
	const existing = cur.flows.filter((f) => f.projectId === projectId);
	let n = existing.length + 1;
	let name = `New flow ${n}`;
	const taken = new Set(existing.map((f) => f.name));
	while (taken.has(name)) {
		n += 1;
		name = `New flow ${n}`;
	}
	try {
		const r = await req.createFlow({ name, projectId });
		log(`+ Created flow "${r.flow.name}"`, "success");
		pendingFocusFlowId = r.flow.id;
		state.set((c) => ({
			...c,
			rn: { ...c.rn, flows: [...c.rn.flows, r.flow] },
		}));
	} catch (err) {
		log(`Create flow failed: ${(err as Error).message}`, "error");
	}
}

async function doCreateSubFlow(parentFlowId: string): Promise<void> {
	const existing = state.get().rn.flows;
	const parent = existing.find((f) => f.id === parentFlowId);
	if (!parent) {
		log("Parent flow not found.", "error");
		return;
	}
	const sibs = existing.filter((f) => f.parentFlowId === parentFlowId);
	let n = sibs.length + 1;
	let name = `Sub-flow ${n}`;
	const taken = new Set(sibs.map((f) => f.name));
	while (taken.has(name)) {
		n += 1;
		name = `Sub-flow ${n}`;
	}
	try {
		const r = await req.createFlow({
			name,
			projectId: parent.projectId,
			parentFlowId,
		});
		log(`+ Created sub-flow "${r.flow.name}"`, "success");
		pendingFocusFlowId = r.flow.id;
		state.set((cur) => ({
			...cur,
			rn: { ...cur.rn, flows: [...cur.rn.flows, r.flow] },
		}));
	} catch (err) {
		log(`Create sub-flow failed: ${(err as Error).message}`, "error");
	}
}

async function doRenameFlow(flowId: string, name: string): Promise<void> {
	state.set((cur) => ({
		...cur,
		rn: {
			...cur.rn,
			flows: cur.rn.flows.map((f) => (f.id === flowId ? { ...f, name } : f)),
		},
	}));
	try {
		const r = await req.renameFlow({ flowId, name });
		if (!r.ok) log(`Rename failed: ${r.error}`, "error");
	} catch (err) {
		log(`Rename failed: ${(err as Error).message}`, "error");
	}
}

async function doRefreshProjectFlows(
	slug: string,
	name: string | undefined,
	btn: HTMLButtonElement,
): Promise<void> {
	const label = name || slug;
	if (btn.classList.contains("is-busy")) return;
	btn.classList.add("is-busy");
	btn.disabled = true;
	log(`Refreshing flows for ${label}…`, "info");
	try {
		const r = await req.refreshProjectFlows({ slug });
		if (!r.ok) {
			log(`Refresh failed for ${label}: ${r.error}`, "error");
			return;
		}
		const tally =
			r.flowsFound !== undefined && r.screensFound !== undefined
				? ` — ${r.flowsFound} flow${r.flowsFound === 1 ? "" : "s"}, ${r.screensFound} screen${r.screensFound === 1 ? "" : "s"}`
				: "";
		log(`✓ Refreshed flows for ${label}${tally}`, "success");
		// Surface CLI's contextual hints (e.g. layout-wiring warnings).
		for (const line of r.output.split("\n").slice(-6)) {
			const trimmed = line.trim();
			if (trimmed.startsWith("⚠") || trimmed.startsWith("💡")) {
				log(`  ${trimmed}`, "info");
			}
		}
	} catch (err) {
		log(`Refresh failed for ${label}: ${(err as Error).message}`, "error");
	} finally {
		btn.classList.remove("is-busy");
		btn.disabled = false;
	}
}

async function doRemoveProject(slug: string, name?: string): Promise<void> {
	const ok = await showConfirm({
		title: `Remove "${name || slug}"?`,
		body: `Removes the project from Capture's local registry — push targets, repo path, and project token. Doesn't touch the project's repo, the platform record, or any uploaded snaps. You can re-add it later via "+ Add".`,
		confirmLabel: "Remove project",
		danger: true,
	});
	if (!ok) return;
	// Optimistic — drop from local state so the row disappears instantly.
	state.set((cur) => ({
		...cur,
		rn: {
			...cur.rn,
			registry: cur.rn.registry.filter((p) => p.slug !== slug),
		},
	}));
	try {
		const r = await req.removeProject({ slug });
		if (!r.ok) {
			log(`Remove failed: ${r.error}`, "error");
			void refreshProjectRegistry(); // resync if the optimistic remove was wrong
			return;
		}
		log(`🗑 Removed project "${name || slug}"`, "info");
	} catch (err) {
		log(`Remove failed: ${(err as Error).message}`, "error");
		void refreshProjectRegistry();
	}
}

async function doDeleteFlow(
	flowId: string,
	flowName: string,
	snapCount: number,
): Promise<void> {
	// Optimistic — drop the flow from local state immediately so the UI
	// doesn't have to wait for the next 1 s poll. The server's deleteFlow
	// also reassigns snaps to a route-based flow; we let the poll catch
	// that up naturally (the snaps land in "Unassigned" for ~1 s in the
	// meantime, which is fine).
	state.set((cur) => ({
		...cur,
		rn: { ...cur.rn, flows: cur.rn.flows.filter((f) => f.id !== flowId) },
	}));
	try {
		const r = await req.deleteFlow({ flowId });
		if (!r.ok) {
			log(`Delete flow failed: ${r.error}`, "error");
			// Re-sync so the optimistic removal doesn't lie.
			try {
				const status = await req.snapServerStatus({});
				state.set((cur) => ({
					...cur,
					rn: { ...cur.rn, flows: status.flows },
				}));
			} catch {}
			return;
		}
		const tail =
			snapCount > 0
				? ` (${snapCount} snap${snapCount === 1 ? "" : "s"} re-routed)`
				: "";
		log(`🗑 Deleted flow "${flowName}"${tail}`, "info");
	} catch (err) {
		log(`Delete flow failed: ${(err as Error).message}`, "error");
	}
}

async function doDeleteSnap(snap: RnSnapInfo): Promise<void> {
	// Optimistically drop the card so it disappears instantly — the next
	// poll would do this anyway, but the UI feels lifeless without it.
	state.set((cur) => ({
		...cur,
		rn: {
			...cur.rn,
			snaps: cur.rn.snaps.filter(
				(s) => !(s.sessionId === snap.sessionId && s.sequence === snap.sequence),
			),
		},
	}));
	try {
		const r = await req.deleteSnap({
			sessionId: snap.sessionId,
			sequence: snap.sequence,
		});
		if (!r.ok) {
			log(`Delete failed: ${r.error}`, "error");
			// Re-sync to fix the optimistic mistake.
			try {
				const status = await req.snapServerStatus({});
				state.set((cur) => ({
					...cur,
					rn: {
						...cur.rn,
						snaps: status.snaps,
						pendingUploads: status.pendingUploads,
					},
				}));
			} catch {}
			return;
		}
		log(`✗ Deleted #${snap.sequence} ${snap.route}`, "info");
	} catch (err) {
		log(`Delete failed: ${(err as Error).message}`, "error");
	}
}

async function doPushPending(): Promise<void> {
	if (state.get().rn.pushing) return; // double-click guard
	const cur = state.get().rn;
	const slug = cur.selectedProjectSlug;
	const projectSnaps = slug
		? cur.snaps.filter((s) => s.projectId === slug)
		: cur.snaps;
	if (projectSnaps.length === 0) {
		log("No snaps to push.", "info");
		return;
	}
	const flowsTouched = new Set(projectSnaps.map((s) => s.flowId)).size;
	const projectName =
		(slug && cur.registry.find((p) => p.slug === slug)?.name) || slug;
	const message = await showPushDialog({
		title: projectName ? `Push to ${projectName}?` : "Push to web?",
		body: `Replace ${projectName ? `"${projectName}"` : "the"} web side with this desktop state — ${projectSnaps.length} snap${projectSnaps.length === 1 ? "" : "s"} across ${flowsTouched} flow${flowsTouched === 1 ? "" : "s"}. Anything not in this push (deleted snaps/flows, old comments) will be removed from the web.`,
		confirmLabel: projectName ? `Push to ${projectName}` : "Push to web",
	});
	if (message === null) return;

	state.set((c) => ({ ...c, rn: { ...c.rn, pushing: true } }));
	try {
		const r = await req.pushAll({
			projectSlug: slug ?? undefined,
			message: message || undefined,
		});
		if (r.synced > 0) {
			log(
				`✓ Synced ${r.synced} snap${r.synced === 1 ? "" : "s"} — web now matches desktop`,
				"success",
			);
		}
		if (r.failed > 0) {
			log(`⚠ ${r.failed} snap${r.failed === 1 ? "" : "s"} failed:`, "error");
			for (const e of r.errors.slice(0, 5)) log(`  ${e}`, "error");
		}
		// Refresh status so cards pick up their new uploaded badges.
		try {
			const status = await req.snapServerStatus({});
			state.set((c) => ({
				...c,
				rn: {
					...c.rn,
					snaps: status.snaps,
					pendingUploads: status.pendingUploads,
				},
			}));
		} catch {}
	} catch (err) {
		log(`Push failed: ${(err as Error).message}`, "error");
	} finally {
		state.set((c) => ({ ...c, rn: { ...c.rn, pushing: false } }));
	}
}

/**
 * Lightweight in-app confirm modal — WKWebView blocks window.confirm,
 * so we render our own backdrop + dialog and resolve a promise on the
 * user's choice. Used by destructive actions like push-replace and
 * project removal.
 */
function showConfirm(opts: {
	title: string;
	body: string;
	confirmLabel: string;
	cancelLabel?: string;
	/** When true, the confirm button uses the danger (red) style. */
	danger?: boolean;
}): Promise<boolean> {
	return new Promise((resolve) => {
		const backdrop = document.createElement("div");
		backdrop.className = "rn-confirm-backdrop";
		const dlg = document.createElement("div");
		dlg.className = "rn-confirm-dialog";

		const title = document.createElement("h3");
		title.className = "rn-confirm-title";
		title.textContent = opts.title;

		const body = document.createElement("p");
		body.className = "rn-confirm-body";
		body.textContent = opts.body;

		const actions = document.createElement("div");
		actions.className = "rn-confirm-actions";
		const cancelBtn = document.createElement("button");
		cancelBtn.className = "btn btn-ghost";
		cancelBtn.textContent = opts.cancelLabel ?? "Cancel";
		const okBtn = document.createElement("button");
		okBtn.className = opts.danger
			? "btn btn-primary rn-confirm-danger"
			: "btn btn-primary";
		okBtn.textContent = opts.confirmLabel;
		actions.append(cancelBtn, okBtn);

		dlg.append(title, body, actions);
		backdrop.appendChild(dlg);
		document.body.appendChild(backdrop);

		const close = (result: boolean) => {
			backdrop.remove();
			document.removeEventListener("keydown", onKey);
			resolve(result);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close(false);
			else if (e.key === "Enter") close(true);
		};
		cancelBtn.addEventListener("click", () => close(false));
		okBtn.addEventListener("click", () => close(true));
		backdrop.addEventListener("click", (e) => {
			if (e.target === backdrop) close(false);
		});
		document.addEventListener("keydown", onKey);
		queueMicrotask(() => okBtn.focus());
	});
}


/**
 * Push dialog with an optional commit-message-style note. Resolves with
 * the trimmed message string if the user pushes, or null if they cancel.
 */
function showPushDialog(opts: {
	title: string;
	body: string;
	confirmLabel: string;
}): Promise<string | null> {
	return new Promise((resolve) => {
		const backdrop = document.createElement("div");
		backdrop.className = "rn-confirm-backdrop";
		const dlg = document.createElement("div");
		dlg.className = "rn-confirm-dialog rn-push-dialog";

		const title = document.createElement("h3");
		title.className = "rn-confirm-title";
		title.textContent = opts.title;

		const body = document.createElement("p");
		body.className = "rn-confirm-body";
		body.textContent = opts.body;

		const fieldLabel = document.createElement("label");
		fieldLabel.className = "rn-push-field-label";
		fieldLabel.textContent = "What changed? (optional)";

		const ta = document.createElement("textarea");
		ta.className = "input rn-push-textarea";
		ta.placeholder = "e.g. Added booking flow, fixed empty cart screen";
		ta.rows = 3;

		const hint = document.createElement("p");
		hint.className = "rn-push-hint";
		hint.textContent = "Shown in the web version history. Leave blank to push without a note.";

		const actions = document.createElement("div");
		actions.className = "rn-confirm-actions";
		const cancelBtn = document.createElement("button");
		cancelBtn.className = "btn btn-ghost";
		cancelBtn.textContent = "Cancel";
		const okBtn = document.createElement("button");
		okBtn.className = "btn btn-primary";
		okBtn.textContent = opts.confirmLabel;
		actions.append(cancelBtn, okBtn);

		dlg.append(title, body, fieldLabel, ta, hint, actions);
		backdrop.appendChild(dlg);
		document.body.appendChild(backdrop);

		const close = (result: string | null): void => {
			backdrop.remove();
			document.removeEventListener("keydown", onKey);
			resolve(result);
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") close(null);
			// Cmd/Ctrl+Enter pushes from inside the textarea; plain Enter just adds a newline.
			else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				close(ta.value.trim());
			}
		};
		cancelBtn.addEventListener("click", () => close(null));
		okBtn.addEventListener("click", () => close(ta.value.trim()));
		backdrop.addEventListener("click", (e) => {
			if (e.target === backdrop) close(null);
		});
		document.addEventListener("keydown", onKey);
		queueMicrotask(() => ta.focus());
	});
}

async function doResetSession(): Promise<void> {
	try {
		await req.resetSnapSession({});
		state.set((cur) => ({
			...cur,
			rn: { ...cur.rn, snaps: [], selectedIdx: -1 },
		}));
		rnSelectedSeq = null;
		log("Snap session reset", "info");
	} catch (err) {
		log(`Reset failed: ${(err as Error).message}`, "error");
	}
}

async function refreshProjectRegistry(): Promise<void> {
	try {
		const r = await req.listProjects({});
		state.set((cur) => ({ ...cur, rn: { ...cur.rn, registry: r.projects } }));
	} catch {
		// ignore
	}
}

// Detect snaps that arrived since the last render so we can shimmer the card
// + show a toast. Set is primed on the first run so existing snaps don't fire.
const seenSnapKeys = new Set<string>();
let seenSnapKeysPrimed = false;
let freshSnapKeysThisRender = new Set<string>();
const snapKey = (s: { sessionId: string; sequence: number }): string =>
	`${s.sessionId}#${s.sequence}`;

function applyRnState(s: AppState): void {
	if (!rnRefs) return;
	const r = s.rn;
	const refs = rnRefs;

	// Compute fresh-this-render snap keys (new since last applyRnState call).
	freshSnapKeysThisRender = new Set();
	if (!seenSnapKeysPrimed) {
		for (const sn of r.snaps) seenSnapKeys.add(snapKey(sn));
		seenSnapKeysPrimed = true;
	} else {
		for (const sn of r.snaps) {
			const k = snapKey(sn);
			if (!seenSnapKeys.has(k)) {
				freshSnapKeysThisRender.add(k);
				seenSnapKeys.add(k);
			}
		}
	}

	// Source tabs — highlight active
	refs.sourceTabBtns.url.classList.toggle("active", s.source.kind === "url");
	refs.sourceTabBtns.local.classList.toggle("active", s.source.kind === "local");
	refs.sourceTabBtns.iossim.classList.toggle("active", s.source.kind === "iossim");

	// Header buttons
	refs.headerSnapBtn.disabled = r.clientCount === 0 || r.busy;
	refs.headerSnapBtn.classList.toggle("is-busy", r.busy);
	refs.headerSnapBtn.textContent = r.busy ? UI.rn.snap.busy : UI.rn.snap.button;
	refs.headerNewSessionBtn.disabled = r.snaps.length === 0 || r.busy;
	// Push is project-scoped when a project is selected — count + label
	// reflect what will actually be sent.
	const pushSnaps = r.selectedProjectSlug
		? r.snaps.filter((s) => s.projectId === r.selectedProjectSlug)
		: r.snaps;
	const hasAnySnaps = pushSnaps.length > 0;
	const projectName =
		(r.selectedProjectSlug &&
			r.registry.find((p) => p.slug === r.selectedProjectSlug)?.name) ||
		r.selectedProjectSlug;
	refs.headerPushBtn.disabled = r.pushing || r.busy || !hasAnySnaps;
	refs.headerPushBtn.classList.toggle("is-busy", r.pushing);
	refs.headerPushBtn.textContent = r.pushing
		? `Pushing… (${pushSnaps.length})`
		: hasAnySnaps
			? projectName
				? `↑ Push ${pushSnaps.length} to ${projectName}`
				: `↑ Push ${pushSnaps.length} to web`
			: "Nothing to push";
	refs.headerPushBtn.title = hasAnySnaps
		? projectName
			? `Replace "${projectName}" web side with this desktop state`
			: "Replace the web side with your current desktop state"
		: "Take some snaps first";

	// Bridge status
	const connected = r.clientCount > 0;
	refs.bridgeDot.className = connected ? "dot success" : "dot warn";
	refs.bridgeTitle.textContent = connected ? UI.rn.bridge.connected : UI.rn.bridge.waiting;
	refs.bridgeSub.textContent = connected
		? r.projects.join(", ") || "(unnamed project)"
		: "port 9876";
	refs.bridgeHint.style.display = connected ? "none" : "block";

	// Session
	refs.sessionIdText.textContent = r.sessionId || "—";
	refs.sessionCountText.textContent = `${r.snaps.length} snap${r.snaps.length === 1 ? "" : "s"}`;

	// Projects list
	refs.projectsList.replaceChildren();
	if (r.registry.length === 0) {
		const empty = ce("div", "rn-projects-empty");
		empty.innerHTML = `No projects yet. Click <b>+ Add</b> to onboard one.`;
		refs.projectsList.appendChild(empty);
	} else {
		for (const p of r.registry) {
			const item = ce("div", "rn-project");
			const connected = r.projects.includes(p.slug);
			const selected = r.selectedProjectSlug === p.slug;
			if (connected) item.classList.add("connected");
			if (selected) item.classList.add("active");
			item.title = p.uploadUrl;
			item.style.cursor = "pointer";
			item.addEventListener("click", () => {
				state.set((cur) => ({
					...cur,
					rn: {
						...cur.rn,
						selectedProjectSlug:
							cur.rn.selectedProjectSlug === p.slug ? null : p.slug,
					},
				}));
			});
			const dot = ce("span", `dot ${connected ? "success" : "muted"}`);
			const meta = ce("div", "rn-project-meta");
			const nameEl = ce("div", "rn-project-name");
			nameEl.textContent = p.name || p.slug;
			const slugEl = ce("div", "rn-project-slug");
			slugEl.textContent = p.slug;
			meta.append(nameEl, slugEl);

			const refreshBtn = ce("button", "rn-project-refresh");
			refreshBtn.type = "button";
			refreshBtn.setAttribute(
				"aria-label",
				`Refresh declared flows for ${p.slug}`,
			);
			refreshBtn.title =
				"Re-scan app/ folder and regenerate snap-flows.ts (run after route changes)";
			refreshBtn.innerHTML = `
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89"/>
					<path d="M13.5 2.5v3h-3"/>
				</svg>
			`;
			refreshBtn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				ev.preventDefault();
				void doRefreshProjectFlows(p.slug, p.name, refreshBtn);
			});

			const removeBtn = ce("button", "rn-project-remove");
			removeBtn.type = "button";
			removeBtn.setAttribute("aria-label", `Remove project ${p.slug}`);
			removeBtn.title = "Remove this project from Capture";
			removeBtn.innerHTML = `
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M2.5 4h11"/>
					<path d="M5.5 4V2.75a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 .75.75V4"/>
					<path d="M3.5 4l.7 9.25a1 1 0 0 0 1 .92h5.6a1 1 0 0 0 1-.92L12.5 4"/>
					<path d="M6.5 7v4"/>
					<path d="M9.5 7v4"/>
				</svg>
			`;
			removeBtn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				ev.preventDefault();
				void doRemoveProject(p.slug, p.name);
			});

			item.append(dot, meta, refreshBtn, removeBtn);
			refs.projectsList.appendChild(item);
		}
	}

	// Snap grid — flow sections in manifest order. Each flow has an editable
	// title; cards within a flow are draggable, and you can drag a card from
	// one flow's strip into another flow's strip to re-assign it.
	refs.previewBox.replaceChildren();

	// Filter both snaps AND flows to the selected project so the two
	// projects' flow trees stay completely isolated. Empty flows from
	// other projects shouldn't show up in this view at all.
	const filteredSnaps = r.selectedProjectSlug
		? r.snaps.filter((s) => s.projectId === r.selectedProjectSlug)
		: r.snaps;
	const filteredFlows = r.selectedProjectSlug
		? r.flows.filter((f) => f.projectId === r.selectedProjectSlug)
		: r.flows;

	const groups = groupSnapsByFlow(filteredSnaps, filteredFlows);
	const visibleGroups = groups.filter(
		(g) => g.snaps.length > 0 || g.flow.id !== "__unassigned__",
	);
	const totalFrames = filteredSnaps.length;

	renderSidebarFlowTree(refs.flowsList, visibleGroups, refs.previewBox);

	const overview = ce("div", "rn-overview");
	const overviewTitle = ce("h2", "rn-overview-title");
	overviewTitle.textContent = "All flows";
	const overviewSub = ce("p", "rn-overview-sub");
	overviewSub.textContent = `${visibleGroups.length} flow${visibleGroups.length === 1 ? "" : "s"} · ${totalFrames} frame${totalFrames === 1 ? "" : "s"}`;
	const newFlowBtn = ce("button", "btn btn-secondary btn-sm rn-new-flow-btn");
	newFlowBtn.textContent = "+ New flow";
	newFlowBtn.title = "Create an empty flow";
	newFlowBtn.addEventListener("click", () => void doCreateFlow());
	const overviewActions = ce("div", "rn-overview-actions");
	overviewActions.appendChild(newFlowBtn);
	const overviewMeta = ce("div", "rn-overview-meta");
	overviewMeta.append(overviewTitle, overviewSub);
	overview.append(overviewMeta, overviewActions);
	refs.previewBox.appendChild(overview);

	if (totalFrames === 0 && visibleGroups.length === 0) {
		const empty = ce("div", "rn-grid-empty");
		empty.textContent = UI.rn.snap.emptyHint;
		refs.previewBox.appendChild(empty);
		return;
	}

	const renderFlowSection = (
		group: RnFlowGroup,
		container: HTMLElement,
		isSub: boolean,
	): void => {
		const flowId = group.flow.id;
		const section = ce("section", isSub ? "rn-flow-section rn-flow-sub" : "rn-flow-section");
		section.dataset.flowId = flowId;
		// Section-level drag/drop for flow reordering. The grab handle in
		// the flow head sets `flowDragSrcId` on dragstart; this section
		// listens for dragover to show the drop indicator and for drop to
		// commit the new order. Sub-flows skip this for now — only top-
		// level flow reorder is supported.
		if (flowId !== "__unassigned__" && !isSub) {
			section.addEventListener("dragover", (ev) => {
				if (!flowDragSrcId || flowDragSrcId === flowId) return;
				ev.preventDefault();
				if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
				const rect = section.getBoundingClientRect();
				const above = ev.clientY < rect.top + rect.height / 2;
				for (const el of refs.previewBox.querySelectorAll(
					".drop-above, .drop-below",
				)) {
					if (el !== section) el.classList.remove("drop-above", "drop-below");
				}
				section.classList.toggle("drop-above", above);
				section.classList.toggle("drop-below", !above);
			});
			section.addEventListener("dragleave", (ev) => {
				if (ev.target === section) {
					section.classList.remove("drop-above", "drop-below");
				}
			});
			section.addEventListener("drop", (ev) => {
				if (!flowDragSrcId || flowDragSrcId === flowId) return;
				ev.preventDefault();
				const above = section.classList.contains("drop-above");
				section.classList.remove("drop-above", "drop-below");
				const cur = state.get().rn.flows;
				const orderedIds = cur.map((f) => f.id).filter((id) => id !== flowDragSrcId);
				let toIdx = orderedIds.indexOf(flowId);
				if (toIdx === -1) toIdx = orderedIds.length;
				if (!above) toIdx += 1;
				orderedIds.splice(toIdx, 0, flowDragSrcId);
				flowDragSrcId = null;
				void doReorderFlows(orderedIds);
			});
		}

		const flowHead = ce("div", "rn-flow-head");
		// Grab handle — only it triggers flow drag, so the rest of the head
		// (title, count, delete button) stays clickable without misfires.
		// Sub-flows don't get a grab handle since reorder is top-level only.
		if (flowId !== "__unassigned__" && !isSub) {
			const grabHandle = ce("span", "rn-flow-grab");
			grabHandle.title = "Drag to reorder this flow";
			grabHandle.textContent = "⋮⋮";
			grabHandle.draggable = true;
			grabHandle.addEventListener("dragstart", (ev) => {
				flowDragSrcId = flowId;
				section.classList.add("flow-dragging");
				if (ev.dataTransfer) {
					ev.dataTransfer.effectAllowed = "move";
					ev.dataTransfer.setData("text/plain", `flow:${flowId}`);
				}
			});
			grabHandle.addEventListener("dragend", () => {
				section.classList.remove("flow-dragging");
				for (const el of refs.previewBox.querySelectorAll(
					".drop-above, .drop-below",
				)) {
					el.classList.remove("drop-above", "drop-below");
				}
				flowDragSrcId = null;
			});
			flowHead.appendChild(grabHandle);
		}
		const flowTitleWrap = ce("div", "rn-flow-title-wrap");
		const flowTitle = ce("h3", "rn-flow-title");
		flowTitle.textContent = group.flow.name;
		flowTitle.contentEditable =
			flowId === "__unassigned__" ? "false" : "plaintext-only";
		flowTitle.spellcheck = false;
		flowTitle.title = "Click to rename this flow";
		flowTitle.addEventListener("focus", () => {
			flowTitle.classList.add("editing");
			// Select all text on first focus so the user can just type.
			const sel = window.getSelection();
			if (sel) {
				const range = document.createRange();
				range.selectNodeContents(flowTitle);
				sel.removeAllRanges();
				sel.addRange(range);
			}
		});
		flowTitle.addEventListener("blur", () => {
			flowTitle.classList.remove("editing");
			const newName = flowTitle.textContent?.trim() ?? "";
			if (!newName || newName === group.flow.name) {
				flowTitle.textContent = group.flow.name;
				return;
			}
			void doRenameFlow(flowId, newName);
		});
		flowTitle.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") {
				ev.preventDefault();
				flowTitle.blur();
			} else if (ev.key === "Escape") {
				ev.preventDefault();
				flowTitle.textContent = group.flow.name;
				flowTitle.blur();
			}
		});

		if (pendingFocusFlowId === flowId) {
			pendingFocusFlowId = null;
			// Defer to next tick so contenteditable + focus listener are wired.
			queueMicrotask(() => flowTitle.focus());
		}

		const flowSubLine = ce("p", "rn-flow-id");
		flowSubLine.textContent = group.flow.autoRoute ?? "(custom flow)";
		flowTitleWrap.append(flowTitle, flowSubLine);

		const flowActions = ce("div", "rn-flow-actions");
		const flowCount = ce("span", "rn-flow-count");
		flowCount.textContent = `${group.snaps.length} frame${group.snaps.length === 1 ? "" : "s"}`;
		flowActions.appendChild(flowCount);
		// + Sub-flow available on any real flow — sub-flows can nest arbitrarily deep.
		if (flowId !== "__unassigned__") {
			const subFlowBtn = ce("button", "btn btn-ghost btn-sm rn-flow-add-sub");
			subFlowBtn.type = "button";
			subFlowBtn.textContent = "+ Sub-flow";
			subFlowBtn.title = `Create a sub-flow inside "${group.flow.name}"`;
			subFlowBtn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				ev.preventDefault();
				void doCreateSubFlow(flowId);
			});
			flowActions.appendChild(subFlowBtn);
		}
		if (flowId !== "__unassigned__") {
			const deleteFlowBtn = ce("button", "rn-flow-delete");
			deleteFlowBtn.type = "button";
			deleteFlowBtn.setAttribute("aria-label", "Delete flow");
			// Inline trash SVG — emoji/unicode trash glyphs render
			// inconsistently across WKWebView, so we draw it ourselves.
			deleteFlowBtn.innerHTML = `
				<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M2.5 4h11"/>
					<path d="M5.5 4V2.75a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 .75.75V4"/>
					<path d="M3.5 4l.7 9.25a1 1 0 0 0 1 .92h5.6a1 1 0 0 0 1-.92L12.5 4"/>
					<path d="M6.5 7v4"/>
					<path d="M9.5 7v4"/>
				</svg>
			`;
			deleteFlowBtn.title =
				group.snaps.length > 0
					? `Delete this flow (its ${group.snaps.length} snap${group.snaps.length === 1 ? "" : "s"} will move back to their route's auto-flow)`
					: "Delete this empty flow";
			deleteFlowBtn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				ev.preventDefault();
				void doDeleteFlow(flowId, group.flow.name, group.snaps.length);
			});
			flowActions.appendChild(deleteFlowBtn);
		}
		flowHead.append(flowTitleWrap, flowActions);
		section.appendChild(flowHead);

		const strip = ce("ol", "rn-strip");
		strip.dataset.flowId = flowId;
		const groupSnapsSnapshot = group.snaps.slice();
		// Strip-level dragover/drop: lets the user drop INTO an empty flow
		// or AFTER the last card without precisely targeting an existing li.
		strip.addEventListener("dragover", (ev) => {
			if (!dragSrc) return;
			// Only accept drops if the cursor is over the strip's empty
			// space (not over an existing li, which has its own handler).
			if (
				ev.target instanceof HTMLElement &&
				ev.target.closest(".rn-strip-item")
			) {
				return;
			}
			ev.preventDefault();
			if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
			strip.classList.add("drop-target");
		});
		strip.addEventListener("dragleave", (ev) => {
			if (ev.target === strip) strip.classList.remove("drop-target");
		});
		strip.addEventListener("drop", (ev) => {
			if (!dragSrc) return;
			if (
				ev.target instanceof HTMLElement &&
				ev.target.closest(".rn-strip-item")
			) {
				return;
			}
			ev.preventDefault();
			strip.classList.remove("drop-target");
			handleStripDrop(flowId, null, groupSnapsSnapshot);
		});

		group.snaps.forEach((snap, idx) => {
			const li = ce("li", "rn-strip-item");
			li.dataset.sessionId = snap.sessionId;
			li.dataset.sequence = String(snap.sequence);

			const card = ce("button", "rn-card");
			card.draggable = true;
			if (freshSnapKeysThisRender.has(snapKey(snap))) {
				card.classList.add("rn-card-fresh");
				// Strip the class once the animation runs so re-renders don't replay it.
				window.setTimeout(() => card.classList.remove("rn-card-fresh"), 950);
			}
			card.addEventListener("dragstart", (ev) => {
				dragSrc = {
					flowId,
					sessionId: snap.sessionId,
					sequence: snap.sequence,
				};
				card.classList.add("dragging");
				if (ev.dataTransfer) {
					ev.dataTransfer.effectAllowed = "move";
					ev.dataTransfer.setData(
						"text/plain",
						`${snap.sessionId}#${snap.sequence}`,
					);
				}
			});
			card.addEventListener("dragend", () => {
				card.classList.remove("dragging");
				for (const el of refs.previewBox.querySelectorAll(
					".drop-before, .drop-after, .drop-target",
				)) {
					el.classList.remove("drop-before", "drop-after", "drop-target");
				}
				dragSrc = null;
			});
			li.addEventListener("dragover", (ev) => {
				if (!dragSrc) return;
				ev.preventDefault();
				if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
				const rect = li.getBoundingClientRect();
				const before = ev.clientX < rect.left + rect.width / 2;
				for (const el of refs.previewBox.querySelectorAll(
					".drop-before, .drop-after",
				)) {
					if (el !== li) el.classList.remove("drop-before", "drop-after");
				}
				li.classList.toggle("drop-before", before);
				li.classList.toggle("drop-after", !before);
			});
			li.addEventListener("dragleave", (ev) => {
				if (ev.target === li) {
					li.classList.remove("drop-before", "drop-after");
				}
			});
			li.addEventListener("drop", (ev) => {
				if (!dragSrc) return;
				ev.preventDefault();
				const dropBefore = li.classList.contains("drop-before");
				li.classList.remove("drop-before", "drop-after");
				const targetKey = `${snap.sessionId}#${snap.sequence}`;
				const srcKey = `${dragSrc.sessionId}#${dragSrc.sequence}`;
				if (targetKey === srcKey && dragSrc.flowId === flowId) return;
				handleStripDrop(flowId, { snap, before: dropBefore }, groupSnapsSnapshot);
			});

			const uploadStatus = snap.uploaded
				? snap.uploaded.ok
					? "uploaded"
					: "failed"
				: "pending";
			card.dataset.upload = uploadStatus;
			card.title =
				uploadStatus === "uploaded"
					? `${snap.route} · #${snap.sequence} · uploaded`
					: uploadStatus === "failed"
						? `${snap.route} · #${snap.sequence} · upload failed (click "Push to web" to retry)`
						: `${snap.route} · #${snap.sequence} · not yet uploaded`;

			const deleteBtn = ce("button", "rn-card-delete");
			deleteBtn.type = "button";
			deleteBtn.title = "Delete this snap";
			deleteBtn.setAttribute("aria-label", "Delete snap");
			deleteBtn.textContent = "×";
			deleteBtn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				ev.preventDefault();
				void doDeleteSnap(snap);
			});

			// Click anywhere on the card opens a lightbox like the web frame page.
			card.style.cursor = "zoom-in";
			card.addEventListener("click", (ev) => {
				const target = ev.target as HTMLElement;
				if (target.closest(".rn-card-delete")) return;
				openSnapLightbox(snap, group.snaps);
			});

			const bezel = ce("div", "rn-bezel");
			const bezelScreen = ce("div", "rn-bezel-screen");
			const img = ce("img", "rn-bezel-img");
			img.src = toFileUrl(snap.imagePath);
			img.alt = `${snap.route} #${snap.sequence}`;
			img.loading = "lazy";
			bezelScreen.appendChild(img);
			const bezelLight = ce("img", "rn-bezel-frame rn-bezel-frame-light");
			bezelLight.src = "iphone-17.png";
			bezelLight.alt = "";
			const bezelDark = ce("img", "rn-bezel-frame rn-bezel-frame-dark");
			bezelDark.src = "iphone-17-dark.png";
			bezelDark.alt = "";
			bezel.append(bezelScreen, bezelLight, bezelDark);

			const cardLabel = ce("div", "rn-card-label");
			const cardName = ce("p", "rn-card-name");
			cardName.textContent = snap.route || "/";
			const cardSub = ce("p", "rn-card-sub");
			cardSub.textContent = new Date(snap.capturedAt).toLocaleTimeString();
			cardLabel.append(cardName, cardSub);

			card.append(deleteBtn, bezel, cardLabel);
			li.appendChild(card);

			if (idx < group.snaps.length - 1) {
				const chev = ce("span", "rn-chevron");
				chev.textContent = "›";
				chev.setAttribute("aria-hidden", "true");
				li.appendChild(chev);
			}
			strip.appendChild(li);
		});

		// Placeholders for declared screens that don't have a captured
		// snap yet — gray dashed cards labeled with the expected name.
		const declaredScreens = group.flow.screens ?? [];
		const missingScreens = declaredScreens.filter(
			(s) =>
				!group.snaps.some((snap) =>
					routeMatchesPattern(
						s.route,
						snap.route,
						s.stateHash,
						snap.stateHash,
					),
				),
		);
		for (const screen of missingScreens) {
			const li = ce("li", "rn-strip-item");
			const card = ce("div", "rn-card rn-placeholder");
			card.title = `${screen.route} — capture this screen to fill the slot`;
			const bezel = ce("div", "rn-bezel rn-bezel-placeholder");
			const bezelScreen = ce("div", "rn-bezel-screen");
			const hint = ce("div", "rn-placeholder-hint");
			hint.textContent = "Snap me";
			bezelScreen.appendChild(hint);
			const bezelLight = ce("img", "rn-bezel-frame rn-bezel-frame-light");
			bezelLight.src = "iphone-17.png";
			bezelLight.alt = "";
			const bezelDark = ce("img", "rn-bezel-frame rn-bezel-frame-dark");
			bezelDark.src = "iphone-17-dark.png";
			bezelDark.alt = "";
			bezel.append(bezelScreen, bezelLight, bezelDark);
			const cardLabel = ce("div", "rn-card-label");
			const cardName = ce("p", "rn-card-name");
			cardName.textContent = screen.name || screen.route;
			const cardSub = ce("p", "rn-card-sub");
			cardSub.textContent = screen.route;
			cardLabel.append(cardName, cardSub);
			card.append(bezel, cardLabel);
			li.appendChild(card);
			strip.appendChild(li);
		}

		if (group.snaps.length === 0 && missingScreens.length === 0) {
			const emptyHint = ce("div", "rn-strip-empty");
			emptyHint.textContent = "Empty flow — drag a card here to populate it.";
			strip.appendChild(emptyHint);
		}

		section.appendChild(strip);

		// Sub-flows: render each child inside the parent section so the
		// nesting is visually clear.
		if (group.children.length > 0) {
			const subWrap = ce("div", "rn-flow-subs");
			for (const child of group.children) {
				renderFlowSection(child, subWrap, true);
			}
			section.appendChild(subWrap);
		}

		container.appendChild(section);
	};

	for (const group of visibleGroups) {
		renderFlowSection(group, refs.previewBox, false);
	}

	// Fire a toast for each truly-new snap. Done after rendering so the card
	// already exists when the user looks (the shimmer guides their eye).
	if (freshSnapKeysThisRender.size > 0) {
		const freshSnaps = filteredSnaps.filter((sn) =>
			freshSnapKeysThisRender.has(snapKey(sn)),
		);
		for (const sn of freshSnaps) {
			showToast(`📸 Snapped ${sn.route || "/"} · #${sn.sequence}`, "success");
		}
	}
}

/**
 * Resolve a drop within / into a flow strip into the right RPC call.
 *  - same flow → reorder
 *  - different flow → move (and reorder afterwards if dropped onto a card)
 */
function handleStripDrop(
	destFlowId: string,
	target: { snap: RnSnapInfo; before: boolean } | null,
	destSnaps: readonly RnSnapInfo[],
): void {
	if (!dragSrc) return;
	const srcKey = `${dragSrc.sessionId}#${dragSrc.sequence}`;
	const sameFlow = dragSrc.flowId === destFlowId;
	const ordered: Array<{ sessionId: string; sequence: number }> = destSnaps
		.filter((s) => `${s.sessionId}#${s.sequence}` !== srcKey)
		.map((s) => ({ sessionId: s.sessionId, sequence: s.sequence }));
	let toIdx: number;
	if (target) {
		toIdx = ordered.findIndex(
			(x) =>
				`${x.sessionId}#${x.sequence}` ===
				`${target.snap.sessionId}#${target.snap.sequence}`,
		);
		if (toIdx === -1) toIdx = ordered.length;
		if (!target.before) toIdx += 1;
	} else {
		toIdx = ordered.length;
	}
	ordered.splice(toIdx, 0, {
		sessionId: dragSrc.sessionId,
		sequence: dragSrc.sequence,
	});

	if (sameFlow) {
		void doReorder(destFlowId, ordered);
	} else {
		void doMoveAndReorder(destFlowId, ordered, dragSrc);
	}
}

interface RnFlowGroup {
	flow: RnFlow;
	snaps: RnSnapInfo[];
	children: RnFlowGroup[];
}

/**
 * Sidebar flow tree — mirrors the web platform's left rail. Click a row to
 * scroll the matching flow section into view and briefly flash it.
 */
function renderSidebarFlowTree(
	host: HTMLElement,
	groups: readonly RnFlowGroup[],
	scroller: HTMLElement,
): void {
	host.replaceChildren();

	if (groups.length === 0) {
		const empty = ce("div", "rn-flows-side-empty");
		empty.textContent = "No flows yet — take a snap to start.";
		host.appendChild(empty);
		return;
	}

	const countSnaps = (g: RnFlowGroup): number =>
		g.snaps.length + g.children.reduce((n, c) => n + countSnaps(c), 0);

	// "Pending" = snap not yet uploaded OR last upload failed. Shows the
	// designer what hasn't made it to the web yet before they push.
	const isPending = (s: RnSnapInfo): boolean =>
		!s.uploaded || s.uploaded.ok === false;
	const countPending = (g: RnFlowGroup): number =>
		g.snaps.filter(isPending).length +
		g.children.reduce((n, c) => n + countPending(c), 0);

	const renderRow = (g: RnFlowGroup, depth: number): void => {
		const row = ce("button", "rn-flow-row");
		row.type = "button";
		row.dataset.targetFlowId = g.flow.id;
		row.style.paddingLeft = `${10 + depth * 14}px`;

		if (depth > 0) {
			const arrow = ce("span", "rn-flow-arrow");
			arrow.textContent = "↳";
			row.appendChild(arrow);
		}

		const name = ce("span", "rn-flow-name");
		name.textContent = g.flow.name;

		const pending = countPending(g);
		if (pending > 0) {
			const dot = ce("span", "rn-flow-pending");
			dot.title = `${pending} not pushed yet`;
			dot.textContent = `•${pending}`;
			row.appendChild(name);
			row.appendChild(dot);
		} else {
			row.appendChild(name);
		}

		const count = ce("span", "rn-flow-count");
		count.textContent = String(countSnaps(g));
		row.append(count);

		row.addEventListener("click", () => {
			const target = scroller.querySelector<HTMLElement>(
				`[data-flow-id="${cssEscape(g.flow.id)}"]`,
			);
			if (!target) return;
			target.scrollIntoView({ behavior: "smooth", block: "start" });
			// Flash highlight + mark active in sidebar
			for (const el of host.querySelectorAll(".rn-flow-row.active")) {
				el.classList.remove("active");
			}
			row.classList.add("active");
			target.classList.add("rn-flow-flash");
			window.setTimeout(() => target.classList.remove("rn-flow-flash"), 900);
		});

		host.appendChild(row);
		for (const child of g.children) renderRow(child, depth + 1);
	};

	for (const g of groups) renderRow(g, 0);
}

function cssEscape(s: string): string {
	// CSS.escape exists in modern WKWebView; fall back to a simple sanitize.
	const w = window as unknown as { CSS?: { escape?: (s: string) => string } };
	return w.CSS?.escape ? w.CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

const SIDEBAR_COLLAPSED_KEY = "prisma:sidebar-collapsed";
function loadSidebarCollapsed(): boolean {
	try {
		return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
	} catch {
		return false;
	}
}
function saveSidebarCollapsed(value: boolean): void {
	try {
		localStorage.setItem(SIDEBAR_COLLAPSED_KEY, value ? "1" : "0");
	} catch {}
}

/**
 * Lightbox preview — opens a snap in a full-screen iPhone bezel like the web
 * frame page. ←/→ navigate within the flow's snaps, Esc closes.
 */
let lightboxCleanup: (() => void) | null = null;
function openSnapLightbox(
	initial: RnSnapInfo,
	siblings: readonly RnSnapInfo[],
): void {
	closeSnapLightbox();
	let idx = Math.max(0, siblings.findIndex(
		(s) => s.sessionId === initial.sessionId && s.sequence === initial.sequence,
	));
	if (idx < 0) idx = 0;

	const backdrop = ce("div", "rn-lightbox-backdrop");
	const stage = ce("div", "rn-lightbox-stage");

	const closeBtn = ce("button", "rn-lightbox-close");
	closeBtn.type = "button";
	closeBtn.setAttribute("aria-label", "Close");
	closeBtn.textContent = "×";

	const header = ce("div", "rn-lightbox-header");
	const title = ce("div", "rn-lightbox-title");
	const sub = ce("div", "rn-lightbox-sub");
	header.append(title, sub);

	const stageMain = ce("div", "rn-lightbox-main");

	const prevBtn = ce("button", "rn-lightbox-nav rn-lightbox-prev");
	prevBtn.type = "button";
	prevBtn.setAttribute("aria-label", "Previous");
	prevBtn.innerHTML = "‹";

	const bezel = ce("div", "rn-lightbox-bezel");
	const bezelScreen = ce("div", "rn-lightbox-bezel-screen");
	const img = ce("img", "rn-lightbox-img");
	img.alt = "";
	bezelScreen.appendChild(img);
	const bezelLight = ce("img", "rn-lightbox-bezel-frame rn-lightbox-bezel-frame-light");
	bezelLight.src = "iphone-17.png";
	bezelLight.alt = "";
	const bezelDark = ce("img", "rn-lightbox-bezel-frame rn-lightbox-bezel-frame-dark");
	bezelDark.src = "iphone-17-dark.png";
	bezelDark.alt = "";
	bezel.append(bezelScreen, bezelLight, bezelDark);

	const nextBtn = ce("button", "rn-lightbox-nav rn-lightbox-next");
	nextBtn.type = "button";
	nextBtn.setAttribute("aria-label", "Next");
	nextBtn.innerHTML = "›";

	// Right inspector panel: route, position, captured time, state hash, upload status.
	const inspector = ce("aside", "rn-lightbox-inspector");
	const inspRouteLabel = ce("div", "rn-insp-label");
	inspRouteLabel.textContent = "Route";
	const inspRoute = ce("div", "rn-insp-value rn-insp-value-mono");
	const inspPosLabel = ce("div", "rn-insp-label");
	inspPosLabel.textContent = "Position";
	const inspPos = ce("div", "rn-insp-value");
	const inspCapLabel = ce("div", "rn-insp-label");
	inspCapLabel.textContent = "Captured";
	const inspCap = ce("div", "rn-insp-value");
	const inspStateLabel = ce("div", "rn-insp-label");
	inspStateLabel.textContent = "State";
	const inspState = ce("div", "rn-insp-value rn-insp-value-mono");
	const inspUploadLabel = ce("div", "rn-insp-label");
	inspUploadLabel.textContent = "Upload";
	const inspUpload = ce("div", "rn-insp-upload");
	inspector.append(
		inspRouteLabel,
		inspRoute,
		inspPosLabel,
		inspPos,
		inspCapLabel,
		inspCap,
		inspStateLabel,
		inspState,
		inspUploadLabel,
		inspUpload,
	);

	stageMain.append(prevBtn, bezel, nextBtn, inspector);

	const footer = ce("div", "rn-lightbox-footer");
	const counter = ce("span", "rn-lightbox-counter");
	const hint = ce("span", "rn-lightbox-hint");
	hint.innerHTML = "<kbd>←</kbd> <kbd>→</kbd> navigate · <kbd>Esc</kbd> close";
	footer.append(counter, hint);

	stage.append(closeBtn, header, stageMain, footer);
	backdrop.appendChild(stage);
	document.body.appendChild(backdrop);

	const update = (): void => {
		const cur = siblings[idx];
		if (!cur) return;
		img.src = toFileUrl(cur.imagePath);
		title.textContent = cur.route || "/";
		sub.textContent = `#${String(cur.sequence).padStart(2, "0")} · ${new Date(cur.capturedAt).toLocaleString()}`;
		counter.textContent = `${idx + 1} / ${siblings.length}`;
		prevBtn.disabled = idx === 0;
		nextBtn.disabled = idx >= siblings.length - 1;

		inspRoute.textContent = cur.route || "/";
		inspPos.textContent = `${idx + 1} of ${siblings.length}`;
		inspCap.textContent = new Date(cur.capturedAt).toLocaleString();
		inspState.textContent = cur.stateHash || "—";
		inspUpload.replaceChildren();
		const dot = ce("span", "rn-insp-dot");
		const text = ce("span");
		if (!cur.uploaded) {
			dot.classList.add("warn");
			text.textContent = "Pending — not pushed yet";
		} else if (cur.uploaded.ok) {
			dot.classList.add("success");
			text.textContent = "Uploaded";
		} else {
			dot.classList.add("error");
			text.textContent = `Failed — ${cur.uploaded.error}`;
		}
		inspUpload.append(dot, text);
	};
	update();

	const onKey = (ev: KeyboardEvent): void => {
		if (ev.key === "Escape") {
			ev.preventDefault();
			closeSnapLightbox();
		} else if (ev.key === "ArrowLeft" && idx > 0) {
			ev.preventDefault();
			idx -= 1;
			update();
		} else if (ev.key === "ArrowRight" && idx < siblings.length - 1) {
			ev.preventDefault();
			idx += 1;
			update();
		}
	};
	prevBtn.addEventListener("click", () => {
		if (idx > 0) {
			idx -= 1;
			update();
		}
	});
	nextBtn.addEventListener("click", () => {
		if (idx < siblings.length - 1) {
			idx += 1;
			update();
		}
	});
	closeBtn.addEventListener("click", closeSnapLightbox);
	backdrop.addEventListener("click", (ev) => {
		if (ev.target === backdrop) closeSnapLightbox();
	});
	window.addEventListener("keydown", onKey);

	lightboxCleanup = (): void => {
		window.removeEventListener("keydown", onKey);
		backdrop.remove();
	};
}

function closeSnapLightbox(): void {
	lightboxCleanup?.();
	lightboxCleanup = null;
}

function flowsEqual(a: readonly RnFlow[], b: readonly RnFlow[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!;
		const y = b[i]!;
		if (
			x.id !== y.id ||
			x.name !== y.name ||
			x.autoRoute !== y.autoRoute ||
			x.parentFlowId !== y.parentFlowId
		) {
			return false;
		}
	}
	return true;
}

/**
 * Group snaps into a parent/child tree of flows. Top-level result contains
 * only flows without a `parentFlowId`; sub-flows nest under their parent.
 * Each group's `snaps` are sorted by (position, capturedAt). Snaps whose
 * flowId doesn't match any flow get bucketed into a synthetic "Unassigned"
 * group at the end of the top-level list.
 */
function groupSnapsByFlow(
	snaps: readonly RnSnapInfo[],
	flows: readonly RnFlow[],
): RnFlowGroup[] {
	const sorted = [...snaps].sort((a, b) => {
		const ap = a.position ?? Number.POSITIVE_INFINITY;
		const bp = b.position ?? Number.POSITIVE_INFINITY;
		if (ap !== bp) return ap - bp;
		return a.capturedAt.localeCompare(b.capturedAt);
	});
	const byFlow = new Map<string, RnSnapInfo[]>();
	for (const s of sorted) {
		const key = s.flowId || "__unassigned__";
		const list = byFlow.get(key);
		if (list) list.push(s);
		else byFlow.set(key, [s]);
	}

	// Index flows by their parent to build the tree in one pass.
	const childrenOf = new Map<string | undefined, RnFlow[]>();
	const flowIds = new Set(flows.map((f) => f.id));
	for (const f of flows) {
		// If parentFlowId points to a missing flow, treat as top-level.
		const key = f.parentFlowId && flowIds.has(f.parentFlowId)
			? f.parentFlowId
			: undefined;
		const list = childrenOf.get(key) ?? [];
		list.push(f);
		childrenOf.set(key, list);
	}

	const buildLevel = (parent: string | undefined): RnFlowGroup[] => {
		const list = childrenOf.get(parent) ?? [];
		return list.map((f) => {
			const snaps = byFlow.get(f.id) ?? [];
			byFlow.delete(f.id);
			return { flow: f, snaps, children: buildLevel(f.id) };
		});
	};
	const top = buildLevel(undefined);

	if (byFlow.size > 0) {
		const orphans: RnSnapInfo[] = [];
		for (const list of byFlow.values()) orphans.push(...list);
		if (orphans.length > 0) {
			top.push({
				flow: { id: "__unassigned__", name: "Unassigned" },
				snaps: orphans,
				children: [],
			});
		}
	}
	return top;
}

function snapShortName(flowName: string, step: number): string {
	return `${flowName} · step ${String(step).padStart(2, "0")}`;
}

/**
 * Match a route pattern against an actual snap route. Pattern can use
 * `:param` placeholders (Expo `[id]` is normalized to `:id` by the
 * scan CLI). Optional stateHash filter — when both sides set it, they
 * must match exactly; otherwise stateHash is ignored.
 */
function routeMatchesPattern(
	pattern: string,
	actual: string,
	patternStateHash?: string,
	actualStateHash?: string,
): boolean {
	if (patternStateHash && patternStateHash !== actualStateHash) return false;
	if (pattern === actual) return true;
	if (!pattern.includes(":")) return false;
	const re = new RegExp(
		`^${pattern
			.split("/")
			.map((seg) =>
				seg.startsWith(":")
					? "[^/]+"
					: seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
			)
			.join("/")}$`,
	);
	return re.test(actual);
}

// Mirror polling intentionally removed — constant simctl screenshots were
// slowing the snap pipeline + burning battery. The `mirrorSimulator` RPC and
// the touch-forwarding RPC are still wired up in the main process for future
// re-enablement (optional live-mirror toggle, scheduled snap captures, etc.).

function ensureRnPolling(): void {
	if (rnPollTimer) return;
	rnPollTimer = setInterval(async () => {
		if (state.get().source.kind !== "iossim") {
			if (rnPollTimer) {
				clearInterval(rnPollTimer);
				rnPollTimer = null;
			}
			return;
		}
		try {
			const status = await req.snapServerStatus({});
			const cur = state.get();
			// Auto-select the bridge-connected project when no selection yet,
			// so the grid filters to the right one out of the box.
			const autoSelect =
				!cur.rn.selectedProjectSlug && status.projects.length > 0
					? status.projects[0]!
					: cur.rn.selectedProjectSlug;
			const same =
				cur.rn.clientCount === status.clientCount &&
				cur.rn.projects.join("|") === status.projects.join("|") &&
				cur.rn.sessionId === status.sessionId &&
				cur.rn.snaps.length === status.snaps.length &&
				cur.rn.flows.length === status.flows.length &&
				cur.rn.pendingUploads === status.pendingUploads &&
				flowsEqual(cur.rn.flows, status.flows);
			if (same) return;
			state.set((c) => ({
				...c,
				rn: {
					...c.rn,
					clientCount: status.clientCount,
					projects: status.projects,
					sessionId: status.sessionId,
					snaps: status.snaps,
					flows: status.flows,
					pendingUploads: status.pendingUploads,
				},
			}));
		} catch {
			// transient — keep polling
		}
	}, 1000);
}

state.subscribe((s) => {
	if (s.source.kind === "iossim") {
		ensureRnPolling();
		if (s.rn.registry.length === 0) void refreshProjectRegistry();
	}
});

// Cmd+Shift+S → snap (only when in RN mode)
window.addEventListener("keydown", (e) => {
	if (
		(e.metaKey || e.ctrlKey) &&
		e.shiftKey &&
		(e.key === "s" || e.key === "S")
	) {
		if (state.get().source.kind === "iossim") {
			e.preventDefault();
			void doSnap();
		}
	}
});

// Cmd+P → push to web (only in RN mode + when not typing in an input)
window.addEventListener("keydown", (e) => {
	if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
	if (e.key !== "p" && e.key !== "P") return;
	if (isTypingInField(e.target)) return;
	if (state.get().source.kind !== "iossim") return;
	e.preventDefault();
	void doPushPending();
});

// `?` (or Shift+/) → toggle keyboard shortcut overlay
window.addEventListener("keydown", (e) => {
	if (e.metaKey || e.ctrlKey || e.altKey) return;
	if (isTypingInField(e.target)) return;
	if (e.key === "?" || (e.shiftKey && e.key === "/")) {
		e.preventDefault();
		toggleShortcutOverlay();
	} else if (e.key === "Escape") {
		closeShortcutOverlay();
	}
});

function isTypingInField(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	return (
		tag === "INPUT" ||
		tag === "TEXTAREA" ||
		tag === "SELECT" ||
		target.isContentEditable
	);
}

let shortcutOverlay: HTMLDivElement | null = null;
function toggleShortcutOverlay(): void {
	if (shortcutOverlay) closeShortcutOverlay();
	else openShortcutOverlay();
}
function openShortcutOverlay(): void {
	if (shortcutOverlay) return;
	const backdrop = document.createElement("div");
	backdrop.className = "rn-shortcut-backdrop";

	const card = document.createElement("div");
	card.className = "rn-shortcut-card";

	const title = document.createElement("h3");
	title.className = "rn-shortcut-title";
	title.textContent = "Keyboard shortcuts";

	const closeBtn = document.createElement("button");
	closeBtn.className = "rn-shortcut-close";
	closeBtn.type = "button";
	closeBtn.setAttribute("aria-label", "Close");
	closeBtn.textContent = "×";

	const groups: Array<{ heading: string; items: Array<[string[], string]> }> = [
		{
			heading: "Capture",
			items: [
				[["⌘", "⇧", "S"], "Take a snap"],
				[["⌘", "P"], "Push to web"],
			],
		},
		{
			heading: "Browse",
			items: [
				[["←"], "Previous frame in lightbox"],
				[["→"], "Next frame in lightbox"],
				[["Esc"], "Close dialog / lightbox"],
			],
		},
		{
			heading: "Editing",
			items: [
				[["Enter"], "Confirm dialog"],
				[["⌘", "Enter"], "Submit push (in dialog)"],
			],
		},
		{
			heading: "Help",
			items: [[["?"], "Toggle this overlay"]],
		},
	];

	const list = document.createElement("div");
	list.className = "rn-shortcut-groups";
	for (const g of groups) {
		const section = document.createElement("section");
		section.className = "rn-shortcut-group";
		const h = document.createElement("h4");
		h.className = "rn-shortcut-group-title";
		h.textContent = g.heading;
		section.appendChild(h);
		const ul = document.createElement("ul");
		ul.className = "rn-shortcut-list";
		for (const [keys, label] of g.items) {
			const li = document.createElement("li");
			const keysWrap = document.createElement("span");
			keysWrap.className = "rn-shortcut-keys";
			for (const k of keys) {
				const kbd = document.createElement("kbd");
				kbd.textContent = k;
				keysWrap.appendChild(kbd);
			}
			const labelEl = document.createElement("span");
			labelEl.className = "rn-shortcut-label";
			labelEl.textContent = label;
			li.append(keysWrap, labelEl);
			ul.appendChild(li);
		}
		section.appendChild(ul);
		list.appendChild(section);
	}

	card.append(closeBtn, title, list);
	backdrop.appendChild(card);
	document.body.appendChild(backdrop);
	shortcutOverlay = backdrop;

	closeBtn.addEventListener("click", closeShortcutOverlay);
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) closeShortcutOverlay();
	});
}
function closeShortcutOverlay(): void {
	if (!shortcutOverlay) return;
	shortcutOverlay.remove();
	shortcutOverlay = null;
}

