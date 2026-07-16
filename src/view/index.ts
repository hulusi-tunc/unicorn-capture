import { Electroview } from "electrobun/view";
import type {
	FlowResult,
	RnFlow,
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
import { icon, type IconName } from "../lib/icon";
import { Store } from "../lib/store";
import { openWizardV2 } from "./wizard-v2";
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
	/** Signed-in user (token-free; tokens stay in the bun process). Null = signed out. */
	session: import("../lib/rpc").AuthSessionInfo | null;
	/** True once the boot session check has run — gates the sign-in screen so it
	 *  doesn't flash for an already-signed-in user while hydrating. */
	authChecked: boolean;
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
		/**
		 * Live route the bridge most recently reported for the selected
		 * project. Drives the topbar "Bridge sees: /foo" pill so the
		 * designer knows what would be captured before clicking Snap.
		 * Null when no bridge is connected or polling hasn't returned
		 * yet; empty string is treated like null.
		 */
		currentRoute: string | null;
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
	session: null,
	authChecked: false,
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
		currentRoute: null,
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
// `onInitProgress` is streamed from the bun-side installer per step
// transition. We fan it out to whichever wizard instance is currently
// open via `progressListeners` (`subscribeInstallProgress`).
const progressListeners = new Set<
	(msg: import("../lib/rpc").InstallProgressMessage) => void
>();
function subscribeInstallProgress(
	handler: (msg: import("../lib/rpc").InstallProgressMessage) => void,
): () => void {
	progressListeners.add(handler);
	return () => {
		progressListeners.delete(handler);
	};
}

// `onUpdateReady` is pushed bun→view once an auto-update has finished
// downloading and is ready to apply. Fanned out to whoever subscribed (the
// restart banner), mirroring `progressListeners`.
const updateReadyListeners = new Set<
	(msg: import("../lib/rpc").UpdateReadyMessage) => void
>();
function subscribeUpdateReady(
	handler: (msg: import("../lib/rpc").UpdateReadyMessage) => void,
): () => void {
	updateReadyListeners.add(handler);
	return () => {
		updateReadyListeners.delete(handler);
	};
}

const rpc = Electroview.defineRPC<ScenarioRunnerRPC>({
	maxRequestTime: 600000,
	handlers: {
		requests: {},
		messages: {
			onInitProgress: (msg: import("../lib/rpc").InstallProgressMessage) => {
				for (const l of progressListeners) {
					try {
						l(msg);
					} catch (err) {
						console.error("progress listener crashed:", err);
					}
				}
			},
			onUpdateReady: (msg: import("../lib/rpc").UpdateReadyMessage) => {
				for (const l of updateReadyListeners) {
					try {
						l(msg);
					} catch (err) {
						console.error("updateReady listener crashed:", err);
					}
				}
			},
		},
	},
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
// Brand + actions live in #global-topbar (see index.html); no per-mode header.
function renderHeader(): string {
	return "";
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
					${renderUrlInput(s.source.kind === "url" ? s.source.url : "")}
					<div class="src-divider"><span>or drop a folder / archive</span></div>
					${renderDropzone(s.source.kind === "local" ? "local" : "local", s.source.kind === "local" ? s.source.path : "")}
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

	// Auth gate — nothing else mounts until the user is signed in. While the
	// boot session check is still running (authChecked === false), keep every
	// root hidden so an already-signed-in user never sees the sign-in form flash.
	ensureSigninMounted();
	if (s.session == null) {
		setSigninVisible(s.authChecked);
		setDashVisible(false);
		setRnVisible(false);
		setWebVisible(false);
		setAppVisible(false);
		if (
			s.authChecked &&
			signinRefs &&
			!signinRefs.email.value &&
			document.activeElement !== signinRefs.email
		) {
			signinRefs.email.focus();
		}
		return;
	}
	setSigninVisible(false);

	const slug = s.rn.selectedProjectSlug;
	const onDashboard = slug == null;
	const inProjectType = onDashboard ? null : projectTypeOf(slug);
	const inMobile = inProjectType === "mobile";
	const inWeb = inProjectType === "web";

	// Three persistent roots — toggle visibility, never rebuild.
	ensureDashMounted();
	ensureRnMounted();
	ensureWebMounted();
	setDashVisible(onDashboard);
	setRnVisible(inMobile);
	setWebVisible(inWeb);
	setAppVisible(false); // legacy URL/Local UI is fully replaced.

	if (onDashboard) {
		applyDashState(s);
		return;
	}
	if (inMobile) {
		applyRnState(s);
		return;
	}
	if (inWeb) {
		applyWebState(s);
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

// ─── WEB MODE — Library snaps (manual workflow, MVP) ───────────────────
//
// Each "snap" in web mode is a screenshot of whatever URL the iframe is
// currently showing. Cards live in the Library tab + are persisted in
// localStorage so they survive across Capture restarts. No flow tree
// yet — designers organize manually with their own taxonomy via Claude
// Code (paste-mode improver) or just an "All snaps" bucket.

interface WebSnapRecord {
	id: string;
	url: string;
	title?: string;
	capturedAt: string;
	imagePath: string;
}

const WEB_SNAPS_KEY = "prisma:web-snaps";

function loadWebSnaps(): WebSnapRecord[] {
	const raw = readLocal(WEB_SNAPS_KEY);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as WebSnapRecord[]) : [];
	} catch {
		return [];
	}
}

function saveWebSnaps(snaps: WebSnapRecord[]): void {
	writeLocal(WEB_SNAPS_KEY, JSON.stringify(snaps));
}

function appendWebSnap(snap: WebSnapRecord): void {
	const list = loadWebSnaps();
	list.unshift(snap);
	saveWebSnaps(list);
	if (webRefs) renderWebLibrary(webRefs);
}

function removeWebSnap(id: string): void {
	const list = loadWebSnaps().filter((s) => s.id !== id);
	saveWebSnaps(list);
	if (webRefs) renderWebLibrary(webRefs);
}

async function doWebSnap(): Promise<void> {
	if (!webRefs) return;
	const slug = state.get().rn.selectedProjectSlug;
	if (!slug) {
		log("Web snap: no project selected — open a project first.", "warn");
		return;
	}
	const iframe = webRefs.iframe;
	// Scroll the iframe fully into view before snap so captureRect can
	// grab the whole 1440×900 surface even when the Capture window is
	// narrower (the wrap scrolls but the iframe is rendered at full
	// size). Without this, off-screen edges return blank pixels.
	iframe.scrollIntoView({ block: "start", inline: "start" });
	await new Promise((r) => setTimeout(r, 50));
	const rect = iframe.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) {
		log("Web snap: iframe isn't sized yet — load a URL first.", "warn");
		return;
	}
	const x = window.screenX + rect.left;
	const y =
		window.screenY + rect.top + (window.outerHeight - window.innerHeight);
	const url = webRefs.urlInput.value.trim() || iframe.src || "(no url)";
	let title: string | undefined;
	try {
		title = iframe.contentDocument?.title || undefined;
	} catch {
		// Cross-origin iframe; can't read title. That's fine.
	}
	const tempName = `web-tmp-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`;
	const r = await req.captureRect({
		x: Math.max(0, x),
		y: Math.max(0, y),
		width: rect.width,
		height: rect.height,
		name: tempName,
	});
	if (!r.ok) {
		log(`Web snap failed: ${r.error}`, "error");
		return;
	}
	const recorded = await req.performWebSnap({
		slug,
		url,
		tempImagePath: r.path as string,
		title,
	});
	if (!recorded.ok) {
		log(`Web snap failed: ${recorded.error}`, "error");
		return;
	}
	// Push the new snap into rn.snaps so the sidebar count + library tab
	// update immediately. Auto-created flow is ingested via a manifest
	// re-pull at the end so the sidebar shows it on the first snap of a
	// new route prefix.
	state.set((cur) => ({
		...cur,
		rn: { ...cur.rn, snaps: [...cur.rn.snaps, recorded.snap] },
	}));
	log(
		`✓ Snapped #${recorded.snap.sequence} ${recorded.route} → Placed in ${recorded.placement.flowName}${recorded.placement.screenName ? ` → ${recorded.placement.screenName}` : ""}`,
		"success",
	);
	// Re-pull the flow list from the orchestrator — the snap may have
	// auto-created a new flow (first time the path prefix was seen).
	try {
		const status = await req.snapServerStatus({});
		state.set((cur) => ({
			...cur,
			rn: { ...cur.rn, flows: status.flows },
		}));
	} catch {
		// Ignore — sidebar may show a 1-tick-stale flow tree until the
		// next state pump.
	}
}

function renderWebLibrary(refs: WebRefs): void {
	const grid = refs.libraryGrid;
	const s = state.get();
	const slug = s.rn.selectedProjectSlug;
	grid.replaceChildren();
	if (!slug) {
		const empty = ce("div", "web-library-empty");
		const h = ce("div", "web-library-empty-hint");
		h.textContent = "Open a web project to see its library.";
		empty.append(h);
		grid.appendChild(empty);
		return;
	}
	const snaps = s.rn.snaps.filter((sn) => sn.projectId === slug);
	const projectFlows = s.rn.flows.filter((f) => f.projectId === slug);

	// Overview header at the top of the Library — flow count + "+ New flow"
	// button, mirroring mobile. Sits above all the per-flow sections.
	const overview = ce("div", "web-library-overview");
	const overviewLeft = ce("div", "web-library-overview-text");
	const overviewTitle = ce("h2", "web-library-overview-title");
	overviewTitle.textContent = "All flows";
	const overviewSub = ce("p", "web-library-overview-sub");
	const totalFrames = snaps.length;
	overviewSub.textContent = `${projectFlows.length} flow${projectFlows.length === 1 ? "" : "s"} · ${totalFrames} frame${totalFrames === 1 ? "" : "s"}`;
	overviewLeft.append(overviewTitle, overviewSub);
	const newFlowBtn = ce("button", "btn btn-secondary btn-sm");
	newFlowBtn.type = "button";
	newFlowBtn.textContent = "+ New flow";
	newFlowBtn.title = "Create an empty flow";
	newFlowBtn.addEventListener("click", () => void doCreateFlow());
	overview.append(overviewLeft, newFlowBtn);
	grid.appendChild(overview);

	if (snaps.length === 0 && projectFlows.length === 0) {
		const empty = ce("div", "web-library-empty");
		const i = ce("div", "web-library-empty-icon");
		i.appendChild(icon("image", { size: 28, strokeWidth: 1.5 }));
		const t = ce("div", "web-library-empty-title");
		t.textContent = "No snaps yet";
		const h = ce("div", "web-library-empty-hint");
		h.textContent =
			"Open the page in Chrome, click the Unicorn Capture extension, and snap.";
		empty.append(i, t, h);
		grid.appendChild(empty);
		return;
	}
	// Build the hierarchical group tree so sub-flows render NESTED inside
	// their parent section (matches mobile). Without this, sub-flows show
	// up as separate top-level sections and the parent/child relationship
	// is invisible.
	const groups = groupSnapsByFlow(snaps, projectFlows);
	const renderGroup = (
		group: RnFlowGroup,
		parentContainer: HTMLElement,
		depth: number,
	): void => {
		const flowId = group.flow.id;
		const bucket = group.snaps;
		const section = ce("section", "web-library-section");
		if (depth > 0) section.classList.add("is-sub");
		section.dataset.flowId = flowId;
		const header = ce("div", "web-library-section-head");
		const flowName =
			group.flow.name ??
			(flowId === "__unassigned__" ? "Unassigned" : flowId);
		const name = ce("h4", "web-library-section-title");
		name.textContent = flowName;
		// Editable for real flows — Unassigned bucket isn't a real flow so
		// it has no row in the manifest to rename.
		if (flowId !== "__unassigned__") {
			name.contentEditable = "plaintext-only";
			name.spellcheck = false;
			name.title = "Click to rename this flow — Enter saves, Esc cancels";
			name.addEventListener("focus", () => {
				name.classList.add("editing");
				const sel = window.getSelection();
				if (sel) {
					const range = document.createRange();
					range.selectNodeContents(name);
					sel.removeAllRanges();
					sel.addRange(range);
				}
			});
			name.addEventListener("blur", () => {
				name.classList.remove("editing");
				const next = name.textContent?.trim() ?? "";
				if (!next || next === flowName) {
					name.textContent = flowName;
					return;
				}
				void doRenameFlow(flowId, next);
			});
			name.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") {
					ev.preventDefault();
					name.blur();
				} else if (ev.key === "Escape") {
					ev.preventDefault();
					name.textContent = flowName;
					name.blur();
				}
			});
		}
		const count = ce("span", "web-library-section-count");
		count.textContent = String(bucket.length);
		header.append(name, count);

		const headerActions = ce("div", "web-library-section-actions");
		if (flowId !== "__unassigned__") {
			const subFlowBtn = ce("button", "btn btn-ghost btn-sm");
			subFlowBtn.type = "button";
			subFlowBtn.textContent = "+ Sub-flow";
			subFlowBtn.title = `Create a sub-flow inside "${flowName}"`;
			subFlowBtn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				void doCreateSubFlow(flowId);
			});
			headerActions.appendChild(subFlowBtn);

			const deleteFlowBtn = ce("button", "btn btn-ghost btn-sm web-library-section-delete");
			deleteFlowBtn.type = "button";
			deleteFlowBtn.title = "Delete this flow (snaps move to Unassigned)";
			deleteFlowBtn.textContent = "Delete";
			deleteFlowBtn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				void doDeleteFlow(flowId, flowName, bucket.length);
			});
			headerActions.appendChild(deleteFlowBtn);
		}
		header.appendChild(headerActions);
		section.appendChild(header);

		const flowGrid = ce("div", "web-library-section-grid");
		// Section is the cross-flow drop target. Dragging a card from
		// another section here moves it under this flow via the existing
		// moveSnapsToFlow RPC (mobile uses the same backend for grid
		// drags). Highlight on dragenter, commit on drop.
		// stopPropagation is critical for nested sub-flow sections — without
		// it, a drop on a child section bubbles to its parent and the
		// parent's drop handler immediately re-moves the snap back to the
		// parent flow.
		section.addEventListener("dragover", (ev) => {
			if (!ev.dataTransfer?.types.includes("application/x-web-snap")) return;
			ev.preventDefault();
			ev.stopPropagation();
			ev.dataTransfer.dropEffect = "move";
			section.classList.add("is-drop-target");
		});
		section.addEventListener("dragleave", (ev) => {
			if (ev.target === section || ev.currentTarget === ev.target) {
				section.classList.remove("is-drop-target");
			}
		});
		section.addEventListener("drop", (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			section.classList.remove("is-drop-target");
			const payload = ev.dataTransfer?.getData("application/x-web-snap");
			if (!payload) return;
			try {
				const { sessionId, sequence } = JSON.parse(payload) as {
					sessionId: string;
					sequence: number;
				};
				void doMoveWebSnapToFlow(sessionId, sequence, flowId);
			} catch {}
		});

		const flowSnaps = bucket;
		for (const sn of flowSnaps) {
			const card = ce("button", "web-library-card");
			card.type = "button";
			if (sn.fullPage) card.classList.add("is-full-page");
			if (freshSnapKeysThisRender.has(snapKey(sn))) {
				card.classList.add("is-fresh");
				window.setTimeout(() => card.classList.remove("is-fresh"), 950);
			}
			card.draggable = true;
			card.dataset.sessionId = sn.sessionId;
			card.dataset.sequence = String(sn.sequence);

			card.addEventListener("dragstart", (ev) => {
				if (!ev.dataTransfer) return;
				ev.dataTransfer.effectAllowed = "move";
				ev.dataTransfer.setData(
					"application/x-web-snap",
					JSON.stringify({
						sessionId: sn.sessionId,
						sequence: sn.sequence,
					}),
				);
				dragSrc = {
					flowId,
					sessionId: sn.sessionId,
					sequence: sn.sequence,
				};
				card.classList.add("is-dragging");
			});
			card.addEventListener("dragend", () => {
				dragSrc = null;
				card.classList.remove("is-dragging");
				for (const el of grid.querySelectorAll(
					".is-drop-target, .drop-before, .drop-after",
				)) {
					el.classList.remove(
						"is-drop-target",
						"drop-before",
						"drop-after",
					);
				}
			});

			// Card-level drop target: insert before/after this card within
			// the flow (or move across flows with reorder). Stops propagation
			// so the section's append-on-drop doesn't double-fire.
			card.addEventListener("dragover", (ev) => {
				if (!dragSrc) return;
				if (!ev.dataTransfer?.types.includes("application/x-web-snap")) {
					return;
				}
				ev.preventDefault();
				ev.stopPropagation();
				ev.dataTransfer.dropEffect = "move";
				// Horizontal split (matches mobile + the grid's left-to-right
				// flow) — left half drops before this card, right half after.
				const rect = card.getBoundingClientRect();
				const before = ev.clientX - rect.left < rect.width / 2;
				for (const el of grid.querySelectorAll(".drop-before, .drop-after")) {
					if (el !== card) el.classList.remove("drop-before", "drop-after");
				}
				card.classList.toggle("drop-before", before);
				card.classList.toggle("drop-after", !before);
			});
			card.addEventListener("dragleave", (ev) => {
				if (ev.target === card) {
					card.classList.remove("drop-before", "drop-after");
				}
			});
			card.addEventListener("drop", (ev) => {
				if (!dragSrc) return;
				ev.preventDefault();
				ev.stopPropagation();
				const before = card.classList.contains("drop-before");
				card.classList.remove("drop-before", "drop-after");
				const targetKey = `${sn.sessionId}#${sn.sequence}`;
				const srcKey = `${dragSrc.sessionId}#${dragSrc.sequence}`;
				if (targetKey === srcKey && dragSrc.flowId === flowId) return;
				handleStripDrop(
					flowId,
					{ snap: sn, before },
					flowSnaps,
				);
			});

			if (sn.fullPage) {
				const badge = ce("div", "web-library-badge");
				badge.textContent = "FULL PAGE";
				card.appendChild(badge);
			}

			// Thumbnail: standard viewport snaps render as a 16:10 cover-cropped
			// img. Full-page snaps wrap the natural-size img in a 16:10 scroll
			// container so the card stays the same height as its siblings —
			// users scroll inside the thumbnail to preview the long page, or
			// click for the lightbox with the full image.
			const thumb = ce("img", "web-library-thumb");
			thumb.src = snapImageSrcFromInfo(sn);
			thumb.alt = sn.route;
			thumb.loading = "lazy";
			thumb.addEventListener("error", () => {
				thumb.style.display = "none";
				card.classList.add("is-missing");
				card.title =
					"Screenshot file missing on disk — click × to remove this stale snap";
			});
			let thumbHost: HTMLElement = thumb;
			if (sn.fullPage) {
				const scroll = ce("div", "web-library-thumb-scroll");
				scroll.appendChild(thumb);
				// Wheel-scrolling the inner container would normally bubble and
				// also scroll the library grid. Stop bubbling so the user can
				// preview the long page without scrolling the whole library.
				scroll.addEventListener("wheel", (ev) => ev.stopPropagation());
				thumbHost = scroll;
			}

			// "Updated" badge — shown when re-snap added a version since the
			// user last opened this slot's lightbox. Matches the mobile UX so
			// designers spot fresh work without scanning timestamps.
			const versionCount = (sn.versions?.length ?? 0) + 1;
			const seenKey = `prisma:seen:${sn.projectId}:${sn.sessionId}#${sn.sequence}`;
			const seenCount = Number(readLocal(seenKey) || "0") || 0;
			const isUpdated = versionCount > Math.max(seenCount, 1);
			let updatedBadge: HTMLElement | null = null;
			if (isUpdated) {
				updatedBadge = ce("span", "web-library-updated");
				updatedBadge.textContent = "Updated";
				updatedBadge.title = `Re-snapped — ${versionCount} versions total.`;
				card.appendChild(updatedBadge);
			}

			// Card-anywhere click opens the lightbox + clears the Updated
			// badge. Skip when clicking the title (in-place rename), the
			// delete button, or when the underlying file is missing.
			card.style.cursor = "zoom-in";
			card.addEventListener("click", (ev) => {
				const target = ev.target as HTMLElement;
				if (target.closest(".web-library-del")) return;
				if (target.closest(".web-library-title")) return;
				if (card.classList.contains("is-missing")) return;
				writeLocal(seenKey, String(versionCount));
				if (updatedBadge?.isConnected) updatedBadge.remove();
				openWebSnapLightbox(sn);
			});

			const meta = ce("div", "web-library-meta");
			const currentLabel = sn.displayName || sn.route;
			const titleEl = ce("div", "web-library-title");
			titleEl.textContent = currentLabel;
			titleEl.contentEditable = "plaintext-only";
			titleEl.spellcheck = false;
			titleEl.title = "Click to rename — Enter saves, Esc cancels";
			titleEl.draggable = false;
			titleEl.addEventListener("pointerdown", (ev) => ev.stopPropagation());
			titleEl.addEventListener("dragstart", (ev) => ev.preventDefault());
			titleEl.addEventListener("click", (ev) => ev.stopPropagation());
			titleEl.addEventListener("focus", () => {
				titleEl.classList.add("editing");
				const sel = window.getSelection();
				if (sel) {
					const range = document.createRange();
					range.selectNodeContents(titleEl);
					sel.removeAllRanges();
					sel.addRange(range);
				}
			});
			titleEl.addEventListener("blur", () => {
				titleEl.classList.remove("editing");
				const next = titleEl.textContent?.trim() ?? "";
				if (next === currentLabel) return;
				void doRenameSnap(sn.sessionId, sn.sequence, next);
			});
			titleEl.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") {
					ev.preventDefault();
					titleEl.blur();
				} else if (ev.key === "Escape") {
					ev.preventDefault();
					titleEl.textContent = currentLabel;
					titleEl.blur();
				}
			});

			const url = ce("div", "web-library-url");
			url.textContent = `#${sn.sequence}`;
			const time = ce("div", "web-library-time");
			time.textContent = new Date(sn.capturedAt).toLocaleString();
			const status = ce("div", "web-library-status");
			if (!sn.uploaded || sn.uploaded.ok === false) {
				status.textContent = "• not pushed";
				status.classList.add("is-pending");
			} else {
				status.textContent = "• pushed";
				status.classList.add("is-ok");
			}
			meta.append(titleEl, url, time, status);

			const del = ce("button", "web-library-del");
			del.type = "button";
			del.title = "Delete snap";
			del.setAttribute("aria-label", `Delete snap ${sn.route}`);
			del.textContent = "×";
			del.addEventListener("click", (ev) => {
				ev.stopPropagation();
				void doDeleteWebSnap(sn.sessionId, sn.sequence);
			});
			card.append(thumbHost, meta, del);
			flowGrid.appendChild(card);
		}
		section.appendChild(flowGrid);
		if (group.children.length > 0) {
			const subWrap = ce("div", "web-library-subs");
			for (const child of group.children) {
				renderGroup(child, subWrap, depth + 1);
			}
			section.appendChild(subWrap);
		}
		parentContainer.appendChild(section);
	};

	for (const g of groups) renderGroup(g, grid, 0);
}

function openWebSnapLightbox(sn: RnSnapInfo): void {
	// Strip any existing lightbox so re-clicking doesn't stack overlays.
	for (const old of document.querySelectorAll(".web-snap-lightbox")) {
		old.remove();
	}
	const backdrop = ce("div", "web-snap-lightbox");
	const close = () => backdrop.remove();
	backdrop.addEventListener("click", (ev) => {
		if (ev.target === backdrop) close();
	});
	const onKey = (ev: KeyboardEvent) => {
		if (ev.key === "Escape") {
			close();
			document.removeEventListener("keydown", onKey);
		}
	};
	document.addEventListener("keydown", onKey);

	const stage = ce("div", "web-snap-lightbox-stage");
	const header = ce("div", "web-snap-lightbox-header");
	const title = ce("div", "web-snap-lightbox-title");
	title.textContent = sn.displayName ?? sn.route;
	const sub = ce("div", "web-snap-lightbox-sub");
	sub.textContent = `#${sn.sequence} · ${new Date(sn.capturedAt).toLocaleString()}${sn.fullPage ? " · full page" : ""}`;
	header.append(title, sub);
	const closeBtn = ce("button", "web-snap-lightbox-close");
	closeBtn.type = "button";
	closeBtn.setAttribute("aria-label", "Close");
	closeBtn.textContent = "×";
	closeBtn.addEventListener("click", close);

	const scroll = ce("div", "web-snap-lightbox-scroll");
	const img = ce("img", "web-snap-lightbox-img");
	img.src = snapImageSrcFromInfo(sn);
	img.alt = sn.route;
	// Show a clear placeholder when the source file is missing or zero-sized
	// (deleted on disk, prune evicted it, smoke-test stub, etc). Otherwise
	// the lightbox renders a blank box and looks broken.
	const showMissing = (reason: string): void => {
		img.style.display = "none";
		const placeholder = ce("div", "web-snap-lightbox-missing");
		const t = ce("div", "web-snap-lightbox-missing-title");
		t.textContent = "Image missing";
		const h = ce("div", "web-snap-lightbox-missing-hint");
		h.textContent = reason;
		placeholder.append(t, h);
		scroll.appendChild(placeholder);
	};
	img.addEventListener("error", () =>
		showMissing("The PNG file is gone from disk — re-snap to refresh."),
	);
	img.addEventListener("load", () => {
		if (img.naturalWidth < 8 || img.naturalHeight < 8) {
			showMissing("This entry is a placeholder (no real screenshot bytes).");
		}
	});
	scroll.appendChild(img);

	stage.append(closeBtn, header, scroll);
	backdrop.appendChild(stage);
	document.body.appendChild(backdrop);
}

async function doMoveWebSnapToFlow(
	sessionId: string,
	sequence: number,
	toFlowId: string,
): Promise<void> {
	const r = await req.moveSnapsToFlow({
		snapIds: [{ sessionId, sequence }],
		toFlowId,
	});
	if (!r.ok) {
		log(`Move failed: ${r.error}`, "error");
		return;
	}
	// Optimistic local update + re-pull from server to make sure flow
	// counts settle on the right answer.
	state.set((cur) => ({
		...cur,
		rn: {
			...cur.rn,
			snaps: cur.rn.snaps.map((s) =>
				s.sessionId === sessionId && s.sequence === sequence
					? ({ ...s, flowId: toFlowId } as typeof s)
					: s,
			),
		},
	}));
	log(`→ Moved snap #${sequence} to "${toFlowId}"`, "info");
}

function snapImageSrcFromInfo(sn: { imagePath?: string; remoteImageUrl?: string }): string {
	if (sn.imagePath) return toFileUrl(sn.imagePath);
	if (sn.remoteImageUrl) return sn.remoteImageUrl;
	return "";
}

async function doDeleteWebSnap(sessionId: string, sequence: number): Promise<void> {
	const r = await req.deleteSnap({ sessionId, sequence });
	if (!r.ok) {
		log(`Delete failed: ${r.error}`, "error");
		return;
	}
	state.set((cur) => ({
		...cur,
		rn: {
			...cur.rn,
			snaps: cur.rn.snaps.filter(
				(s) => !(s.sessionId === sessionId && s.sequence === sequence),
			),
		},
	}));
	log(`🗑 Deleted snap #${sequence}`, "info");
}

/**
 * Resize the iframe to a known device viewport. The CSS default is
 * desktop 1440×900; tablet + mobile override via inline style so
 * applyWebState doesn't fight the picker. Kept in JS rather than via
 * CSS class so we don't have a 3-class permutation explosion to
 * maintain — three constants, one width/height each.
 */
function applyDevicePreset(
	iframe: HTMLIFrameElement,
	preset: "desktop" | "tablet" | "mobile",
): void {
	const dims = {
		desktop: { w: 1440, h: 900 },
		tablet: { w: 768, h: 1024 },
		mobile: { w: 375, h: 667 },
	}[preset];
	iframe.style.width = `${dims.w}px`;
	iframe.style.height = `${dims.h}px`;
}

function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
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

// ── GLOBAL TOPBAR ──
// Lives in index.html so it survives mode switches without any renderer
// tearing it down. Brand+tabs are static; the actions slot is populated
// here once and shown/hidden per-mode via classes on `body[data-mode]`.
// Top-level routing: rn.selectedProjectSlug doubles as "active project".
// null = dashboard, set = inside a project (mobile or web view based on type).
type ProjectType = "mobile" | "web";
const projectTypeOf = (slug: string): ProjectType => {
	const r = state.get().rn.registry.find((p) => p.slug === slug);
	if (!r) return "mobile";
	// Persisted projects use the canonical `platform` field. The legacy
	// ad-hoc `type` is kept as a fallback for in-memory web stubs that
	// were created before the wizard was wired up.
	if (r.platform === "web") return "web";
	const legacy = (r as unknown as { type?: string }).type;
	return legacy === "web" ? "web" : "mobile";
};
const enterProject = (slug: string): void => {
	const type = projectTypeOf(slug);
	state.set((cur) => ({
		...cur,
		source: { ...cur.source, kind: type === "web" ? "url" : "iossim" },
		rn: { ...cur.rn, selectedProjectSlug: slug },
	}));
	if (type === "mobile") {
		// "What changed" banner only — pre-flight auto-refresh is OFF by
		// design. snap-flows-scan is destructive (regenerates from app/
		// folder, overwrites any improver-refined or hand-edited
		// snap-flows.ts). Auto-running it on every enterProject would
		// silently nuke the user's Claude-refined flow grouping. The
		// Refresh button on dashboard cards is manual + opt-in, intended
		// for "I added routes, regenerate baseline" — not a navigation
		// side-effect.
		window.setTimeout(() => maybeShowChangesBanner(slug), 200);
	}
};
const leaveProject = (): void => {
	dismissChangesBanner();
	state.set((cur) => ({
		...cur,
		rn: { ...cur.rn, selectedProjectSlug: null },
	}));
};

// ── "What changed since last entry" banner ────────────────────────────────
//
// On enterProject, compares the current flow tree against the snapshot we
// saved on the last entry. Surfaces added / removed / renamed flows so the
// designer immediately sees what's new without having to scan the sidebar.
// First-time entry: no banner, just record the snapshot.

interface FlowSig {
	id: string; // declaredId (or internal id when no decl)
	name: string;
	parentId?: string;
}

let activeChangesBanner: HTMLDivElement | null = null;
let changesBannerTimer: ReturnType<typeof setTimeout> | null = null;

function flowsSignature(slug: string): FlowSig[] {
	const r = state.get().rn;
	return r.flows
		.filter((f) => f.projectId === slug)
		.map<FlowSig>((f) => ({
			id: f.declaredId ?? f.id,
			name: f.name,
			parentId: f.parentFlowId,
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}

interface ChangeReport {
	added: FlowSig[];
	removed: FlowSig[];
	renamed: Array<{ id: string; from: string; to: string }>;
}

function diffSignatures(prev: FlowSig[], next: FlowSig[]): ChangeReport {
	const prevById = new Map(prev.map((f) => [f.id, f]));
	const nextById = new Map(next.map((f) => [f.id, f]));
	const added: FlowSig[] = [];
	const removed: FlowSig[] = [];
	const renamed: Array<{ id: string; from: string; to: string }> = [];
	for (const f of next) {
		const before = prevById.get(f.id);
		if (!before) added.push(f);
		else if (before.name !== f.name)
			renamed.push({ id: f.id, from: before.name, to: f.name });
	}
	for (const f of prev) {
		if (!nextById.has(f.id)) removed.push(f);
	}
	return { added, removed, renamed };
}

function maybeShowChangesBanner(slug: string): void {
	const key = `prisma:lastFlowSig:${slug}`;
	const current = flowsSignature(slug);
	const stored = readLocal(key);
	let prev: FlowSig[] | null = null;
	if (stored) {
		try {
			const parsed = JSON.parse(stored);
			if (Array.isArray(parsed)) prev = parsed as FlowSig[];
		} catch {
			prev = null;
		}
	}
	// Always update the snapshot — even if banner doesn't render, we want
	// the next entry to compare against the latest state.
	writeLocal(key, JSON.stringify(current));
	if (!prev || prev.length === 0) return; // first entry: nothing to compare
	const diff = diffSignatures(prev, current);
	const hasChanges =
		diff.added.length > 0 || diff.removed.length > 0 || diff.renamed.length > 0;
	if (!hasChanges) return;
	renderChangesBanner(diff);
}

function renderChangesBanner(diff: ChangeReport): void {
	dismissChangesBanner();
	const banner = ce("div", "rn-changes-banner");
	banner.setAttribute("role", "status");
	banner.setAttribute("aria-live", "polite");

	const icon = ce("span", "rn-changes-icon");
	icon.textContent = "✨";

	const body = ce("div", "rn-changes-body");
	const heading = ce("div", "rn-changes-heading");
	const parts: string[] = [];
	if (diff.added.length > 0) parts.push(`${diff.added.length} new`);
	if (diff.removed.length > 0) parts.push(`${diff.removed.length} removed`);
	if (diff.renamed.length > 0) parts.push(`${diff.renamed.length} renamed`);
	heading.textContent = `Changes since last visit — ${parts.join(" · ")}`;

	const detail = ce("div", "rn-changes-detail");
	const lines: string[] = [];
	if (diff.added.length > 0) {
		const names = diff.added.slice(0, 3).map((f) => f.name).join(", ");
		const more = diff.added.length > 3 ? `, +${diff.added.length - 3} more` : "";
		lines.push(`<b>New:</b> ${escapeHtmlSimple(names)}${more}`);
	}
	if (diff.removed.length > 0) {
		const names = diff.removed.slice(0, 3).map((f) => f.name).join(", ");
		const more =
			diff.removed.length > 3 ? `, +${diff.removed.length - 3} more` : "";
		lines.push(`<b>Removed:</b> ${escapeHtmlSimple(names)}${more}`);
	}
	if (diff.renamed.length > 0) {
		const names = diff.renamed
			.slice(0, 3)
			.map((r) => `${r.from} → ${r.to}`)
			.join(", ");
		const more =
			diff.renamed.length > 3 ? `, +${diff.renamed.length - 3} more` : "";
		lines.push(`<b>Renamed:</b> ${escapeHtmlSimple(names)}${more}`);
	}
	detail.innerHTML = lines.join("<br>");

	body.append(heading, detail);

	const close = ce("button", "rn-changes-close");
	close.type = "button";
	close.setAttribute("aria-label", "Dismiss");
	close.textContent = "×";
	close.addEventListener("click", dismissChangesBanner);

	banner.append(icon, body, close);
	document.body.appendChild(banner);
	activeChangesBanner = banner;

	// Auto-dismiss after 12s — long enough to read, short enough to not
	// linger across project work.
	changesBannerTimer = setTimeout(dismissChangesBanner, 12000);
}

function dismissChangesBanner(): void {
	if (changesBannerTimer) {
		clearTimeout(changesBannerTimer);
		changesBannerTimer = null;
	}
	if (!activeChangesBanner) return;
	activeChangesBanner.classList.add("is-leaving");
	const node = activeChangesBanner;
	activeChangesBanner = null;
	setTimeout(() => node.remove(), 240);
}

// ─── Auto-update "Restart to update" banner ───
// Pushed from bun once an update has downloaded. PERSISTENT — unlike the
// changes banner it has no auto-dismiss timer; prompt-to-restart must wait
// for the user. De-dupes so a re-check can't stack banners.
let updateBanner: HTMLDivElement | null = null;

function showUpdateBanner(m: import("../lib/rpc").UpdateReadyMessage): void {
	if (updateBanner) return;
	const banner = ce("div", "rn-update-banner");
	banner.setAttribute("role", "status");
	banner.setAttribute("aria-live", "polite");

	const icon = ce("span", "rn-changes-icon");
	icon.textContent = "⬆️";

	const body = ce("div", "rn-changes-body");
	const heading = ce("div", "rn-changes-heading");
	heading.textContent = "Update ready";
	const detail = ce("div", "rn-changes-detail");
	const label = m.version || (m.hash ? m.hash.slice(0, 8) : "new build");
	detail.textContent = `Version ${label} downloaded. Restart to apply.`;
	body.append(heading, detail);

	const restart = ce("button", "btn btn-sm rn-update-restart");
	restart.type = "button";
	restart.textContent = "Restart to update";
	restart.addEventListener("click", async () => {
		restart.disabled = true;
		restart.textContent = "Restarting…";
		// applyUpdate relaunches + quits — on success the app is gone and the
		// response never arrives, so only the error/no-op branch matters.
		try {
			const r = await req.applyUpdate({});
			if (r && !r.ok) {
				showToast(`Update failed: ${r.error ?? "unknown error"}`, "error");
				restart.disabled = false;
				restart.textContent = "Restart to update";
			}
		} catch (err) {
			showToast(`Update failed: ${(err as Error).message}`, "error");
			restart.disabled = false;
			restart.textContent = "Restart to update";
		}
	});

	const close = ce("button", "rn-changes-close");
	close.type = "button";
	close.setAttribute("aria-label", "Dismiss");
	close.textContent = "×";
	close.addEventListener("click", () => {
		updateBanner?.remove();
		updateBanner = null;
	});

	banner.append(icon, body, restart, close);
	document.body.appendChild(banner);
	updateBanner = banner;
}

// Wire the bun push to the banner once, at module load.
subscribeUpdateReady(showUpdateBanner);
// The push is fire-once and unbuffered, so if the update finished downloading
// before this handler was live it'd be lost — pull any pending update now that
// we're listening. showUpdateBanner de-dupes, so a racing push is harmless.
req
	.getPendingUpdate({})
	.then((r: { update: import("../lib/rpc").UpdateReadyMessage | null }) => {
		if (r?.update) showUpdateBanner(r.update);
	})
	.catch(() => {});

function escapeHtmlSimple(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// Search query is dashboard-local (not in app state since it has no other use).
let dashSearchQuery = "";

// Build the actions slot once. Children are toggled visible per-mode via
// `body[data-mode="dashboard|mobile|web"]`. HMR-safe (replaceChildren below).
const gtbActions = document.getElementById("gtb-actions")!;
gtbActions.replaceChildren();

// Replace the search icon placeholder (✕ in HTML) with a Lucide SVG.
const gtbSearchIcon = document.querySelector<HTMLElement>(".gtb-search-icon");
if (gtbSearchIcon) gtbSearchIcon.replaceChildren(icon("search", { size: 14 }));

// Helper: button with leading icon + text. Used by every action button so
// the topbar reads as a row of consistently-spaced icon+label pills.
function setBtnIcon(
	btn: HTMLButtonElement,
	name: IconName,
	label: string,
): void {
	btn.replaceChildren(icon(name, { size: 14 }), document.createTextNode(label));
}

// Brand button → return to dashboard.
const gtbBrand = document.getElementById("gtb-brand") as HTMLButtonElement;
gtbBrand.addEventListener("click", () => leaveProject());

// Search input — filters dashboard cards live.
const gtbSearchInput = document.getElementById("gtb-search-input") as HTMLInputElement;
gtbSearchInput.addEventListener("input", () => {
	dashSearchQuery = gtbSearchInput.value;
	if (dashRefs) renderDashboardCards(dashRefs);
});

// Project-mode context block: shows the active project's name + bridge status.
// Replaces the old right-side context panel — same data, less chrome.
const gtbContextName = document.getElementById("gtb-context-name") as HTMLDivElement;
const gtbContextPill = document.getElementById("gtb-context-pill") as HTMLButtonElement;
const gtbContextDot = document.getElementById("gtb-context-dot") as HTMLSpanElement;
const gtbContextPillLabel = document.getElementById("gtb-context-pill-label") as HTMLSpanElement;

// Dashboard action: Add project (opens type chooser).
const gtbAddBtn = document.createElement("button");
gtbAddBtn.className = "btn btn-primary btn-sm mode-dashboard";
gtbAddBtn.title = "Onboard a new project";
setBtnIcon(gtbAddBtn, "plus", "Add");
gtbAddBtn.addEventListener("click", () => openAddTypeChooser());

// Always-on: theme. Icon swaps based on current theme.
const gtbThemeBtn = document.createElement("button");
gtbThemeBtn.className = "btn btn-ghost btn-icon btn-sm";
gtbThemeBtn.title = "Toggle theme";
gtbThemeBtn.setAttribute("aria-label", "Toggle theme");
gtbThemeBtn.appendChild(icon(theme.get() === "dark" ? "sun-medium" : "moon", { size: 14 }));
gtbThemeBtn.addEventListener("click", () => {
	const next = theme.toggle();
	gtbThemeBtn.replaceChildren(icon(next === "dark" ? "sun-medium" : "moon", { size: 14 }));
	log(`Theme: ${next}`, "info");
});

// Project-view back button — sits in the topbar's left column (col 1) so it
// mirrors macOS conventions: navigate-back at top-left, primary actions at
// top-right, identity in the middle. Lives outside .gtb-actions so the grid
// can place it directly.
const gtbBackBtn = document.createElement("button");
gtbBackBtn.className = "btn btn-ghost btn-sm gtb-back mode-project";
gtbBackBtn.title = "Back to dashboard";
gtbBackBtn.setAttribute("aria-label", "Back to dashboard");
setBtnIcon(gtbBackBtn, "arrow-left", "Dashboard");
gtbBackBtn.addEventListener("click", () => leaveProject());

// Hairline divider between the secondary cluster (theme) and the primary
// cluster (push / snap) on the right side. Project mode only — the dashboard's
// single primary action (Add) doesn't need separation.
const gtbActionsSep = document.createElement("span");
gtbActionsSep.className = "gtb-actions-sep mode-project";
gtbActionsSep.setAttribute("aria-hidden", "true");

const gtbPushBtn = document.createElement("button");
gtbPushBtn.className = "btn btn-secondary mode-project";
gtbPushBtn.title = "Upload pending snaps to the gallery platform";
setBtnIcon(gtbPushBtn, "upload", "Push to web");
gtbPushBtn.addEventListener("click", () => void doPushPending());

const gtbSyncBtn = document.createElement("button");
gtbSyncBtn.className = "btn btn-ghost mode-project";
gtbSyncBtn.title = "Pull frames + flows from the gallery (use after disk loss / on a fresh machine)";
setBtnIcon(gtbSyncBtn, "refresh-cw", "Sync");
gtbSyncBtn.addEventListener("click", () => void doSyncFromGallery());

// Split snap button: main button = default snap (auto = replace existing
// slot), caret = dropdown with "Snap as variant" (force a new card on the
// same slot, used for long pages or filter-state captures).
const gtbTourBtn = document.createElement("button");
gtbTourBtn.className = "btn btn-ghost mode-project";
gtbTourBtn.title =
	"Run a tour over every declared screen — Capture navigates and snaps each one automatically.";
setBtnIcon(gtbTourBtn, "play", "Run tour");
gtbTourBtn.addEventListener("click", () => void doRunTour());

const gtbAutoSnapBtn = document.createElement("button");
gtbAutoSnapBtn.className = "btn btn-ghost mode-project";
gtbAutoSnapBtn.title =
	"Auto-snap: when ON, Capture snaps every time you navigate to a new route in the simulator (1s settle delay).";
setBtnIcon(gtbAutoSnapBtn, "zap", "Auto-snap: Off");
const AUTO_SNAP_KEY = "capture:auto-snap-on";
function isAutoSnapOn(): boolean {
	return readLocal(AUTO_SNAP_KEY) === "1";
}
function setAutoSnapOn(on: boolean): void {
	writeLocal(AUTO_SNAP_KEY, on ? "1" : "0");
	setBtnIcon(
		gtbAutoSnapBtn,
		on ? "zap" : "zap-off",
		on ? "Auto-snap: On" : "Auto-snap: Off",
	);
	gtbAutoSnapBtn.classList.toggle("is-active", on);
	log(
		on
			? "Auto-snap ON — every new route gets captured automatically."
			: "Auto-snap OFF — back to manual snaps.",
		"info",
	);
}
// Restore persisted state on boot (without firing the log toast).
{
	const on = isAutoSnapOn();
	setBtnIcon(
		gtbAutoSnapBtn,
		on ? "zap" : "zap-off",
		on ? "Auto-snap: On" : "Auto-snap: Off",
	);
	gtbAutoSnapBtn.classList.toggle("is-active", on);
}
gtbAutoSnapBtn.addEventListener("click", () => setAutoSnapOn(!isAutoSnapOn()));

const gtbSnapGroup = document.createElement("div");
gtbSnapGroup.className = "gtb-snap-group mode-project";
const gtbSnapBtn = document.createElement("button");
gtbSnapBtn.className = "btn btn-primary gtb-snap-main";
gtbSnapBtn.title = "Capture (⌘⇧S)";
setBtnIcon(gtbSnapBtn, "camera", "Snap");
gtbSnapBtn.addEventListener("click", () => void doSnap("auto"));
const gtbSnapCaret = document.createElement("button");
gtbSnapCaret.className = "btn btn-primary gtb-snap-caret";
gtbSnapCaret.title = "Snap options";
gtbSnapCaret.setAttribute("aria-label", "Snap options");
gtbSnapCaret.appendChild(icon("chevron-down", { size: 12 }));
gtbSnapCaret.addEventListener("click", (ev) => {
	ev.stopPropagation();
	openSnapMenu(gtbSnapCaret, undefined);
});
gtbSnapGroup.append(gtbSnapBtn, gtbSnapCaret);

// Device picker — pick & boot a simulator (iPhone or iPad) to capture.
// Bridge-less: targets a booted simulator via simctl, so it works for ANY
// app (Flutter, native iOS, iPad) and for RN apps without snap-bridge.
const gtbDeviceBtn = document.createElement("button");
gtbDeviceBtn.className = "btn btn-ghost mode-project";
gtbDeviceBtn.title =
	"Pick & boot a simulator (iPhone or iPad) to capture. Works without snap-bridge — for any app, including Flutter and native.";
setBtnIcon(gtbDeviceBtn, "smartphone", "Device");
gtbDeviceBtn.addEventListener("click", (ev) => {
	ev.stopPropagation();
	void openDeviceMenu(gtbDeviceBtn);
});

// Back button lives in column 1 of the topbar (next to the brand slot).
// Inserted right after the brand so DOM order matches reading order.
gtbBrand.insertAdjacentElement("afterend", gtbBackBtn);

gtbActions.append(
	gtbThemeBtn,
	gtbActionsSep,
	gtbAddBtn,
	gtbSyncBtn,
	gtbPushBtn,
	gtbAutoSnapBtn,
	gtbTourBtn,
	gtbDeviceBtn,
	gtbSnapGroup,
);

let snapMenuOpen: HTMLDivElement | null = null;
function closeSnapMenu(): void {
	if (!snapMenuOpen) return;
	snapMenuOpen.remove();
	snapMenuOpen = null;
	document.removeEventListener("click", onDocClickCloseSnap, true);
}
function onDocClickCloseSnap(ev: MouseEvent): void {
	if (!snapMenuOpen) return;
	if (snapMenuOpen.contains(ev.target as Node)) return;
	closeSnapMenu();
}
function openSnapMenu(
	anchor: HTMLElement,
	target?: { forceFlowId?: string },
): void {
	if (snapMenuOpen) {
		closeSnapMenu();
		return;
	}
	const rect = anchor.getBoundingClientRect();
	const menu = ce("div", "gtb-snap-menu");
	menu.style.top = `${rect.bottom + 6}px`;
	menu.style.right = `${window.innerWidth - rect.right}px`;

	const mkItem = (
		title: string,
		hint: string,
		shortcut: string,
		onClick: () => void,
	): HTMLButtonElement => {
		const item = ce("button", "gtb-snap-menu-item");
		item.type = "button";
		const head = ce("div", "gtb-snap-menu-head");
		const t = ce("span", "gtb-snap-menu-title");
		t.textContent = title;
		const k = ce("span", "gtb-snap-menu-kbd");
		k.textContent = shortcut;
		head.append(t, k);
		const h = ce("p", "gtb-snap-menu-hint");
		h.textContent = hint;
		item.append(head, h);
		item.addEventListener("click", () => {
			closeSnapMenu();
			onClick();
		});
		return item;
	};

	menu.appendChild(
		mkItem(
			"Snap (replace)",
			"Updates the current screen's card. The old image becomes a version in history. This is the right choice 95% of the time.",
			"⌘⇧S",
			() => void doSnap("auto", target),
		),
	);
	menu.appendChild(
		mkItem(
			"Snap as new card",
			"Adds a second card for this same screen. Use when you want both side-by-side — different scroll positions, popup states, A/B variants.",
			"⌘⇧V",
			() => void doSnap("variant", target),
		),
	);

	document.body.appendChild(menu);
	snapMenuOpen = menu;
	document.addEventListener("click", onDocClickCloseSnap, true);
}

// ── Device picker ─────────────────────────────────────────────────────────
// The udid the bridge-less device snap targets. null = "the booted device"
// (simctl's default). Set when the user picks a device from the menu.
let selectedDeviceUdid: string | null = null;

let deviceMenuOpen: HTMLDivElement | null = null;
function closeDeviceMenu(): void {
	if (!deviceMenuOpen) return;
	deviceMenuOpen.remove();
	deviceMenuOpen = null;
	document.removeEventListener("click", onDocClickCloseDevice, true);
}
function onDocClickCloseDevice(ev: MouseEvent): void {
	if (!deviceMenuOpen) return;
	if (deviceMenuOpen.contains(ev.target as Node)) return;
	closeDeviceMenu();
}
async function openDeviceMenu(anchor: HTMLElement): Promise<void> {
	if (deviceMenuOpen) {
		closeDeviceMenu();
		return;
	}
	const rect = anchor.getBoundingClientRect();
	const menu = ce("div", "gtb-snap-menu");
	menu.style.top = `${rect.bottom + 6}px`;
	menu.style.right = `${window.innerWidth - rect.right}px`;
	const loading = ce("p", "gtb-snap-menu-hint");
	loading.textContent = "Loading simulators…";
	loading.style.padding = "10px 12px";
	menu.appendChild(loading);
	document.body.appendChild(menu);
	deviceMenuOpen = menu;
	document.addEventListener("click", onDocClickCloseDevice, true);

	const res = await req.listDevices({});
	if (deviceMenuOpen !== menu) return; // closed while the list loaded
	menu.replaceChildren();
	if (!res.ok) {
		const err = ce("p", "gtb-snap-menu-hint");
		err.textContent = res.error;
		err.style.padding = "10px 12px";
		menu.appendChild(err);
		return;
	}
	if (res.devices.length === 0) {
		const empty = ce("p", "gtb-snap-menu-hint");
		empty.textContent =
			"No simulators found. Add one in Xcode → Settings → Platforms.";
		empty.style.padding = "10px 12px";
		menu.appendChild(empty);
		return;
	}
	const groups: Array<[("ipad" | "iphone" | "other"), string]> = [
		["ipad", "iPad"],
		["iphone", "iPhone"],
		["other", "Other"],
	];
	for (const [kind, label] of groups) {
		const inGroup = res.devices.filter((d) => d.kind === kind);
		if (inGroup.length === 0) continue;
		const header = ce("div");
		header.textContent = label;
		header.style.cssText =
			"padding:8px 12px 2px;font-size:11px;font-weight:600;opacity:0.5;text-transform:uppercase;letter-spacing:0.04em;";
		menu.appendChild(header);
		for (const d of inGroup) {
			const item = ce("button", "gtb-snap-menu-item");
			item.type = "button";
			const head = ce("div", "gtb-snap-menu-head");
			const t = ce("span", "gtb-snap-menu-title");
			t.textContent = d.name;
			const k = ce("span", "gtb-snap-menu-kbd");
			k.textContent = d.state === "Booted" ? "● booted" : d.runtime;
			head.append(t, k);
			const h = ce("p", "gtb-snap-menu-hint");
			h.textContent =
				selectedDeviceUdid === d.udid
					? "Selected for capture"
					: d.state === "Booted"
						? "Booted — click to target for Snap"
						: "Click to boot + target for Snap";
			item.append(head, h);
			item.addEventListener("click", () => {
				closeDeviceMenu();
				void bootAndSelectDevice(d.udid, d.name);
			});
			menu.appendChild(item);
		}
	}
}

async function bootAndSelectDevice(udid: string, name: string): Promise<void> {
	selectedDeviceUdid = udid;
	log(`Booting ${name}…`, "info");
	const r = await req.bootDevice({ udid });
	if (!r.ok) {
		log(`Couldn't boot ${name}: ${r.error}`, "error");
		return;
	}
	log(
		r.alreadyBooted
			? `${name} is ready — Snap will capture it.`
			: `Booted ${name} — Snap will capture it.`,
		"success",
	);
}

function syncGlobalTopbar(): void {
	const slug = state.get().rn.selectedProjectSlug;
	if (slug == null) {
		document.body.dataset.mode = "dashboard";
	} else {
		const type = projectTypeOf(slug);
		document.body.dataset.mode = type === "web" ? "web" : "mobile";
	}
}

state.subscribe(syncGlobalTopbar);
state.subscribe((s) => {
	const r = s.rn;
	const slug = r.selectedProjectSlug;
	const projectSnaps = slug
		? r.snaps.filter((n) => n.projectId === slug)
		: r.snaps;
	// Snap works with a connected bridge OR bridge-less via simctl, so it's
	// available for any open mobile project — doSnap picks the path.
	const snapAvailable = slug != null && projectTypeOf(slug) !== "web";
	gtbSnapBtn.disabled = r.busy || !snapAvailable;
	gtbSnapCaret.disabled = r.busy || !snapAvailable;
	gtbSnapBtn.classList.toggle("is-busy", r.busy);
	setBtnIcon(gtbSnapBtn, r.busy ? "loader" : "camera", r.busy ? "Capturing…" : "Snap");
	// Tour button: only meaningful when bridge is connected for the
	// active project AND we have at least one declared screen to visit.
	{
		const slugForTour = state.get().rn.selectedProjectSlug;
		const declaredCount =
			slugForTour
				? r.flows
						.filter((f) => f.projectId === slugForTour)
						.reduce(
							(sum, f) =>
								sum + (f.screens?.filter((s) => !s.hidden).length ?? 0),
							0,
						)
				: 0;
		const tourReady =
			!!slugForTour &&
			r.projects.includes(slugForTour) &&
			!r.busy &&
			!r.pushing &&
			declaredCount > 0;
		gtbTourBtn.disabled = !tourReady;
	}
	const projectName =
		(slug && r.registry.find((p) => p.slug === slug)?.name) || slug;

	// Topbar project context (only meaningful when inside a project).
	if (slug) {
		const projectIsConnected = r.projects.includes(slug);
		gtbContextName.textContent = projectName ?? slug;
		gtbContextDot.className = projectIsConnected ? "dot success" : "dot warn";
		// When the bridge is connected and we know the live route, show
		// it inline so designers see what would be captured before they
		// click Snap. Falls back to "Connected" while the first poll is
		// in flight (currentRoute null) or when polling failed.
		const liveRoute = projectIsConnected ? r.currentRoute : null;
		gtbContextPillLabel.textContent = projectIsConnected
			? liveRoute
				? `Connected · ${liveRoute}`
				: "Connected"
			: "Bridge offline";
		gtbContextPill.title = projectIsConnected
			? liveRoute
				? `Bridge sees: ${liveRoute}\nClick Snap to capture this screen.`
				: `Connected to your app — ready to capture (port 9876)`
			: `Your app isn't connected yet. Check that the iOS Simulator is running, your Expo dev server is up, and the app is loaded.\n\nDeveloper details: snap-bridge listens on port 9876 for projectId "${slug}".`;
		gtbContextPill.classList.toggle("is-connected", projectIsConnected);
	} else {
		gtbContextName.textContent = "";
		gtbContextPillLabel.textContent = "";
		gtbContextPill.title = "";
	}
	const hasAny = projectSnaps.length > 0;
	const pendingCount = projectSnaps.filter((n) => !n.uploaded).length;
	const allPushed = hasAny && pendingCount === 0;
	gtbPushBtn.disabled = r.pushing || r.busy || !hasAny;
	gtbPushBtn.classList.toggle("is-busy", r.pushing);
	gtbPushBtn.classList.toggle("is-repush", allPushed && !r.pushing);
	// Label is terse — project name lives in .gtb-context to the left,
	// so we don't repeat it here. The leading icon (upload / refresh-cw)
	// carries the verb; the label carries the count.
	const pushLabel = r.pushing
		? `Pushing ${projectSnaps.length}…`
		: !hasAny
			? "Push"
			: allPushed
				? `Re-push ${projectSnaps.length}`
				: `Push ${pendingCount}`;
	const pushTitle = !hasAny
		? "No snaps to push yet"
		: allPushed
			? `Re-upload all ${projectSnaps.length} snap${projectSnaps.length === 1 ? "" : "s"} to ${projectName ?? "the gallery"}`
			: `Upload ${pendingCount} pending snap${pendingCount === 1 ? "" : "s"} to ${projectName ?? "the gallery"}`;
	gtbPushBtn.title = pushTitle;
	setBtnIcon(gtbPushBtn, r.pushing ? "loader" : allPushed ? "refresh-cw" : "upload", pushLabel);
});
syncGlobalTopbar();

state.subscribe(() => render());

// Auth-gated boot: check for a persisted session. If signed in, load the
// assigned-project registry so the dashboard renders immediately; otherwise
// flip authChecked so render() shows the sign-in screen (not a blank dashboard).
void (async () => {
	try {
		const { session } = await req.getSession({});
		if (session) {
			state.set((cur) => ({ ...cur, session, authChecked: true }));
			await refreshProjectRegistry();
		} else {
			state.set((cur) => ({ ...cur, authChecked: true }));
		}
	} catch {
		state.set((cur) => ({ ...cur, authChecked: true }));
	}
})();

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
	flowsList: HTMLDivElement;
	previewBox: HTMLDivElement;
	recentBox: HTMLDivElement;
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

/**
 * Resolve the best image URL for a snap. Local file (served via the
 * snap-server proxy) is always preferred; falls back to the gallery's
 * Supabase Storage URL on snaps that were pulled-from-cloud and never
 * downloaded yet. Returns an empty string if neither is available — the
 * caller should hide the bezel image in that case.
 */
function snapImageSrc(s: { imagePath?: string; remoteImageUrl?: string }): string {
	if (s.imagePath && s.imagePath.length > 0) return toFileUrl(s.imagePath);
	if (s.remoteImageUrl && s.remoteImageUrl.length > 0) return s.remoteImageUrl;
	return "";
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

	// Brand + actions live in #global-topbar (index.html); rn-root is body only.

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
	sidebarCollapseBtn.appendChild(icon("panel-left-close", { size: 14 }));
	sidebarCollapseBtn.addEventListener("click", () => {
		layout.classList.add("rn-layout-collapsed");
		saveSidebarCollapsed(true);
	});

	const sidebarExpandBtn = ce("button", "rn-sidebar-expand");
	sidebarExpandBtn.type = "button";
	sidebarExpandBtn.title = "Show sidebar";
	sidebarExpandBtn.setAttribute("aria-label", "Show sidebar");
	sidebarExpandBtn.appendChild(icon("panel-left-open", { size: 14 }));
	sidebarExpandBtn.addEventListener("click", () => {
		layout.classList.remove("rn-layout-collapsed");
		saveSidebarCollapsed(false);
	});

	// Flows section — tree of flows in the active project, click to focus
	const flowsSection = ce("div", "section");
	const flowsTitle = ce("div", "section-title");
	flowsTitle.textContent = "Flows";
	const flowsList = ce("div", "rn-flows-side");
	flowsSection.append(flowsTitle, flowsList);

	// LEFT sidebar: just the flows tree. Primary navigation, mirrors web.
	// Right context panel was removed — its info (project name + bridge
	// status) now lives in the global topbar (`#gtb-context`). Project
	// switching happens on the dashboard, not in-project.
	sidebar.append(sidebarCollapseBtn, flowsSection);

	// MAIN — snap grid card. previewBox is kept as the main scroller; we
	// populate it with a grid of snap cards in applyRnState (no separate
	// "preview" + "recent" split anymore).
	const main = ce("main", "rn-main");
	main.appendChild(sidebarExpandBtn);
	const previewBox = ce("div", "rn-grid-scroll");
	main.appendChild(previewBox);
	const recentBox = previewBox; // alias — same container, just renamed in refs

	layout.append(sidebar, main);
	root.append(layout);

	const refs: RnRefs = {
		root,
		flowsList,
		previewBox,
		recentBox,
	};

	return refs;
}

function ensureRnMounted(): RnRefs {
	if (!rnRefs) {
		// Clean up any leftover from a previous module load (HMR/hot-reload).
		document.getElementById("rn-root")?.remove();
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

// ─── SIGN IN ───
// First gate: a centered email + password card. On success the bun process
// stores the Supabase session (session.json) and returns the user's assigned
// projects, which become the dashboard registry. Sign-out clears the session.
interface SigninRefs {
	root: HTMLDivElement;
	email: HTMLInputElement;
	password: HTMLInputElement;
	submit: HTMLButtonElement;
	error: HTMLDivElement;
}
let signinRefs: SigninRefs | null = null;

function buildSignin(): SigninRefs {
	const root = ce("div", "signin-root");
	root.id = "signin-root";
	root.style.display = "none";
	root.style.position = "fixed";
	root.style.inset = "0";
	root.style.zIndex = "1000";
	root.style.alignItems = "center";
	root.style.justifyContent = "center";
	root.style.padding = "24px";
	root.style.background = "var(--bg-0)";

	const card = ce("div", "signin-card");
	card.style.width = "360px";
	card.style.maxWidth = "90vw";
	card.style.display = "flex";
	card.style.flexDirection = "column";
	card.style.gap = "12px";
	card.style.padding = "28px";
	card.style.background = "var(--bg-1)";
	card.style.border = "1px solid var(--bg-3)";
	card.style.borderRadius = "14px";
	card.style.boxShadow = "0 12px 40px rgba(0,0,0,0.25)";

	const title = ce("h1", "dash-title");
	title.textContent = "Sign in to Unicorn Capture";
	const sub = ce("p", "dash-sub");
	sub.textContent = "Use your Unicorn Studio gallery account.";

	const email = ce("input", "input");
	email.type = "email";
	email.placeholder = "you@studio.com";
	email.autocomplete = "username";

	const password = ce("input", "input");
	password.type = "password";
	password.placeholder = "Password";
	password.autocomplete = "current-password";

	const submit = ce("button", "btn btn-primary");
	submit.type = "button";
	submit.textContent = "Sign in";

	const error = ce("div", "signin-error");
	error.style.color = "var(--danger, #e5484d)";
	error.style.fontSize = "13px";
	error.style.minHeight = "16px";

	const onSubmit = (): void => void doSignIn();
	submit.addEventListener("click", onSubmit);
	email.addEventListener("keydown", (e) => {
		if (e.key === "Enter") password.focus();
	});
	password.addEventListener("keydown", (e) => {
		if (e.key === "Enter") onSubmit();
	});

	card.append(title, sub, email, password, submit, error);
	root.appendChild(card);
	return { root, email, password, submit, error };
}

function ensureSigninMounted(): SigninRefs {
	if (!signinRefs) {
		document.getElementById("signin-root")?.remove();
		signinRefs = buildSignin();
		document.body.appendChild(signinRefs.root);
	}
	return signinRefs;
}

function setSigninVisible(visible: boolean): void {
	if (!signinRefs) return;
	signinRefs.root.style.display = visible ? "flex" : "none";
}

async function doSignIn(): Promise<void> {
	if (!signinRefs) return;
	const email = signinRefs.email.value.trim();
	const password = signinRefs.password.value;
	if (!email || !password) {
		signinRefs.error.textContent = "Enter your email and password.";
		return;
	}
	signinRefs.error.textContent = "";
	signinRefs.submit.disabled = true;
	signinRefs.submit.textContent = "Signing in…";
	try {
		const res = await req.signIn({ email, password });
		if (!res.ok) {
			signinRefs.error.textContent = res.error;
			return;
		}
		signinRefs.password.value = "";
		state.set((cur) => ({
			...cur,
			session: res.session,
			authChecked: true,
			rn: { ...cur.rn, registry: res.projects, selectedProjectSlug: null },
		}));
	} catch (err) {
		signinRefs.error.textContent =
			(err as Error)?.message || "Sign-in failed. Please try again.";
	} finally {
		if (signinRefs) {
			signinRefs.submit.disabled = false;
			signinRefs.submit.textContent = "Sign in";
		}
	}
}

async function doSignOut(): Promise<void> {
	try {
		await req.signOut({});
	} catch {
		// Clear locally regardless of network outcome.
	}
	state.set((cur) => ({
		...cur,
		session: null,
		rn: { ...cur.rn, registry: [], selectedProjectSlug: null },
	}));
}

// ─── DASHBOARD (project picker) ───
// First screen: grid of project cards from registry, search filter, Add modal.
// Click a card → enters that project (mobile or web view based on type).
interface DashRefs {
	root: HTMLDivElement;
	cardsGrid: HTMLDivElement;
	emptyState: HTMLDivElement;
	accountLabel: HTMLSpanElement;
}
let dashRefs: DashRefs | null = null;

function buildDashboard(): DashRefs {
	const root = ce("div", "dash-root");
	root.id = "dash-root";
	root.style.display = "none";

	const inner = ce("div", "dash-inner");

	const heading = ce("div", "dash-heading");
	const headingTitle = ce("h1", "dash-title");
	headingTitle.textContent = "Projects";
	const headingSub = ce("p", "dash-sub");
	headingSub.textContent =
		"Pick a project to capture from, or click + Add to onboard a new one.";
	heading.append(headingTitle, headingSub);

	// "Cleanup unsynced" — diffs the gallery against the local registry
	// and archives anything on the gallery that this desktop doesn't
	// know about. Helpful after onboarding when test projects pile up.
	// Hidden behind a tiny ghost button so the dashboard's main affordance
	// stays "+ Add", not "delete stuff".
	const cleanupRow = ce("div", "dash-cleanup-row");
	const cleanupBtn = ce("button", "btn btn-ghost btn-sm");
	cleanupBtn.type = "button";
	cleanupBtn.title =
		"Diff gallery vs. desktop and archive any projects only on the gallery";
	cleanupBtn.textContent = "Cleanup unsynced";
	cleanupBtn.addEventListener("click", () => void doCleanupUnsynced(cleanupBtn));
	const clearCacheBtn = ce("button", "btn btn-ghost btn-sm");
	clearCacheBtn.type = "button";
	clearCacheBtn.title =
		"Delete local PNGs for snaps already pushed to the gallery. Cards keep their thumbnails via the cloud URL. Frees disk space without losing data.";
	clearCacheBtn.textContent = "Clear cached snaps";
	clearCacheBtn.addEventListener("click", () =>
		void doClearPushedSnaps(clearCacheBtn),
	);
	cleanupRow.append(cleanupBtn, clearCacheBtn);
	heading.appendChild(cleanupRow);

	// Signed-in account + sign out.
	const accountRow = ce("div", "dash-account-row");
	accountRow.style.display = "flex";
	accountRow.style.alignItems = "center";
	accountRow.style.gap = "10px";
	accountRow.style.marginTop = "8px";
	const accountLabel = ce("span", "dash-account");
	accountLabel.style.fontSize = "12px";
	accountLabel.style.opacity = "0.7";
	const signOutBtn = ce("button", "btn btn-ghost btn-sm");
	signOutBtn.type = "button";
	signOutBtn.textContent = "Sign out";
	signOutBtn.addEventListener("click", () => void doSignOut());
	accountRow.append(accountLabel, signOutBtn);
	heading.appendChild(accountRow);

	const cardsGrid = ce("div", "dash-grid");
	const emptyState = ce("div", "dash-empty");
	const emptyIcon = ce("div", "dash-empty-icon");
	emptyIcon.appendChild(icon("folder", { size: 36, strokeWidth: 1.5 }));
	const emptyTitle = ce("div", "dash-empty-title");
	emptyTitle.textContent = "No projects yet";
	const emptyBody = ce("div", "dash-empty-body");
	emptyBody.innerHTML =
		"Click <b>+ Add</b> to onboard your first project — Mobile (iOS Sim) or Web.";
	emptyState.append(emptyIcon, emptyTitle, emptyBody);

	inner.append(heading, cardsGrid, emptyState);
	root.appendChild(inner);

	return { root, cardsGrid, emptyState, accountLabel };
}

function ensureDashMounted(): DashRefs {
	if (!dashRefs) {
		document.getElementById("dash-root")?.remove();
		dashRefs = buildDashboard();
		document.body.appendChild(dashRefs.root);
	}
	return dashRefs;
}

function setDashVisible(visible: boolean): void {
	if (!dashRefs) return;
	dashRefs.root.style.display = visible ? "flex" : "none";
}

function renderDashboardCards(refs: DashRefs): void {
	const r = state.get().rn;
	const sess = state.get().session;
	refs.accountLabel.textContent = sess
		? `Signed in as ${sess.email}${sess.isOwner ? " · Owner" : ""}`
		: "";
	const q = dashSearchQuery.trim().toLowerCase();
	const filtered = r.registry.filter((p) => {
		if (!q) return true;
		const hay = `${p.slug} ${p.name ?? ""}`.toLowerCase();
		return hay.includes(q);
	});

	refs.cardsGrid.replaceChildren();
	if (r.registry.length === 0) {
		refs.emptyState.style.display = "";
		refs.cardsGrid.style.display = "none";
		return;
	}
	refs.emptyState.style.display = "none";
	refs.cardsGrid.style.display = "";

	if (filtered.length === 0) {
		const noResults = ce("div", "dash-no-results");
		noResults.textContent = `No project matches “${dashSearchQuery}”.`;
		refs.cardsGrid.appendChild(noResults);
		return;
	}

	for (const p of filtered) {
		const card = ce("button", "dash-card");
		card.type = "button";
		const type = projectTypeOf(p.slug);
		const connected = r.projects.includes(p.slug);
		// A "device project" is a non-web project with no local repo — created
		// via "Add simulator app". It captures bridge-less via simctl, so the
		// repo-only actions (Doctor / Refresh / Improve) don't apply.
		const isDevice = type !== "web" && !p.rnAppDir;

		const top = ce("div", "dash-card-top");
		const badge = ce("span", `dash-card-type dash-card-type-${type}`);
		badge.textContent = type === "web" ? "WEB" : isDevice ? "DEVICE" : "MOBILE";
		const status = ce("span", `dash-card-status ${connected ? "is-connected" : ""}`);
		status.title = isDevice
			? "Simulator capture — no snap-bridge needed"
			: connected
				? "snap-bridge connected"
				: "not connected";
		top.append(badge, status);

		const nameEl = ce("div", "dash-card-name");
		nameEl.textContent = p.name || p.slug;
		const slugEl = ce("div", "dash-card-slug");
		slugEl.textContent = p.slug;

		// Hover-revealed action row, top-right of the card.
		// Refresh re-runs snap-flows-scan; remove drops the project from
		// Capture's local registry (doesn't touch the customer repo).
		const actions = ce("div", "dash-card-actions");
		const doctorBtn = ce("button", "dash-card-action");
		doctorBtn.type = "button";
		doctorBtn.title = "Run Doctor — per-project health check (bridge, version pin, layout wiring, …)";
		doctorBtn.setAttribute("aria-label", `Run Doctor for ${p.slug}`);
		doctorBtn.appendChild(icon("activity", { size: 14 }));
		doctorBtn.addEventListener("click", (ev) => {
			ev.stopPropagation();
			ev.preventDefault();
			void openDoctorPanel(p.slug, p.name);
		});

		const refreshBtn = ce("button", "dash-card-action");
		refreshBtn.type = "button";
		refreshBtn.title =
			"Re-scan app/ folder and regenerate snap-flows.ts (run after route changes)";
		refreshBtn.setAttribute("aria-label", `Refresh flows for ${p.slug}`);
		refreshBtn.appendChild(icon("refresh-cw", { size: 14 }));
		refreshBtn.addEventListener("click", (ev) => {
			ev.stopPropagation();
			ev.preventDefault();
			void doRefreshProjectFlows(p.slug, p.name, refreshBtn);
		});

		const improveBtn = ce("button", "dash-card-action");
		improveBtn.type = "button";
		improveBtn.title =
			"Copy a Claude-Code-ready prompt to clipboard. Paste it in Claude inside this repo to regroup snap-flows.ts by user-journey.";
		improveBtn.setAttribute("aria-label", `Improve flows for ${p.slug}`);
		improveBtn.appendChild(icon("sparkles", { size: 14 }));
		improveBtn.addEventListener("click", (ev) => {
			ev.stopPropagation();
			ev.preventDefault();
			void doImproveProjectFlows(p.slug, p.name, improveBtn);
		});

		const settingsBtn = ce("button", "dash-card-action");
		settingsBtn.type = "button";
		settingsBtn.title =
			"Project settings — gallery URL, project token, last push, workspace path";
		settingsBtn.setAttribute("aria-label", `Settings for ${p.slug}`);
		settingsBtn.appendChild(icon("settings", { size: 14 }));
		settingsBtn.addEventListener("click", (ev) => {
			ev.stopPropagation();
			ev.preventDefault();
			void openProjectSettings(p.slug);
		});

		const removeBtn = ce("button", "dash-card-action dash-card-action-danger");
		removeBtn.type = "button";
		removeBtn.title =
			"Remove this project from Capture (doesn't touch the repo or platform)";
		removeBtn.setAttribute("aria-label", `Remove project ${p.slug}`);
		removeBtn.appendChild(icon("trash", { size: 14 }));
		removeBtn.addEventListener("click", (ev) => {
			ev.stopPropagation();
			ev.preventDefault();
			void doRemoveProject(p.slug, p.name);
		});

		// Device projects have no repo, so Doctor / Refresh / Improve (all
		// repo-bound) are omitted — only Settings and Remove apply.
		if (isDevice) {
			actions.append(settingsBtn, removeBtn);
		} else {
			actions.append(doctorBtn, refreshBtn, improveBtn, settingsBtn, removeBtn);
		}

		card.append(top, nameEl, slugEl, actions);
		card.addEventListener("click", () => enterProject(p.slug));
		refs.cardsGrid.appendChild(card);
	}
}

function applyDashState(_s: AppState): void {
	if (!dashRefs) return;
	renderDashboardCards(dashRefs);
}

// + Add → modal with two big tiles: Mobile (iOS Sim) or Web. Each routes to
// the right onboarding flow. For now, Web takes a name + URL (system later).
function openAddTypeChooser(): void {
	const backdrop = document.createElement("div");
	backdrop.className = "rn-confirm-backdrop";
	const dlg = document.createElement("div");
	dlg.className = "rn-confirm-dialog dash-add-dialog";

	const title = document.createElement("h3");
	title.className = "rn-confirm-title";
	title.textContent = "What kind of project?";

	const body = document.createElement("p");
	body.className = "rn-confirm-body";
	body.textContent = "Pick how you want to capture screens for this project.";

	const tiles = document.createElement("div");
	tiles.className = "dash-type-tiles";

	const mkTile = (
		iconName: IconName,
		name: string,
		sub: string,
		onClick: () => void,
	): HTMLButtonElement => {
		const t = document.createElement("button");
		t.type = "button";
		t.className = "dash-type-tile";
		const iconWrap = document.createElement("div");
		iconWrap.className = "dash-type-icon";
		iconWrap.appendChild(icon(iconName, { size: 22, strokeWidth: 1.5 }));
		const nameEl = document.createElement("div");
		nameEl.className = "dash-type-name";
		nameEl.textContent = name;
		const subEl = document.createElement("div");
		subEl.className = "dash-type-sub";
		subEl.textContent = sub;
		t.append(iconWrap, nameEl, subEl);
		t.addEventListener("click", onClick);
		return t;
	};

	const mobileTile = mkTile(
		"smartphone",
		"Mobile",
		"iOS Simulator + snap-bridge from your RN app.",
		() => {
			close();
			try {
				openWizardV2({
					req: {
						pickRepoPath: req.pickRepoPath,
						detectRepo: req.detectRepo,
						runInstaller: req.runInstaller,
						improveSnapFlows: req.improveSnapFlows,
					},
					subscribeProgress: subscribeInstallProgress,
					log,
					readLocal,
					writeLocal,
					refreshProjectRegistry,
				});
			} catch (err) {
				log(`Wizard failed to open: ${(err as Error).message}`, "error");
				console.error("openWizardV2 threw:", err);
			}
		},
	);
	const webTile = mkTile(
		"globe",
		"Web",
		"Any web app — paste a URL and capture screens from the live page.",
		() => {
			close();
			openAddWebForm();
		},
	);

	const simulatorTile = mkTile(
		"camera",
		"Simulator",
		"Snap any app in the iOS Simulator — Flutter, native, iPad, or RN. No code setup.",
		() => {
			close();
			openAddSimulatorForm();
		},
	);

	tiles.append(mobileTile, webTile, simulatorTile);

	const actions = document.createElement("div");
	actions.className = "rn-confirm-actions";
	const cancelBtn = document.createElement("button");
	cancelBtn.className = "btn btn-ghost";
	cancelBtn.textContent = "Cancel";
	actions.appendChild(cancelBtn);

	dlg.append(title, body, tiles, actions);
	backdrop.appendChild(dlg);
	document.body.appendChild(backdrop);

	const close = (): void => {
		backdrop.remove();
		document.removeEventListener("keydown", onKey);
	};
	const onKey = (e: KeyboardEvent): void => {
		if (e.key === "Escape") close();
	};
	cancelBtn.addEventListener("click", close);
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) close();
	});
	document.addEventListener("keydown", onKey);
}

// Simulator project onboarding — minimal, no repo. Registers a gallery
// project (platform ios) so bridge-less device snaps have somewhere to land.
// Works for any simulator app: Flutter, native iOS, iPad, or RN without the
// bridge. The exact device is chosen later via the topbar Device picker.
function openAddSimulatorForm(): void {
	const form = {
		name: "",
		platformUrl: readLocal("prisma:platform-url") ?? "",
		token: readLocal("prisma:setup-token") ?? "",
		error: undefined as string | undefined,
		busy: false,
	};

	const backdrop = ce("div", "rn-confirm-backdrop");
	const dlg = ce("div", "rn-confirm-dialog");
	backdrop.appendChild(dlg);
	document.body.appendChild(backdrop);

	const close = (): void => {
		backdrop.remove();
		document.removeEventListener("keydown", onKey);
	};
	const onKey = (e: KeyboardEvent): void => {
		if (e.key === "Escape") close();
	};
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) close();
	});
	document.addEventListener("keydown", onKey);

	const render = (): void => {
		dlg.replaceChildren();
		const title = ce("h3", "rn-confirm-title");
		title.textContent = "Add a simulator app";
		const body = ce("p", "rn-confirm-body");
		body.textContent =
			"Capture screens from any app running in the iOS Simulator — Flutter, native, React Native, or iPad. No code changes, no snap-bridge. You'll pick the exact device when you snap.";

		const fields = ce("div", "rn-web-wizard-fields");
		const mkField = (label: string, input: HTMLInputElement): void => {
			const lab = ce("label", "rn-push-field-label");
			lab.textContent = label;
			fields.append(lab, input);
		};
		const nameInput = ce("input", "input");
		nameInput.type = "text";
		nameInput.placeholder = "e.g. Acme iPad app";
		nameInput.value = form.name;
		nameInput.addEventListener("input", () => {
			form.name = nameInput.value;
		});
		mkField("Name", nameInput);

		const urlInput = ce("input", "input");
		urlInput.type = "url";
		urlInput.placeholder = "https://unicorn-studio-gallery.vercel.app";
		urlInput.value = form.platformUrl;
		urlInput.addEventListener("input", () => {
			form.platformUrl = urlInput.value;
		});
		mkField("Gallery URL", urlInput);

		const tokenInput = ce("input", "input");
		tokenInput.type = "password";
		tokenInput.placeholder = "setup_… or an existing pgt_… token";
		tokenInput.value = form.token;
		tokenInput.addEventListener("input", () => {
			form.token = tokenInput.value;
		});
		mkField("Setup token (or pgt_ project token)", tokenInput);

		const errorBox = ce("div", "rn-wizard-error");
		errorBox.style.display = form.error ? "" : "none";
		errorBox.textContent = form.error ?? "";

		const actions = ce("div", "rn-confirm-actions");
		const cancelBtn = ce("button", "btn btn-ghost");
		cancelBtn.type = "button";
		cancelBtn.textContent = "Cancel";
		cancelBtn.addEventListener("click", close);
		const createBtn = ce("button", "btn btn-primary");
		createBtn.type = "button";
		createBtn.textContent = form.busy ? "Creating…" : "Create";
		createBtn.disabled = form.busy;
		createBtn.addEventListener("click", () => void runCreate());
		actions.append(cancelBtn, createBtn);

		dlg.append(title, body, fields, errorBox, actions);
		queueMicrotask(() => nameInput.focus());
	};

	const runCreate = async (): Promise<void> => {
		if (form.busy) return;
		const name = form.name.trim();
		const platformUrl = form.platformUrl.trim().replace(/\/$/, "");
		const token = form.token.trim();
		if (!name) {
			form.error = "Name is required.";
			render();
			return;
		}
		// Gallery URL + token are optional for a signed-in user: the create is
		// authenticated by the session (which also assigns the project), and the
		// bun side defaults the gallery URL. Only validate a custom URL if typed.
		if (platformUrl) {
			try {
				new URL(platformUrl);
			} catch {
				form.error = "Gallery URL must be a valid URL (include https://).";
				render();
				return;
			}
		}
		form.busy = true;
		form.error = undefined;
		render();
		// Optional token field, two kinds: a pgt_ token reuses an existing gallery
		// project; anything else is treated as a setup token. With neither, the
		// signed-in session creates + assigns the project.
		const isProjectToken = token.startsWith("pgt_");
		const r = await req.createDeviceProject({
			name,
			platformUrl,
			...(token ? (isProjectToken ? { token } : { setupToken: token }) : {}),
		});
		if (!r.ok) {
			form.busy = false;
			form.error = r.error;
			render();
			return;
		}
		writeLocal("prisma:platform-url", platformUrl);
		// Don't overwrite a saved setup token with a one-off project token.
		if (!isProjectToken) writeLocal("prisma:setup-token", token);
		log(
			r.reused
				? `↻ Linked simulator project "${r.slug}"`
				: `+ Created simulator project "${r.slug}"`,
			"success",
		);
		await refreshProjectRegistry();
		close();
		enterProject(r.slug);
	};

	render();
}

// Web project onboarding — phased wizard. Mirrors mobile's wizard-v2
// (Detect → Plan → Install → Verify) for the web surface:
//
//   1. Details   — name, base URL, platform URL, setup token.
//   2. Discover  — crawl base URL, surface routes the wizard found.
//   3. Preview   — auto-group routes by URL prefix, let the user
//                  edit (rename / toggle).
//   4. Create    — POST to gallery, persist locally, seed orchestrator
//                  with the preview flows.
//
// The user can skip discovery (e.g. SPA without server-rendered links)
// and land on a blank flow tree — auto-flows still get created on the
// first snap, same as Phase 1 web onboarding.
type WebWizardPhase = "details" | "discover" | "preview" | "create";
interface WebWizardState {
	phase: WebWizardPhase;
	name: string;
	baseUrl: string;
	platformUrl: string;
	setupToken: string;
	routes: Array<{ path: string; title?: string }>;
	flows: Array<{ id: string; name: string; routes: string[]; include: boolean }>;
	hint: "ok" | "spa" | "auth-wall" | "blocked";
	error?: string;
}
function openAddWebForm(): void {
	const wiz: WebWizardState = {
		phase: "details",
		name: "",
		baseUrl: "",
		platformUrl: readLocal("prisma:platform-url") ?? "",
		setupToken: readLocal("prisma:setup-token") ?? "",
		routes: [],
		flows: [],
		hint: "ok",
	};

	const backdrop = ce("div", "rn-confirm-backdrop");
	const dlg = ce("div", "rn-confirm-dialog rn-web-wizard");
	backdrop.appendChild(dlg);
	document.body.appendChild(backdrop);

	const close = (): void => {
		backdrop.remove();
		document.removeEventListener("keydown", onKey);
	};
	const onKey = (e: KeyboardEvent): void => {
		if (e.key === "Escape") close();
	};
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) close();
	});
	document.addEventListener("keydown", onKey);

	const render = (): void => {
		dlg.replaceChildren();
		// Stepper across the top: shows the user which phase they're in
		// + lets them go back to "details" to fix a typo without
		// re-running discovery.
		const stepper = ce("div", "rn-web-wizard-stepper");
		const phases: Array<{ key: WebWizardPhase; label: string }> = [
			{ key: "details", label: "1. Details" },
			{ key: "discover", label: "2. Discover" },
			{ key: "preview", label: "3. Preview" },
			{ key: "create", label: "4. Create" },
		];
		for (const p of phases) {
			const chip = ce("span", "rn-web-wizard-step");
			if (p.key === wiz.phase) chip.classList.add("is-active");
			if (
				phases.findIndex((x) => x.key === p.key) <
				phases.findIndex((x) => x.key === wiz.phase)
			) {
				chip.classList.add("is-done");
			}
			chip.textContent = p.label;
			stepper.appendChild(chip);
		}
		dlg.appendChild(stepper);

		if (wiz.phase === "details") renderDetails();
		else if (wiz.phase === "discover") renderDiscover();
		else if (wiz.phase === "preview") renderPreview();
		else if (wiz.phase === "create") renderCreate();
	};

	const renderDetails = (): void => {
		const title = ce("h3", "rn-confirm-title");
		title.textContent = "Add web project";
		const body = ce("p", "rn-confirm-body");
		body.textContent =
			"Register the project on the gallery, then we'll scan the base URL for routes and auto-group them into flows before you snap.";

		const fields = ce("div", "rn-web-wizard-fields");
		const mkField = (label: string, input: HTMLInputElement): void => {
			const lab = ce("label", "rn-push-field-label");
			lab.textContent = label;
			fields.append(lab, input);
		};
		const nameInput = ce("input", "input");
		nameInput.type = "text";
		nameInput.placeholder = "e.g. Acme Storefront";
		nameInput.value = wiz.name;
		nameInput.addEventListener("input", () => {
			wiz.name = nameInput.value;
		});
		mkField("Name", nameInput);

		const urlInput = ce("input", "input");
		urlInput.type = "url";
		urlInput.placeholder = "https://your-app.example.com/";
		urlInput.value = wiz.baseUrl;
		urlInput.addEventListener("input", () => {
			wiz.baseUrl = urlInput.value;
		});
		mkField("Base URL", urlInput);

		const platformInput = ce("input", "input");
		platformInput.type = "url";
		platformInput.placeholder = "https://unicorn-studio-gallery.vercel.app";
		platformInput.value = wiz.platformUrl;
		platformInput.addEventListener("input", () => {
			wiz.platformUrl = platformInput.value;
		});
		mkField("Platform URL", platformInput);

		const tokenInput = ce("input", "input");
		tokenInput.type = "password";
		tokenInput.placeholder = "setup_…";
		tokenInput.value = wiz.setupToken;
		tokenInput.addEventListener("input", () => {
			wiz.setupToken = tokenInput.value;
		});
		mkField("Setup token", tokenInput);

		const errorBox = ce("div", "rn-wizard-error");
		errorBox.style.display = wiz.error ? "" : "none";
		errorBox.textContent = wiz.error ?? "";

		const actions = ce("div", "rn-confirm-actions");
		const cancelBtn = ce("button", "btn btn-ghost");
		cancelBtn.type = "button";
		cancelBtn.textContent = "Cancel";
		cancelBtn.addEventListener("click", close);
		const nextBtn = ce("button", "btn btn-primary");
		nextBtn.type = "button";
		nextBtn.textContent = "Discover routes";
		nextBtn.addEventListener("click", () => {
			const name = wiz.name.trim();
			const baseUrl = wiz.baseUrl.trim();
			const platformUrl = wiz.platformUrl.trim().replace(/\/$/, "");
			const setupToken = wiz.setupToken.trim();
			// Platform URL + setup token are optional for a signed-in user: the
			// create is authenticated by the session (which assigns the project)
			// and the bun side defaults the gallery URL. Base URL is still required
			// — a web project needs somewhere to capture from.
			if (!name || !baseUrl) {
				wiz.error = "Name and base URL are required.";
				render();
				return;
			}
			try {
				new URL(baseUrl);
			} catch {
				wiz.error = "Base URL must be a valid URL (include https:// prefix).";
				render();
				return;
			}
			wiz.name = name;
			wiz.baseUrl = baseUrl;
			wiz.platformUrl = platformUrl;
			wiz.setupToken = setupToken;
			wiz.error = undefined;
			wiz.phase = "discover";
			render();
			void runDiscover();
		});
		actions.append(cancelBtn, nextBtn);

		dlg.append(title, body, fields, errorBox, actions);
		queueMicrotask(() => nameInput.focus());
	};

	const renderDiscover = (): void => {
		const title = ce("h3", "rn-confirm-title");
		title.textContent = "Scanning the base URL…";
		const body = ce("p", "rn-confirm-body");
		body.textContent = `Following internal links from ${wiz.baseUrl} to find routes the wizard can pre-organize into flows.`;
		const spinner = ce("div", "rn-web-wizard-spinner");
		spinner.textContent = "⠋";
		// Rotating dot animation via CSS would be cleaner but this works.
		let i = 0;
		const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		const tick = window.setInterval(() => {
			i = (i + 1) % frames.length;
			spinner.textContent = frames[i] ?? "⠋";
		}, 80);
		const stop = (): void => window.clearInterval(tick);
		backdrop.addEventListener("transitionend", stop, { once: true });
		dlg.append(title, body, spinner);
	};

	const runDiscover = async (): Promise<void> => {
		try {
			const r = await req.discoverWebRoutes({ baseUrl: wiz.baseUrl, limit: 50 });
			if (!r.ok) {
				wiz.error = r.error;
				wiz.phase = "details";
				render();
				return;
			}
			wiz.routes = r.routes;
			wiz.hint = r.hint;
			wiz.flows = autoGroupRoutes(r.routes);
			wiz.phase = "preview";
			render();
		} catch (err) {
			wiz.error = (err as Error).message;
			wiz.phase = "details";
			render();
		}
	};

	const renderPreview = (): void => {
		const title = ce("h3", "rn-confirm-title");
		title.textContent =
			wiz.routes.length === 0
				? "No routes discovered"
				: `Found ${wiz.routes.length} route${wiz.routes.length === 1 ? "" : "s"} · ${wiz.flows.filter((f) => f.include).length} auto-flows`;
		const body = ce("p", "rn-confirm-body");
		if (wiz.hint === "spa") {
			body.textContent =
				"This looks like an SPA without server-rendered links — only the root path was found. You can still create the project; auto-flows will get created from the URL path on each snap.";
		} else if (wiz.hint === "auth-wall") {
			body.textContent =
				"The base URL responded with an auth wall. Only routes linked from the login page are listed. You can still create the project and snap behind auth once the iframe is logged in.";
		} else if (wiz.hint === "blocked") {
			body.textContent =
				"The base URL didn't respond or blocked the request. You can still create the project — flows will get auto-created on your first snap.";
		} else {
			body.textContent =
				"Review the auto-grouping below — uncheck flows you don't want pre-created. Snaps captured on routes from an unchecked flow will still cluster into a fresh flow lazily.";
		}

		const list = ce("ul", "rn-web-wizard-flows");
		for (const f of wiz.flows) {
			const li = ce("li", "rn-web-wizard-flow");
			const check = ce("input", "rn-web-wizard-check") as HTMLInputElement;
			check.type = "checkbox";
			check.checked = f.include;
			check.addEventListener("change", () => {
				f.include = check.checked;
			});
			const meta = ce("div", "rn-web-wizard-flow-meta");
			const name = ce("input", "input rn-web-wizard-flow-name") as HTMLInputElement;
			name.type = "text";
			name.value = f.name;
			name.addEventListener("input", () => {
				f.name = name.value;
			});
			const routes = ce("div", "rn-web-wizard-flow-routes");
			routes.textContent = f.routes.join(" · ");
			meta.append(name, routes);
			li.append(check, meta);
			list.appendChild(li);
		}

		const errorBox = ce("div", "rn-wizard-error");
		errorBox.style.display = wiz.error ? "" : "none";
		errorBox.textContent = wiz.error ?? "";

		const actions = ce("div", "rn-confirm-actions");
		const backBtn = ce("button", "btn btn-ghost");
		backBtn.type = "button";
		backBtn.textContent = "Back";
		backBtn.addEventListener("click", () => {
			wiz.phase = "details";
			render();
		});
		const skipBtn = ce("button", "btn btn-ghost");
		skipBtn.type = "button";
		skipBtn.textContent = "Skip auto-flows";
		skipBtn.title = "Create the project with an empty flow tree";
		skipBtn.addEventListener("click", () => {
			wiz.flows = wiz.flows.map((f) => ({ ...f, include: false }));
			wiz.phase = "create";
			render();
			void runCreate();
		});
		const createBtn = ce("button", "btn btn-primary");
		createBtn.type = "button";
		createBtn.textContent = "Create project";
		createBtn.addEventListener("click", () => {
			wiz.phase = "create";
			render();
			void runCreate();
		});
		actions.append(backBtn, skipBtn, createBtn);

		dlg.append(title, body, list, errorBox, actions);
	};

	const renderCreate = (): void => {
		const title = ce("h3", "rn-confirm-title");
		title.textContent = "Creating project…";
		const body = ce("p", "rn-confirm-body");
		body.textContent =
			"Registering on the gallery, persisting locally, and seeding the orchestrator with the flows you approved.";
		dlg.append(title, body);
	};

	const runCreate = async (): Promise<void> => {
		const seedFlows = wiz.flows
			.filter((f) => f.include && f.routes.length > 0 && f.name.trim().length > 0)
			.map((f) => ({ id: f.id, name: f.name.trim(), routes: f.routes }));
		try {
			const r = await req.createWebProject({
				name: wiz.name,
				baseUrl: wiz.baseUrl,
				platformUrl: wiz.platformUrl,
				setupToken: wiz.setupToken,
				seedFlows: seedFlows.length > 0 ? seedFlows : undefined,
			});
			if (!r.ok) {
				wiz.error = r.error;
				wiz.phase = "preview";
				render();
				return;
			}
			writeLocal("prisma:platform-url", wiz.platformUrl);
			writeLocal("prisma:setup-token", wiz.setupToken);
			const seedTail =
				r.seededFlows && r.seededFlows > 0
					? ` with ${r.seededFlows} flow${r.seededFlows === 1 ? "" : "s"}`
					: "";
			log(
				r.reused
					? `↻ Reused existing project "${r.slug}"${seedTail}`
					: `+ Created web project "${r.slug}"${seedTail}`,
				"success",
			);
			await refreshProjectRegistry();
			// Re-pull flows so the sidebar reflects the seeded tree
			// when the user enters the project.
			try {
				const status = await req.snapServerStatus({});
				state.set((cur) => ({
					...cur,
					rn: { ...cur.rn, flows: status.flows },
				}));
			} catch {}
			state.set((cur) => ({
				...cur,
				source: { ...cur.source, kind: "url", url: wiz.baseUrl },
				rn: { ...cur.rn, selectedProjectSlug: r.slug },
			}));
			close();
		} catch (err) {
			wiz.error = (err as Error).message;
			wiz.phase = "preview";
			render();
		}
	};

	render();
}

/**
 * Auto-group discovered routes by the first path segment. `/auth/login`
 * and `/auth/signup` cluster into "Auth"; `/dashboard` is its own flow.
 * Same heuristic the orchestrator's `ensureAutoFlowWithPlacement` uses
 * lazily on first snap, lifted to the wizard so the preview matches
 * what'll happen later.
 */
function autoGroupRoutes(
	routes: ReadonlyArray<{ path: string; title?: string }>,
): Array<{ id: string; name: string; routes: string[]; include: boolean }> {
	const groups = new Map<string, string[]>();
	for (const r of routes) {
		const path = r.path || "/";
		const seg = path.split("/").filter(Boolean)[0] ?? "home";
		const list = groups.get(seg) ?? [];
		list.push(path);
		groups.set(seg, list);
	}
	return [...groups.entries()].map(([seg, paths]) => ({
		id: seg,
		name: prettyFlowName(seg),
		routes: paths,
		include: true,
	}));
}

function prettyFlowName(slug: string): string {
	if (slug === "home" || slug === "") return "Home";
	return slug
		.split(/[-_]/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

// ─── WEB MODE LAYOUT (URL / Local) ───
// Mirrors the iOS Sim editorial shell: 3 columns + persistent center iframe.
// Capture system is wired in a later pass; this is the UI scaffold.
type WebTab = "live" | "library";
interface WebRefs {
	root: HTMLDivElement;
	urlInput: HTMLInputElement;
	loadBtn: HTMLButtonElement;
	reloadBtn: HTMLButtonElement;
	snapBtn: HTMLButtonElement;
	iframe: HTMLIFrameElement;
	flowsList: HTMLDivElement;
	filmstrip: HTMLDivElement;
	sourceUrlInput: HTMLInputElement;
	sourceLoadBtn: HTMLButtonElement;
	sourceDropzone: HTMLDivElement;
	sessionMeta: HTMLDivElement;
	tabLive: HTMLButtonElement;
	tabLibrary: HTMLButtonElement;
	paneLive: HTMLDivElement;
	paneLibrary: HTMLDivElement;
	libraryGrid: HTMLDivElement;
	setTab: (tab: WebTab) => void;
	getTab: () => WebTab;
}
let webRefs: WebRefs | null = null;

function buildWebLayout(): WebRefs {
	const root = ce("div", "web-root");
	root.id = "web-root";
	root.style.display = "none";

	const layout = ce("div", "web-layout");

	// LEFT — flows tree (placeholder until system is wired)
	const sidebar = ce("aside", "web-sidebar");
	const flowsTitle = ce("div", "section-title");
	flowsTitle.textContent = "Flows";
	const flowsList = ce("div", "rn-flows-side");
	const empty = ce("div", "rn-flows-side-empty");
	empty.textContent = "No snaps yet — load a URL and snap to start.";
	flowsList.appendChild(empty);
	sidebar.append(flowsTitle, flowsList);

	// MIDDLE — Tab strip (Live | Library) + tab panes
	const main = ce("main", "web-main");

	// Tab strip header — Live tab is hidden for now; capture happens via
	// the Chrome extension, and the Library is the only meaningful pane.
	// Strip stays in the DOM so we can restore Live later without a refactor.
	const tabStrip = ce("div", "web-tabs tabs");
	tabStrip.style.display = "none";
	const tabLive = ce("button", "tab");
	tabLive.type = "button";
	tabLive.append(icon("play", { size: 12 }), document.createTextNode("Live"));
	const tabLibrary = ce("button", "tab is-active");
	tabLibrary.type = "button";
	tabLibrary.append(
		icon("image", { size: 12 }),
		document.createTextNode("Library"),
	);
	tabStrip.append(tabLive, tabLibrary);

	// LIVE pane — URL bar + iframe + filmstrip (kept mounted but hidden so
	// the iframe URL persistence + state machinery doesn't break).
	const paneLive = ce("div", "web-pane web-pane-live");
	const urlBar = ce("div", "web-urlbar");
	const reloadBtn = ce("button", "btn btn-ghost btn-icon btn-sm");
	reloadBtn.title = "Reload";
	reloadBtn.appendChild(icon("refresh-cw", { size: 14 }));
	const urlInput = ce("input", "input web-url-input");
	urlInput.type = "url";
	urlInput.placeholder = "https://your-app.example.com/";
	const loadBtn = ce("button", "btn btn-secondary btn-sm");
	loadBtn.textContent = "Load";

	// Device size picker — pins the iframe to a known viewport so every
	// snap from this device is the same dimensions. Desktop is the
	// default for new sessions; selection persists per-Capture install
	// via localStorage so designers can re-open into the same preset.
	const devicePicker = ce("select", "input web-device-picker");
	for (const opt of [
		{ key: "desktop", label: "Desktop 1440×900" },
		{ key: "tablet", label: "Tablet 768×1024" },
		{ key: "mobile", label: "Mobile 375×667" },
	]) {
		const optEl = document.createElement("option");
		optEl.value = opt.key;
		optEl.textContent = opt.label;
		devicePicker.appendChild(optEl);
	}
	const SAVED_DEVICE = (readLocal("prisma:web-device") || "desktop") as
		| "desktop"
		| "tablet"
		| "mobile";
	devicePicker.value = SAVED_DEVICE;

	const snapBtn = ce("button", "btn btn-primary btn-sm");
	snapBtn.title = "Snap (⌘⇧S)";
	snapBtn.append(icon("camera", { size: 14 }), document.createTextNode("Snap"));
	urlBar.append(reloadBtn, urlInput, loadBtn, devicePicker, snapBtn);

	const stage = ce("div", "web-stage");
	const iframeWrap = ce("div", "web-iframe-wrap");
	const iframe = ce("iframe", "web-iframe");
	iframe.title = "Web preview";
	iframeWrap.appendChild(iframe);
	stage.appendChild(iframeWrap);

	// Apply persisted device size on mount so the iframe loads at the
	// right viewport from the first paint (no jarring resize after a
	// short delay).
	applyDevicePreset(iframe, SAVED_DEVICE);
	devicePicker.addEventListener("change", () => {
		const value = devicePicker.value as "desktop" | "tablet" | "mobile";
		writeLocal("prisma:web-device", value);
		applyDevicePreset(iframe, value);
	});

	const filmstripWrap = ce("div", "web-filmstrip-wrap");
	const filmstripLabel = ce("div", "web-filmstrip-label");
	filmstripLabel.textContent = "Recent snaps";
	const filmstrip = ce("div", "web-filmstrip");
	const filmEmpty = ce("div", "web-filmstrip-empty");
	filmEmpty.textContent = "No snaps yet.";
	filmstrip.appendChild(filmEmpty);
	filmstripWrap.append(filmstripLabel, filmstrip);

	paneLive.append(urlBar, stage, filmstripWrap);

	// LIBRARY pane — snap gallery grouped by flow (placeholder until system is wired)
	const paneLibrary = ce("div", "web-pane web-pane-library is-active");
	const libraryEmpty = ce("div", "web-library-empty");
	const libIcon = ce("div", "web-library-empty-icon");
	libIcon.appendChild(icon("image", { size: 32, strokeWidth: 1.5 }));
	const libTitle = ce("div", "web-library-empty-title");
	libTitle.textContent = "Your snap library is empty";
	const libHint = ce("div", "web-library-empty-hint");
	libHint.textContent =
		"Open the page in Chrome, click the Unicorn Capture extension, and snap. Captures land here grouped by flow.";
	const libCta = ce("button", "btn btn-secondary btn-sm web-library-empty-cta");
	libCta.type = "button";
	libCta.style.display = "none";
	libraryEmpty.append(libIcon, libTitle, libHint, libCta);
	const libraryGrid = ce("div", "web-library-grid");
	libraryGrid.appendChild(libraryEmpty);
	paneLibrary.appendChild(libraryGrid);

	main.append(tabStrip, paneLive, paneLibrary);

	// RIGHT — context (Source URL/dropzone, Project, Session)
	const rightPanel = ce("aside", "web-rightpanel");
	// Hidden for now: the Source dropzone + session meta were Live-mode
	// affordances. With the Chrome extension as the snap surface, the right
	// rail is dead weight. Kept mounted so future modes can re-enable it.
	rightPanel.style.display = "none";
	const sourceSection = ce("div", "section");
	const sourceSectionTitle = ce("div", "section-title");
	sourceSectionTitle.textContent = "Source";
	const sourceUrlInput = ce("input", "input");
	sourceUrlInput.type = "url";
	sourceUrlInput.placeholder = "https://… or /local/path";
	const sourceLoadBtn = ce("button", "btn btn-secondary btn-sm web-source-load");
	sourceLoadBtn.textContent = "Load URL";
	const sourceDivider = ce("div", "src-divider");
	const sourceDividerSpan = ce("span");
	sourceDividerSpan.textContent = "or drop a folder / archive";
	sourceDivider.appendChild(sourceDividerSpan);
	const sourceDropzone = ce("div", "dropzone");
	sourceDropzone.dataset.srcDrop = "";
	sourceDropzone.dataset.srcKind = "local";
	const dropIcon = ce("div", "dropzone-icon");
	dropIcon.appendChild(icon("folder", { size: 28, strokeWidth: 1.5 }));
	const dropText = ce("div", "dropzone-text");
	dropText.textContent = "Drop folder or archive (.zip / .tar.gz)";
	const dropHint = ce("div", "dropzone-hint");
	dropHint.textContent = "or click to browse";
	sourceDropzone.append(dropIcon, dropText, dropHint);
	sourceSection.append(
		sourceSectionTitle,
		sourceUrlInput,
		sourceLoadBtn,
		sourceDivider,
		sourceDropzone,
	);

	const sessionSection = ce("div", "section");
	const sessionTitle = ce("div", "section-title");
	sessionTitle.textContent = "This session";
	const sessionMeta = ce("div", "rn-session-meta");
	const sessionId = ce("div", "rn-session-id");
	sessionId.textContent = "—";
	const sessionCount = ce("div", "rn-session-count");
	sessionCount.textContent = "0 snaps";
	sessionMeta.append(sessionId, sessionCount);
	sessionSection.append(sessionTitle, sessionMeta);

	rightPanel.append(sourceSection, sessionSection);

	layout.append(sidebar, main, rightPanel);
	root.appendChild(layout);

	let currentTab: WebTab = "library";
	const setTab = (tab: WebTab): void => {
		currentTab = tab;
		const liveActive = tab === "live";
		tabLive.classList.toggle("is-active", liveActive);
		tabLive.classList.toggle("active", liveActive);
		tabLibrary.classList.toggle("is-active", !liveActive);
		tabLibrary.classList.toggle("active", !liveActive);
		paneLive.classList.toggle("is-active", liveActive);
		paneLibrary.classList.toggle("is-active", !liveActive);
	};
	tabLive.addEventListener("click", () => setTab("live"));
	tabLibrary.addEventListener("click", () => {
		setTab("library");
		if (webRefs) renderWebLibrary(webRefs);
	});
	tabLibrary.classList.add("active");

	const refs: WebRefs = {
		root,
		urlInput,
		loadBtn,
		reloadBtn,
		snapBtn,
		iframe,
		flowsList,
		filmstrip,
		sourceUrlInput,
		sourceLoadBtn,
		sourceDropzone,
		sessionMeta,
		tabLive,
		tabLibrary,
		paneLive,
		paneLibrary,
		libraryGrid,
		setTab,
		getTab: () => currentTab,
	};

	// Wire URL bar + sidebar source: typing in either updates state.source.url;
	// Load sets iframe.src directly (system replacement comes later).
	const setUrl = (val: string): void => {
		state.set((cur) => ({
			...cur,
			source: { ...cur.source, url: val, kind: "url" },
		}));
	};
	const loadIframe = (): void => {
		const u = state.get().source.url.trim();
		if (!u) return;
		iframe.src = u;
	};
	urlInput.addEventListener("input", () => setUrl(urlInput.value));
	urlInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") loadIframe();
	});
	loadBtn.addEventListener("click", loadIframe);
	reloadBtn.addEventListener("click", () => {
		try {
			iframe.src = iframe.src;
		} catch {}
	});
	snapBtn.addEventListener("click", () => void doWebSnap());

	// Render the library grid initially + whenever it changes. The Live
	// tab's URL bar share state with the same urlInput so loading a URL
	// while on Library doesn't lose the typed value.
	renderWebLibrary(refs);
	sourceUrlInput.addEventListener("input", () => setUrl(sourceUrlInput.value));
	sourceUrlInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") loadIframe();
	});
	sourceLoadBtn.addEventListener("click", loadIframe);

	return refs;
}

function ensureWebMounted(): WebRefs {
	if (!webRefs) {
		// Clean up any leftover from a previous module load (HMR/hot-reload).
		document.getElementById("web-root")?.remove();
		webRefs = buildWebLayout();
		document.body.appendChild(webRefs.root);
	}
	return webRefs;
}

function setWebVisible(visible: boolean): void {
	if (!webRefs) return;
	webRefs.root.style.display = visible ? "flex" : "none";
	// On enter, auto-load the project's persisted baseUrl into the iframe
	// so the user can snap immediately without manually typing the URL.
	// We only auto-load when the iframe is empty (or showing about:blank)
	// so subsequent re-entries don't blow away an in-progress nav.
	if (visible) {
		const slug = state.get().rn.selectedProjectSlug;
		const proj = state.get().rn.registry.find((p) => p.slug === slug);
		const baseUrl = proj?.baseUrl;
		if (baseUrl && (!webRefs.iframe.src || webRefs.iframe.src === "about:blank")) {
			webRefs.iframe.src = baseUrl;
			webRefs.urlInput.value = baseUrl;
		}
	}
}

function applyWebState(s: AppState): void {
	if (!webRefs) return;
	const refs = webRefs;
	// Compute newly-arrived snap keys so the Library can shimmer them on
	// first render — same mechanism the mobile renderer uses.
	freshSnapKeysThisRender = new Set();
	if (!seenSnapKeysPrimed) {
		for (const sn of s.rn.snaps) seenSnapKeys.add(snapKey(sn));
		seenSnapKeysPrimed = true;
	} else {
		for (const sn of s.rn.snaps) {
			const k = snapKey(sn);
			if (!seenSnapKeys.has(k)) {
				freshSnapKeysThisRender.add(k);
				seenSnapKeys.add(k);
			}
		}
	}
	// Keep URL inputs in sync without clobbering the user's caret position.
	const url = s.source.url ?? "";
	if (document.activeElement !== refs.urlInput && refs.urlInput.value !== url) {
		refs.urlInput.value = url;
	}
	if (
		document.activeElement !== refs.sourceUrlInput &&
		refs.sourceUrlInput.value !== url
	) {
		refs.sourceUrlInput.value = url;
	}
	refs.loadBtn.disabled = !url.trim();
	refs.reloadBtn.disabled = !refs.iframe.src;
	refs.sourceLoadBtn.disabled = !url.trim();

	// Render flow list — for the currently-selected web project, show the
	// orchestrator's flows (auto-created on snap) as a flat list. Clicking
	// a flow scrolls the library tab to its section. Mirrors mobile's
	// rn-flows-side but simpler — web doesn't have nested sub-flows yet
	// and the user isn't going to drag-reorder a 5-item list.
	renderWebSidebarFlows(refs, s);
	// Keep the library tab in sync with new snaps + deletes. Cheap
	// re-render: replaceChildren + DOM diff via fresh nodes. Snap count
	// in real projects stays under 200 — no perf concern.
	if (refs.getTab() === "library") renderWebLibrary(refs);
}

function renderWebSidebarFlows(refs: WebRefs, s: AppState): void {
	const host = refs.flowsList;
	host.replaceChildren();
	const slug = s.rn.selectedProjectSlug;
	if (!slug) {
		const empty = ce("div", "rn-flows-side-empty");
		empty.textContent = "Open a web project to see its flows.";
		host.appendChild(empty);
		return;
	}
	const projectFlows = s.rn.flows.filter((f) => f.projectId === slug);
	const projectSnaps = s.rn.snaps.filter((sn) => sn.projectId === slug);
	if (projectFlows.length === 0 && projectSnaps.length === 0) {
		const empty = ce("div", "rn-flows-side-empty");
		empty.textContent = "No flows yet — snap from the extension to start.";
		host.appendChild(empty);
		return;
	}
	const groups = groupSnapsByFlow(projectSnaps, projectFlows);
	// Reuse the mobile sidebar tree — same drag/reorder/reparent, same
	// unseen-badge behavior, same hierarchy rendering. The library grid is
	// the scroll target it'll smooth-scroll into view on click.
	renderSidebarFlowTree(host, groups, refs.libraryGrid);
}

function switchSource(kind: SourceKind): void {
	state.set((cur) => ({
		...cur,
		source: { ...cur.source, kind },
		error: null,
	}));
}

function readLocal(key: string): string {
	try {
		return window.localStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}
function writeLocal(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {}
}

/**
 * Capture a screen.
 *   mode === "auto"     → existing slot (route + stateHash) is REPLACED;
 *                         prior image moves to versions[]. Best for redesign.
 *   mode === "variant"  → always create a NEW card on the same slot.
 *                         Best for long pages (top/middle/bottom) + filter
 *                         states the improver hasn't given a stateHash to.
 */

/**
 * Run a one-click tour of every declared screen in the active project.
 * Drives the existing `/tour/goto` → `ready` → `snap` cycle on the
 * snap-server for each declared screen. Surfaces a progress spinner,
 * then a results modal with per-screen success/failure so designers
 * can see at a glance what worked and what didn't.
 *
 * No declared screens? Tells the user up front instead of running a
 * 0-step tour and confusing them.
 */
async function doRunTour(): Promise<void> {
	const cur = state.get();
	const slug = cur.rn.selectedProjectSlug;
	if (!slug) {
		log("Pick a project first.", "info");
		return;
	}
	if (!cur.rn.projects.includes(slug)) {
		log(
			"Bridge isn't connected. Boot your app first, then re-run the tour.",
			"error",
		);
		return;
	}
	const flowsForProject = cur.rn.flows.filter((f) => f.projectId === slug);
	const totalDeclaredScreens = flowsForProject.reduce(
		(sum, f) => sum + (f.screens?.filter((s) => !s.hidden).length ?? 0),
		0,
	);
	if (totalDeclaredScreens === 0) {
		log(
			"No declared screens in this project — add screens to your snap-flows.ts to enable tour mode.",
			"info",
		);
		return;
	}
	const projName =
		cur.rn.registry.find((p) => p.slug === slug)?.name ?? slug;
	const ok = await showConfirm({
		title: `Run tour for ${projName}?`,
		body: `Capture will navigate through ${totalDeclaredScreens} declared screen${totalDeclaredScreens === 1 ? "" : "s"} and snap each one. The app will jump around — don't drive the simulator until it finishes.`,
		confirmLabel: "Start tour",
	});
	if (!ok) return;
	state.set((c) => ({ ...c, rn: { ...c.rn, pushing: true } }));
	// Show a quick "Running…" toast so the user knows something's happening.
	// The full results land in showTourSummary at the end.
	log(`Running tour over ${totalDeclaredScreens} screen(s)…`, "info");
	try {
		const r = await req.runProjectTour({ projectSlug: slug });
		if (!r.ok) {
			log(`Tour failed: ${r.error}`, "error");
			return;
		}
		showTourSummary({
			total: r.total,
			succeeded: r.succeeded,
			failed: r.failed,
			visits: r.visits,
		});
		// Refresh status so the new snaps show up in the grid.
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
		log(`Tour failed: ${(err as Error).message}`, "error");
	} finally {
		state.set((c) => ({ ...c, rn: { ...c.rn, pushing: false } }));
	}
}

/**
 * Tour results modal — same pattern as showPushSummary: counts at the
 * top, optional failed-screens detail list, single Close action. Kept
 * thin because the tour itself already logged each step; this is just
 * a "what just happened" recap.
 */
function showTourSummary(opts: {
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
}): void {
	const backdrop = document.createElement("div");
	backdrop.className = "rn-confirm-backdrop";
	const dlg = document.createElement("div");
	dlg.className = "rn-confirm-dialog rn-push-summary-dialog";

	const title = document.createElement("h3");
	title.className = "rn-confirm-title";
	title.textContent =
		opts.failed === 0 ? "Tour complete" : "Tour finished with issues";

	const counts = document.createElement("p");
	counts.className = "rn-confirm-body";
	const parts: string[] = [`${opts.succeeded}/${opts.total} captured`];
	if (opts.failed > 0) parts.push(`${opts.failed} failed`);
	counts.textContent = parts.join(" · ");

	dlg.append(title, counts);

	const failures = opts.visits.filter((v) => !v.ok);
	if (failures.length > 0) {
		const details = document.createElement("details");
		details.className = "rn-push-summary-details";
		details.open = true;
		const summary = document.createElement("summary");
		summary.textContent = `Failed screens (${failures.length})`;
		details.appendChild(summary);
		const list = document.createElement("ul");
		list.className = "rn-push-summary-list";
		for (const f of failures.slice(0, 20)) {
			const li = document.createElement("li");
			li.textContent = `${f.flowName} → ${f.screenName} (${f.route})${f.error ? ` — ${f.error}` : ""}`;
			list.appendChild(li);
		}
		if (failures.length > 20) {
			const li = document.createElement("li");
			li.className = "rn-push-summary-more";
			li.textContent = `…and ${failures.length - 20} more`;
			list.appendChild(li);
		}
		details.appendChild(list);
		dlg.appendChild(details);
	}

	const actions = document.createElement("div");
	actions.className = "rn-confirm-actions";
	const closeBtn = document.createElement("button");
	closeBtn.className = "btn btn-primary";
	closeBtn.textContent = "Close";
	actions.appendChild(closeBtn);
	dlg.appendChild(actions);

	backdrop.appendChild(dlg);
	document.body.appendChild(backdrop);

	const close = () => {
		backdrop.remove();
		document.removeEventListener("keydown", onKey);
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape" || e.key === "Enter") close();
	};
	closeBtn.addEventListener("click", close);
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) close();
	});
	document.addEventListener("keydown", onKey);
	queueMicrotask(() => closeBtn.focus());
}

async function doSnap(
	mode: "auto" | "variant" = "auto",
	target?: {
		forceFlowId?: string;
		forceScreen?: { sessionId: string; sequence: number };
	},
): Promise<void> {
	if (state.get().rn.busy) return; // double-click guard
	state.set((cur) => ({ ...cur, rn: { ...cur.rn, busy: true } }));
	try {
		const st = state.get();
		const slug = st.rn.selectedProjectSlug ?? undefined;
		// Snap uses the connected bridge (rich route/state/full-page) when
		// present, else falls back to a bridge-less simctl device capture so
		// ANY booted simulator app (Flutter, native, iPad, or a disconnected
		// RN app) still snaps.
		const bridgeConnected = !!slug && st.rn.projects.includes(slug);
		let r: Awaited<ReturnType<typeof req.performSnap>>;
		if (bridgeConnected) {
			r = await req.performSnap({
				projectSlug: slug,
				mode,
				forceFlowId: target?.forceFlowId,
				forceScreen: target?.forceScreen,
			});
		} else if (!slug) {
			log("Open a project first, then Snap.", "error");
			return;
		} else {
			const dr = await req.deviceSnap({
				projectSlug: slug,
				deviceUdid: selectedDeviceUdid ?? undefined,
				forceFlowId: target?.forceFlowId,
			});
			r = dr.ok
				? {
						ok: true,
						snap: dr.snap,
						recordKind: "appended",
						placement: dr.placement,
						captureMethod: dr.captureMethod,
					}
				: { ok: false, error: dr.error };
		}
		if (!r.ok) {
			log(r.error, "error");
			return;
		}
		// "replaced" snaps preserve (sessionId, sequence) so we update
		// the existing entry in place; "appended" snaps push fresh.
		// Without this, the optimistic UI briefly shows a duplicate
		// before the next status poll reconciles.
		state.set((cur) => {
			const idx = cur.rn.snaps.findIndex(
				(s) =>
					s.sessionId === r.snap.sessionId &&
					s.sequence === r.snap.sequence,
			);
			const nextSnaps =
				idx >= 0
					? cur.rn.snaps.map((s, i) => (i === idx ? r.snap : s))
					: [...cur.rn.snaps, r.snap];
			return {
				...cur,
				rn: {
					...cur.rn,
					snaps: nextSnaps,
					selectedIdx: idx >= 0 ? idx : cur.rn.snaps.length,
				},
			};
		});
		rnSelectedSeq = r.snap.sequence;
		const verb =
			r.recordKind === "replaced"
				? "Updated"
				: mode === "variant"
					? "Variant"
					: "Snapped";
		// Build a "Placed in <flow> → <screen>" tail when the server told
		// us where the snap landed. For declared-match the screen name is
		// the curated label from snap-flows.ts; for auto-* the screen
		// section is omitted (route already conveys it). Drag-and-drop
		// existing on the card if the slot is wrong.
		const place = r.placement;
		const where = place
			? place.kind === "declared-match" && place.screenName
				? ` → Placed in ${place.flowName} → ${place.screenName}`
				: place.kind === "auto-new"
					? ` → New flow: ${place.flowName}`
					: ` → Placed in ${place.flowName}`
			: "";
		log(`✓ ${verb} #${r.snap.sequence} ${r.snap.route}${where}`, "success");
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
		if (place && place.kind === "auto-new") {
			log(
				"  ↳ no declared screen matched — drag the card to a curated flow if you'd rather group it manually.",
				"info",
			);
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
// Source's parentFlowId, captured on dragstart. Used to enforce sibling-only
// drops — sub-flow reorder mustn't promote a sub-flow to top-level or move
// it under a different parent via drag (those reparent ops have their own UI).
let flowDragSrcParent: string | null = null;

/**
 * Compute the new flat orderedIds for reorderFlows after a sibling
 * drag-drop. Non-sibling flows keep their positions and original order;
 * siblings of the source/target's parent get the new sibling order
 * injected into their existing slot positions in the flat array. The
 * backend stores manifest.flows as a flat list and sorts by orderedIds
 * index, so siblings staying adjacent + getting the new internal order
 * is enough.
 */
function reorderSiblings(
	allFlows: ReadonlyArray<{ id: string; parentFlowId?: string }>,
	srcId: string,
	tgtId: string,
	above: boolean,
): string[] {
	const src = allFlows.find((f) => f.id === srcId);
	if (!src) return allFlows.map((f) => f.id);
	const parent = src.parentFlowId ?? null;
	const siblings = allFlows
		.filter((f) => (f.parentFlowId ?? null) === parent)
		.map((f) => f.id);
	const withoutSrc = siblings.filter((id) => id !== srcId);
	let toIdx = withoutSrc.indexOf(tgtId);
	if (toIdx === -1) toIdx = withoutSrc.length;
	if (!above) toIdx += 1;
	withoutSrc.splice(toIdx, 0, srcId);
	const siblingIter = withoutSrc.values();
	return allFlows.map((f) => {
		if ((f.parentFlowId ?? null) === parent) {
			return siblingIter.next().value ?? f.id;
		}
		return f.id;
	});
}

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

async function doReparentFlow(
	flowId: string,
	newParentId: string | undefined,
): Promise<void> {
	state.set((cur) => ({
		...cur,
		rn: {
			...cur.rn,
			flows: cur.rn.flows.map((f) =>
				f.id === flowId
					? newParentId
						? { ...f, parentFlowId: newParentId }
						: (() => {
								const { parentFlowId: _drop, ...rest } = f;
								return rest;
							})()
					: f,
			),
		},
	}));
	try {
		const r = await req.reparentFlow({ flowId, newParentId });
		if (!r.ok) log(`Re-parent failed: ${r.error}`, "error");
	} catch (err) {
		log(`Re-parent failed: ${(err as Error).message}`, "error");
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

async function doRenameScreen(
	flowId: string,
	declaredId: string,
	name: string,
): Promise<void> {
	state.set((cur) => ({
		...cur,
		rn: {
			...cur.rn,
			flows: cur.rn.flows.map((f) => {
				if (f.id !== flowId || !f.screens) return f;
				return {
					...f,
					screens: f.screens.map((sc) =>
						sc.declaredId === declaredId ? { ...sc, name } : sc,
					),
				};
			}),
		},
	}));
	try {
		const r = await req.renameScreen({ flowId, declaredId, name });
		if (!r.ok) log(`Rename screen failed: ${r.error}`, "error");
	} catch (err) {
		log(`Rename screen failed: ${(err as Error).message}`, "error");
	}
}

async function doHideScreen(
	flowId: string,
	declaredId: string,
): Promise<void> {
	state.set((cur) => ({
		...cur,
		rn: {
			...cur.rn,
			flows: cur.rn.flows.map((f) => {
				if (f.id !== flowId || !f.screens) return f;
				return {
					...f,
					screens: f.screens.map((sc) =>
						sc.declaredId === declaredId ? { ...sc, hidden: true } : sc,
					),
				};
			}),
		},
	}));
	try {
		const r = await req.hideScreen({ flowId, declaredId });
		if (!r.ok) log(`Delete screen failed: ${r.error}`, "error");
	} catch (err) {
		log(`Delete screen failed: ${(err as Error).message}`, "error");
	}
}

async function doRenameSnap(
	sessionId: string,
	sequence: number,
	name: string,
): Promise<void> {
	const display = name.trim() || undefined;
	state.set((cur) => ({
		...cur,
		rn: {
			...cur.rn,
			snaps: cur.rn.snaps.map((s) =>
				s.sessionId === sessionId && s.sequence === sequence
					? { ...s, displayName: display }
					: s,
			),
		},
	}));
	try {
		const r = await req.renameSnap({ sessionId, sequence, name });
		if (!r.ok) log(`Rename snap failed: ${r.error}`, "error");
	} catch (err) {
		log(`Rename snap failed: ${(err as Error).message}`, "error");
	}
}

async function doRefreshProjectFlows(
	slug: string,
	name: string | undefined,
	btn: HTMLButtonElement,
): Promise<void> {
	const label = name || slug;
	if (btn.classList.contains("is-busy")) return;
	// Two-mode picker: "Add missing" (default, safe — runs --merge so
	// curated grouping survives) vs "Regenerate" (destructive — rewrites
	// snap-flows.ts from scratch). Most day-N clicks are the safe path;
	// the destructive one stays available but never default.
	const mode = await showRefreshModePicker(label);
	if (!mode) return;
	btn.classList.add("is-busy");
	btn.disabled = true;
	log(
		`${mode === "merge" ? "Scanning for new routes" : "Regenerating snap-flows.ts"} for ${label}…`,
		"info",
	);
	try {
		const r = await req.refreshProjectFlows({ slug, mode });
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

/**
 * Diff gallery vs. local registry, show a preview modal of gallery-only
 * projects, archive on confirm. Uses platform URL + setup token from
 * localStorage (cached by the +Add wizards) — if neither is there, ask
 * the user to onboard a project first so the creds get cached.
 */
/**
 * Force-evict local PNGs for every snap that's already on the gallery.
 * Behind a confirm dialog because deletion is irreversible (though
 * non-destructive — the cloud copy stays and the UI falls back to it).
 * Reports the freed disk space in MB so the user sees the win.
 */
async function doClearPushedSnaps(btn: HTMLButtonElement): Promise<void> {
	const ok = await showConfirm({
		title: "Clear cached snaps?",
		body: "Local PNGs for every snap that's already on the gallery will be deleted. Cards keep their thumbnails by loading from the cloud. Snaps that haven't been pushed yet are left alone. Frees disk space immediately.",
		confirmLabel: "Clear cache",
	});
	if (!ok) return;
	btn.disabled = true;
	const originalLabel = btn.textContent;
	btn.textContent = "Clearing…";
	try {
		const r = await req.clearPushedSnaps({});
		if (r.deleted === 0) {
			log("Nothing to clear — no pushed snaps with local files.", "info");
		} else {
			const mb = (r.freedBytes / (1024 * 1024)).toFixed(1);
			log(
				`✓ Cleared ${r.deleted} cached snap${r.deleted === 1 ? "" : "s"} — freed ${mb}MB`,
				"success",
			);
		}
	} catch (err) {
		log(`Clear cache failed: ${(err as Error).message}`, "error");
	} finally {
		btn.disabled = false;
		btn.textContent = originalLabel;
	}
}

async function doCleanupUnsynced(btn: HTMLButtonElement): Promise<void> {
	const platform = (readLocal("prisma:platform-url") ?? "").trim();
	const token = (readLocal("prisma:setup-token") ?? "").trim();
	if (!platform || !token) {
		log(
			"Cleanup needs the platform URL + setup token. Run a project +Add once so they get cached.",
			"error",
		);
		return;
	}
	btn.disabled = true;
	const originalLabel = btn.textContent;
	btn.textContent = "Scanning…";
	try {
		const r = await req.cleanupUnsyncedProjects({
			platformUrl: platform,
			setupToken: token,
			mode: "preview",
		});
		if (!r.ok) {
			log(`Cleanup scan failed: ${r.error}`, "error");
			return;
		}
		if (r.galleryOnly.length === 0) {
			log("✓ Nothing to clean up — gallery + desktop are in sync.", "success");
			return;
		}
		openCleanupConfirmModal(r.galleryOnly, platform, token);
	} catch (err) {
		log(`Cleanup scan failed: ${(err as Error).message}`, "error");
	} finally {
		btn.disabled = false;
		btn.textContent = originalLabel;
	}
}

function openCleanupConfirmModal(
	galleryOnly: ReadonlyArray<{ slug: string; name: string; platform: string }>,
	platformUrl: string,
	setupToken: string,
): void {
	const backdrop = ce("div", "rn-confirm-backdrop");
	const dlg = ce("div", "rn-confirm-dialog");
	const title = ce("h3", "rn-confirm-title");
	title.textContent = `Archive ${galleryOnly.length} unsynced project${galleryOnly.length === 1 ? "" : "s"}?`;
	const body = ce("p", "rn-confirm-body");
	body.textContent =
		"These projects exist on the gallery but not on this desktop. Archiving moves them to the gallery's 90-day grace period (restorable from the Archived view until then).";

	const list = ce("ul", "rn-cleanup-list");
	for (const p of galleryOnly) {
		const li = ce("li", "rn-cleanup-list-item");
		const tag = ce("span", "rn-cleanup-platform");
		tag.textContent = p.platform;
		const slug = ce("span", "rn-cleanup-slug");
		slug.textContent = p.slug;
		const name = ce("span", "rn-cleanup-name");
		name.textContent = p.name;
		li.append(tag, slug, name);
		list.appendChild(li);
	}

	const errorBox = ce("div", "rn-wizard-error");
	errorBox.style.display = "none";

	const actions = ce("div", "rn-confirm-actions");
	const cancelBtn = ce("button", "btn btn-ghost");
	cancelBtn.type = "button";
	cancelBtn.textContent = "Cancel";
	const confirmBtn = ce("button", "btn btn-danger");
	confirmBtn.type = "button";
	confirmBtn.textContent = "Archive all";
	actions.append(cancelBtn, confirmBtn);

	dlg.append(title, body, list, errorBox, actions);
	backdrop.appendChild(dlg);
	document.body.appendChild(backdrop);

	const close = (): void => {
		backdrop.remove();
		document.removeEventListener("keydown", onKey);
	};
	const onKey = (e: KeyboardEvent): void => {
		if (e.key === "Escape") close();
	};
	cancelBtn.addEventListener("click", close);
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) close();
	});
	document.addEventListener("keydown", onKey);

	confirmBtn.addEventListener("click", () => {
		confirmBtn.disabled = true;
		confirmBtn.textContent = "Archiving…";
		void (async () => {
			try {
				const r = await req.cleanupUnsyncedProjects({
					platformUrl,
					setupToken,
					mode: "archive",
				});
				if (!r.ok) {
					errorBox.textContent = r.error;
					errorBox.style.display = "";
					confirmBtn.disabled = false;
					confirmBtn.textContent = "Archive all";
					return;
				}
				log(
					`✓ Archived ${r.archived.length} unsynced project${r.archived.length === 1 ? "" : "s"}${r.errors.length > 0 ? ` (${r.errors.length} failed)` : ""}`,
					r.errors.length > 0 ? "warn" : "success",
				);
				for (const e of r.errors) {
					log(`  ${e.slug}: ${e.error}`, "error");
				}
				close();
			} catch (err) {
				errorBox.textContent = (err as Error).message;
				errorBox.style.display = "";
				confirmBtn.disabled = false;
				confirmBtn.textContent = "Archive all";
			}
		})();
	});
}

async function doImproveProjectFlows(
	slug: string,
	name: string | undefined,
	btn: HTMLButtonElement,
): Promise<void> {
	const label = name || slug;
	btn.classList.add("is-busy");
	btn.disabled = true;
	log(`Building Improve prompt for ${label}…`, "info");
	try {
		const r = await req.improveSnapFlows({ slug });
		if (!r.ok) {
			log(`Improve failed for ${label}: ${r.error}`, "error");
			return;
		}
		log(
			`✨ Prompt copied (${r.summary}) — paste it into Claude, then paste Claude's JSON back here.`,
			"success",
		);
		openImproveApplyModal(slug, label, r.flowsFilePath);
	} catch (err) {
		log(`Improve failed for ${label}: ${(err as Error).message}`, "error");
	} finally {
		btn.classList.remove("is-busy");
		btn.disabled = false;
	}
}

/**
 * Modal that asks the user to paste Claude's response. Parses the JSON
 * code fence, shows a quick preview (N flows, M routes), then calls
 * applyFlowGrouping on confirm. Works for both web + mobile improver
 * outputs since both emit the same JSON shape. The text area accepts
 * either a raw JSON object or a full ```json ... ``` fenced block.
 */
function openImproveApplyModal(slug: string, label: string, hintPath: string): void {
	const backdrop = ce("div", "rn-confirm-backdrop");
	const dlg = ce("div", "rn-confirm-dialog");
	const title = ce("h3", "rn-confirm-title");
	title.textContent = `Apply Claude's grouping to "${label}"`;
	const body = ce("p", "rn-confirm-body");
	body.textContent =
		`The prompt is already in your clipboard. Open Claude Code (or any LLM), paste it, then paste Claude's JSON response below. Capture will rename / regroup the flows in this project.`;
	const hint = ce("p", "rn-confirm-body");
	hint.style.fontSize = "11px";
	hint.style.color = "var(--fg-3)";
	hint.textContent = `Source of truth: orchestrator manifest (${hintPath.split("/").pop()})`;

	const textareaLabel = ce("label", "rn-push-field-label");
	textareaLabel.textContent = "Claude's response";
	const textarea = ce("textarea", "input");
	textarea.placeholder = '```json\n{\n  "flows": [\n    { "id": "auth", "name": "Auth", "routes": ["/sign-in"] }\n  ]\n}\n```';
	textarea.rows = 12;
	textarea.style.fontFamily = "var(--font-mono)";
	textarea.style.fontSize = "12px";

	const preview = ce("div", "rn-confirm-body");
	preview.style.fontSize = "12px";
	preview.style.color = "var(--fg-2)";
	preview.style.display = "none";

	const errorBox = ce("div", "rn-wizard-error");
	errorBox.style.display = "none";

	const actions = ce("div", "rn-confirm-actions");
	const cancelBtn = ce("button", "btn btn-ghost");
	cancelBtn.type = "button";
	cancelBtn.textContent = "Cancel";
	const applyBtn = ce("button", "btn btn-primary");
	applyBtn.type = "button";
	applyBtn.textContent = "Apply grouping";
	applyBtn.disabled = true;
	actions.append(cancelBtn, applyBtn);

	dlg.append(title, body, hint, textareaLabel, textarea, preview, errorBox, actions);
	backdrop.appendChild(dlg);
	document.body.appendChild(backdrop);

	let parsed: { flows: Array<{ id: string; name: string; routes: string[] }> } | null = null;

	const onInput = (): void => {
		const raw = textarea.value;
		errorBox.style.display = "none";
		preview.style.display = "none";
		parsed = null;
		applyBtn.disabled = true;
		if (!raw.trim()) return;
		try {
			parsed = parseImproveResponse(raw);
			const routeCount = parsed.flows.reduce((n, f) => n + (f.routes?.length ?? 0), 0);
			preview.textContent = `→ ${parsed.flows.length} flow${parsed.flows.length === 1 ? "" : "s"}, ${routeCount} route${routeCount === 1 ? "" : "s"}. Click Apply to commit.`;
			preview.style.display = "";
			applyBtn.disabled = false;
		} catch (err) {
			errorBox.textContent = (err as Error).message;
			errorBox.style.display = "";
		}
	};
	textarea.addEventListener("input", onInput);

	const close = (): void => {
		backdrop.remove();
		document.removeEventListener("keydown", onKey);
	};
	const onKey = (e: KeyboardEvent): void => {
		if (e.key === "Escape") close();
	};
	cancelBtn.addEventListener("click", close);
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) close();
	});
	document.addEventListener("keydown", onKey);

	applyBtn.addEventListener("click", () => {
		if (!parsed) return;
		applyBtn.disabled = true;
		applyBtn.textContent = "Applying…";
		void (async () => {
			try {
				const r = await req.applyFlowGrouping({ slug, groups: parsed!.flows });
				if (!r.ok) {
					errorBox.textContent = r.error;
					errorBox.style.display = "";
					applyBtn.disabled = false;
					applyBtn.textContent = "Apply grouping";
					return;
				}
				log(
					`✓ Applied grouping — ${r.flowsApplied} flow${r.flowsApplied === 1 ? "" : "s"} touched, ${r.snapsMoved} snap${r.snapsMoved === 1 ? "" : "s"} moved`,
					"success",
				);
				// Re-pull flows + snaps so the sidebar + library reflect the new
				// tree without a full refresh.
				try {
					const status = await req.snapServerStatus({});
					state.set((cur) => ({
						...cur,
						rn: { ...cur.rn, flows: status.flows, snaps: status.snaps },
					}));
				} catch {}
				close();
			} catch (err) {
				errorBox.textContent = (err as Error).message;
				errorBox.style.display = "";
				applyBtn.disabled = false;
				applyBtn.textContent = "Apply grouping";
			}
		})();
	});

	queueMicrotask(() => textarea.focus());
}

/**
 * Extract the JSON object from Claude's response. Accepts:
 *   - raw JSON ({ "flows": [...] })
 *   - JSON wrapped in a ```json ... ``` code fence
 *   - mobile-style snap-flows.ts contents (legacy mobile improver output)
 *     — bail out with a clear hint to use the file-based mobile path instead
 */
function parseImproveResponse(
	raw: string,
): { flows: Array<{ id: string; name: string; routes: string[] }> } {
	const trimmed = raw.trim();
	let candidate = trimmed;
	const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(trimmed);
	if (fenceMatch?.[1]) candidate = fenceMatch[1].trim();
	if (candidate.startsWith("import ") || candidate.includes("SnapFlowsDeclaration")) {
		throw new Error(
			"That looks like a snap-flows.ts file — the apply-JSON path is for the JSON shape the web prompt produces. Mobile improver writes to snap-flows.ts directly.",
		);
	}
	let obj: unknown;
	try {
		obj = JSON.parse(candidate);
	} catch (err) {
		throw new Error(`Not valid JSON: ${(err as Error).message}`);
	}
	if (!obj || typeof obj !== "object") {
		throw new Error("JSON root must be an object with a `flows` array.");
	}
	const flows = (obj as { flows?: unknown }).flows;
	if (!Array.isArray(flows)) {
		throw new Error("Missing `flows` array at the JSON root.");
	}
	const cleaned: Array<{ id: string; name: string; routes: string[] }> = [];
	for (const [idx, f] of flows.entries()) {
		if (!f || typeof f !== "object") {
			throw new Error(`flows[${idx}] is not an object.`);
		}
		const obj = f as Record<string, unknown>;
		const name = typeof obj.name === "string" ? obj.name.trim() : "";
		if (!name) throw new Error(`flows[${idx}].name is required.`);
		const id = typeof obj.id === "string" ? obj.id.trim() : "";
		const routes = Array.isArray(obj.routes)
			? obj.routes.filter((r): r is string => typeof r === "string" && r.length > 0)
			: [];
		cleaned.push({ id, name, routes });
	}
	return { flows: cleaned };
}

async function doRemoveProject(slug: string, name?: string): Promise<void> {
	const ok = await showConfirm({
		title: `Remove "${name || slug}"?`,
		body: `Archives the project on the gallery (90-day grace period) and drops it from Capture's local registry. Snaps stay safe — restore from the gallery's Archived list before the grace window ends. After 90 days, everything is permanently deleted. Doesn't touch your customer repo.`,
		confirmLabel: "Archive project",
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

/**
 * Enable / disable full-page capture for a single screen. Calls the
 * snap-bridge wrap-screen CLI in the customer repo via the bun side.
 * After a successful wrap the next Snap on this route will full-page
 * by default (bridge view-shot path). Expo's Metro hot-reload picks
 * up the wrapped file automatically.
 */
async function doToggleFullPage(
	snap: RnSnapInfo,
	mode: "wrap" | "unwrap",
): Promise<void> {
	const slug = snap.projectId;
	if (!slug) return;
	const verb = mode === "wrap" ? "Enable" : "Disable";
	log(`${verb} long-page capture for ${snap.route}…`, "info");
	try {
		const r = await req.wrapScreenForFullPage({
			slug,
			route: snap.route,
			mode,
		});
		if (!r.ok) {
			log(`${verb} failed: ${r.error}`, "error");
			return;
		}
		log(
			mode === "wrap"
				? `✓ Long-page capture enabled for ${snap.route} — Cmd+R the iOS sim, then re-snap.`
				: `✓ Long-page capture disabled for ${snap.route}.`,
			"success",
		);
		// Surface CLI hints (backup path, manual fix instructions).
		for (const line of r.output.split("\n").slice(-4)) {
			const t = line.trim();
			if (t.startsWith("Backup") || t.startsWith("If this") || t.startsWith("Manual fix")) {
				log(`  ${t}`, "info");
			}
		}
	} catch (err) {
		log(`${verb} failed: ${(err as Error).message}`, "error");
	}
}

/**
 * Delete a single past version of a snap from inside the lightbox version
 * scrubber. Confirms before destructive — the latest version's removal
 * promotes versions[0] to current, the only-version case wipes the snap
 * entirely, hence the slightly-different copy in each branch.
 */
async function doDeleteSnapVersion(
	snap: RnSnapInfo,
	versionIdx: number,
	totalVersions: number,
): Promise<void> {
	const isLatest = versionIdx === 0;
	const isLast = totalVersions <= 1;
	const versionLabel = isLatest
		? "latest version"
		: `v${totalVersions - versionIdx}`;
	const body = isLast
		? `This is the only version captured — deleting it removes the entire snap card.`
		: isLatest
			? `Removes the current image; the previous capture (v${totalVersions - 1}) becomes the new latest.`
			: `Removes only this older capture. The latest stays.`;
	const ok = await showConfirm({
		title: `Delete ${versionLabel} of ${snap.route || "/"}?`,
		body,
		confirmLabel: isLast ? "Delete snap" : "Delete version",
		danger: true,
	});
	if (!ok) return;
	try {
		const r = await req.deleteSnapVersion({
			sessionId: snap.sessionId,
			sequence: snap.sequence,
			versionIdx,
		});
		if (!r.ok) {
			log(`Delete version failed: ${r.error}`, "error");
			return;
		}
		// Resync from the server — the manifest now reflects the deletion.
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
		if (r.outcome === "deleted") {
			log(`✗ Deleted #${snap.sequence} ${snap.route} (last version)`, "info");
			closeSnapLightbox();
		} else if (r.outcome === "promoted") {
			log(`✓ Promoted previous version of ${snap.route}`, "success");
		} else {
			log(`✓ Deleted ${versionLabel} of ${snap.route}`, "success");
		}
	} catch (err) {
		log(`Delete version failed: ${(err as Error).message}`, "error");
	}
}

/**
 * Pull frames + flows from the gallery for the current project. Imports
 * any frames we don't already have as remote-only snaps (no PNG download)
 * — the bezel renders straight from the Supabase URL until they're
 * re-snapped locally.
 *
 * Idempotent: re-running brings down only what's new.
 */
async function doSyncFromGallery(): Promise<void> {
	const cur = state.get().rn;
	const slug = cur.selectedProjectSlug;
	if (!slug) {
		log("Open a project before syncing from gallery.", "warn");
		return;
	}
	log(`Syncing from gallery…`, "info");
	try {
		const r = await req.syncFromGallery({ projectSlug: slug });
		if (!r.ok) {
			log(`Sync failed: ${r.error}`, "error");
			return;
		}
		if (r.framesAdded === 0 && r.flowsAdded === 0 && r.flowsRemoved === 0) {
			log("Already in sync — no new frames.", "info");
		} else {
			const parts: string[] = [];
			if (r.framesAdded > 0)
				parts.push(`${r.framesAdded} frame${r.framesAdded === 1 ? "" : "s"}`);
			if (r.flowsAdded > 0)
				parts.push(`${r.flowsAdded} flow${r.flowsAdded === 1 ? "" : "s"} added`);
			if (r.flowsRemoved > 0)
				parts.push(`${r.flowsRemoved} stale flow${r.flowsRemoved === 1 ? "" : "s"} pruned`);
			log(`Sync: ${parts.join(", ")}.`, "success");
		}
		// Pull a fresh status so the UI re-renders with the new snaps.
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
		log(`Sync failed: ${(err as Error).message}`, "error");
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
		// Retry loop: showPushSummary can return "retry", which re-runs
		// pushAll without rebuilding the dialog or re-asking for the
		// message. Cap retries at 3 so a permanent failure doesn't trap
		// the user — they can always close + manually retry.
		let attempt = 0;
		while (attempt < 3) {
			attempt += 1;
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
			// Refresh status so cards pick up their new uploaded badges
			// before the modal renders (the modal text references counts,
			// not card state, but the underlying grid should be current).
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
			const choice = await showPushSummary({
				synced: r.synced,
				failed: r.failed,
				errors: r.errors,
				skipped: r.skipped,
			});
			if (choice !== "retry") break;
		}
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
 * Post-push summary modal. Replaces the toast-only feedback the user got
 * before: counts are prominent, errors and skipped frames live in their
 * own labeled lists, and a `Try again` button is offered whenever any
 * failure happened. On clean pushes (no failures, no skipped) the modal
 * is suppressed when the user has ticked "Don't show again on clean
 * pushes" — that preference persists in localStorage.
 *
 * Resolves with `"retry"` if the user picked the Try again button,
 * otherwise `"close"`.
 */
const PUSH_SUMMARY_HIDE_CLEAN_KEY = "capture:push-summary:hide-clean";

function showPushSummary(opts: {
	synced: number;
	failed: number;
	errors: string[];
	skipped: Array<{ projectId: string; image: string; reason: string; bytes?: number }>;
}): Promise<"retry" | "close"> {
	const isClean = opts.failed === 0 && opts.skipped.length === 0;
	const hideClean =
		localStorage.getItem(PUSH_SUMMARY_HIDE_CLEAN_KEY) === "1";
	// Clean push + user opted out → no modal, immediate close.
	if (isClean && hideClean) return Promise.resolve("close");

	return new Promise((resolve) => {
		const backdrop = document.createElement("div");
		backdrop.className = "rn-confirm-backdrop";
		const dlg = document.createElement("div");
		dlg.className = "rn-confirm-dialog rn-push-summary-dialog";

		const title = document.createElement("h3");
		title.className = "rn-confirm-title";
		title.textContent = isClean ? "Push complete" : "Push finished with issues";

		// Counts header: "12 pushed · 1 failed · 2 skipped"
		const counts = document.createElement("p");
		counts.className = "rn-confirm-body";
		const parts: string[] = [];
		parts.push(
			`${opts.synced} pushed`,
		);
		if (opts.failed > 0) parts.push(`${opts.failed} failed`);
		if (opts.skipped.length > 0) parts.push(`${opts.skipped.length} skipped`);
		counts.textContent = parts.join(" · ");

		dlg.append(title, counts);

		// Errors block — collapsible, shown when present.
		if (opts.errors.length > 0) {
			const details = document.createElement("details");
			details.className = "rn-push-summary-details";
			details.open = true;
			const summary = document.createElement("summary");
			summary.textContent = `Errors (${opts.errors.length})`;
			details.appendChild(summary);
			const list = document.createElement("ul");
			list.className = "rn-push-summary-list";
			for (const e of opts.errors.slice(0, 10)) {
				const li = document.createElement("li");
				li.textContent = e;
				list.appendChild(li);
			}
			if (opts.errors.length > 10) {
				const li = document.createElement("li");
				li.className = "rn-push-summary-more";
				li.textContent = `…and ${opts.errors.length - 10} more`;
				list.appendChild(li);
			}
			details.appendChild(list);
			dlg.appendChild(details);
		}

		// Skipped block — same pattern, different label so users can tell
		// "we tried but the server rejected" (errors) from "we never tried
		// because the local file was missing" (skipped).
		if (opts.skipped.length > 0) {
			const details = document.createElement("details");
			details.className = "rn-push-summary-details";
			details.open = opts.errors.length === 0; // open if it's the only issue
			const summary = document.createElement("summary");
			// Tally reasons so the header tells the user what kind of skip
			// dominates without scrolling through the per-frame list.
			const tooLarge = opts.skipped.filter((s) => s.reason === "too-large").length;
			const missing = opts.skipped.filter((s) => s.reason === "missing-file").length;
			const readErr = opts.skipped.filter((s) => s.reason === "read-error").length;
			const tagParts: string[] = [];
			if (tooLarge) tagParts.push(`${tooLarge} too large`);
			if (missing) tagParts.push(`${missing} missing`);
			if (readErr) tagParts.push(`${readErr} read errors`);
			summary.textContent = `Skipped (${opts.skipped.length}) — ${tagParts.join(", ")}`;
			details.appendChild(summary);
			if (tooLarge > 0) {
				const hint = document.createElement("p");
				hint.className = "rn-push-summary-hint";
				hint.textContent =
					"Vercel rejects request bodies over 4.5 MB. Re-snap these as viewport (instead of full page), or shorten the page before snapping.";
				details.appendChild(hint);
			}
			const list = document.createElement("ul");
			list.className = "rn-push-summary-list";
			for (const s of opts.skipped.slice(0, 10)) {
				const li = document.createElement("li");
				const sizeNote =
					s.reason === "too-large" && s.bytes
						? ` (${(s.bytes / 1_000_000).toFixed(1)} MB)`
						: "";
				li.textContent = `${s.image} — ${s.reason}${sizeNote}`;
				list.appendChild(li);
			}
			if (opts.skipped.length > 10) {
				const li = document.createElement("li");
				li.className = "rn-push-summary-more";
				li.textContent = `…and ${opts.skipped.length - 10} more`;
				list.appendChild(li);
			}
			details.appendChild(list);
			dlg.appendChild(details);
		}

		// "Don't show again on clean pushes" — only meaningful when
		// THIS push was clean. Keeps power users from confirm-fatigue
		// without hiding the modal on partial failures.
		if (isClean) {
			const optOutWrap = document.createElement("label");
			optOutWrap.className = "rn-push-summary-optout";
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.checked = hideClean;
			cb.addEventListener("change", () => {
				localStorage.setItem(
					PUSH_SUMMARY_HIDE_CLEAN_KEY,
					cb.checked ? "1" : "0",
				);
			});
			const labelText = document.createElement("span");
			labelText.textContent = "Don't show again on clean pushes";
			optOutWrap.append(cb, labelText);
			dlg.appendChild(optOutWrap);
		}

		const actions = document.createElement("div");
		actions.className = "rn-confirm-actions";
		let retryBtn: HTMLButtonElement | null = null;
		if (opts.failed > 0) {
			retryBtn = document.createElement("button");
			retryBtn.className = "btn btn-ghost";
			retryBtn.textContent = "Try again";
			actions.appendChild(retryBtn);
		}
		const closeBtn = document.createElement("button");
		closeBtn.className = "btn btn-primary";
		closeBtn.textContent = "Close";
		actions.appendChild(closeBtn);
		dlg.appendChild(actions);

		backdrop.appendChild(dlg);
		document.body.appendChild(backdrop);

		const close = (result: "retry" | "close") => {
			backdrop.remove();
			document.removeEventListener("keydown", onKey);
			resolve(result);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" || e.key === "Enter") close("close");
		};
		closeBtn.addEventListener("click", () => close("close"));
		retryBtn?.addEventListener("click", () => close("retry"));
		backdrop.addEventListener("click", (e) => {
			if (e.target === backdrop) close("close");
		});
		document.addEventListener("keydown", onKey);
		queueMicrotask(() => closeBtn.focus());
	});
}


/**
 * Two-mode picker for the Refresh button. "Add missing routes" runs
 * snap-flows-scan --merge (additive, safe). "Regenerate" rewrites the
 * file from scratch, discarding any improver-refined or hand-edited
 * grouping. Resolves with `null` if the user cancels.
 */
function showRefreshModePicker(
	label: string,
): Promise<"merge" | "regenerate" | null> {
	return new Promise((resolve) => {
		const backdrop = document.createElement("div");
		backdrop.className = "rn-confirm-backdrop";
		const dlg = document.createElement("div");
		dlg.className = "rn-confirm-dialog rn-refresh-dialog";

		const title = document.createElement("h3");
		title.className = "rn-confirm-title";
		title.textContent = `Refresh flows for ${label}`;

		const intro = document.createElement("p");
		intro.className = "rn-confirm-body";
		intro.textContent =
			"Pick how to update snap-flows.ts in the customer repo. The default is non-destructive.";

		const opts = document.createElement("div");
		opts.className = "rn-refresh-options";

		const mkOption = (
			value: "merge" | "regenerate",
			heading: string,
			detail: string,
			danger: boolean,
			recommended: boolean,
		): HTMLButtonElement => {
			const b = document.createElement("button");
			b.type = "button";
			b.className = `rn-refresh-option${danger ? " is-danger" : ""}${recommended ? " is-recommended" : ""}`;
			const h = document.createElement("div");
			h.className = "rn-refresh-option-head";
			const hLabel = document.createElement("span");
			hLabel.className = "rn-refresh-option-title";
			hLabel.textContent = heading;
			h.appendChild(hLabel);
			if (recommended) {
				const tag = document.createElement("span");
				tag.className = "rn-refresh-option-tag";
				tag.textContent = "Recommended";
				h.appendChild(tag);
			}
			const d = document.createElement("p");
			d.className = "rn-refresh-option-body";
			d.textContent = detail;
			b.append(h, d);
			b.addEventListener("click", () => close(value));
			return b;
		};

		const mergeBtn = mkOption(
			"merge",
			"Add missing routes",
			"Scans app/ and adds any new routes under a “Recently added” bucket. Curated user-journey grouping stays intact.",
			false,
			true,
		);
		const regenBtn = mkOption(
			"regenerate",
			"Regenerate from scratch",
			"Rebuilds snap-flows.ts with the path-based heuristic. Replaces any improver-refined or hand-edited grouping.",
			true,
			false,
		);
		opts.append(mergeBtn, regenBtn);

		const actions = document.createElement("div");
		actions.className = "rn-confirm-actions";
		const cancelBtn = document.createElement("button");
		cancelBtn.className = "btn btn-ghost";
		cancelBtn.textContent = "Cancel";
		actions.appendChild(cancelBtn);

		dlg.append(title, intro, opts, actions);
		backdrop.appendChild(dlg);
		document.body.appendChild(backdrop);

		const close = (result: "merge" | "regenerate" | null): void => {
			backdrop.remove();
			document.removeEventListener("keydown", onKey);
			resolve(result);
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") close(null);
			else if (e.key === "Enter") close("merge");
		};
		cancelBtn.addEventListener("click", () => close(null));
		backdrop.addEventListener("click", (e) => {
			if (e.target === backdrop) close(null);
		});
		document.addEventListener("keydown", onKey);
		queueMicrotask(() => mergeBtn.focus());
	});
}

/**
 * Doctor panel — per-project health audit modal. Lists the checks
 * returned by `runDoctor` with status icons, a detail line per check,
 * and a Fix button when an auto-action is available.
 *
/**
 * Per-project settings sheet. Shows the gallery URL, masked project
 * token, RN workspace path, last push timestamp, and current bridge
 * connection — all the values that used to live invisibly in
 * localStorage / the registry JSON. No write actions in v1 (re-add
 * via "+ Add" if creds need to change); this is a transparency surface
 * so a designer can confirm "yes, I'm pushing to the right place."
 */
function openProjectSettings(slug: string): void {
	const s = state.get();
	const proj = s.rn.registry.find((p) => p.slug === slug);
	if (!proj) {
		log(`No project with slug "${slug}"`, "error");
		return;
	}
	const projectSnaps = s.rn.snaps.filter((n) => n.projectId === slug);
	const lastPushIso =
		projectSnaps
			.map((n) => n.uploaded?.uploadedAt ?? "")
			.filter((v) => v.length > 0)
			.sort()
			.pop() ?? "";
	const bridgeConnected = s.rn.projects.includes(slug);
	const maskToken = (t: string): string => {
		if (!t) return "(not set)";
		if (t.length <= 12) return "•".repeat(t.length);
		return `${t.slice(0, 6)}${"•".repeat(t.length - 10)}${t.slice(-4)}`;
	};
	const fmtTs = (iso: string): string => {
		if (!iso) return "Never";
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString();
	};

	const backdrop = document.createElement("div");
	backdrop.className = "rn-confirm-backdrop";
	const dlg = document.createElement("div");
	dlg.className = "rn-confirm-dialog rn-settings-dialog";

	const title = document.createElement("h3");
	title.className = "rn-confirm-title";
	title.textContent = `${proj.name ?? proj.slug} — settings`;

	const rows: Array<{ label: string; value: string; mono?: boolean }> = [
		{ label: "Slug", value: proj.slug, mono: true },
		{ label: "Platform", value: proj.platform },
		{ label: "Gallery upload URL", value: proj.uploadUrl, mono: true },
		{ label: "Project token", value: maskToken(proj.projectToken), mono: true },
		...(proj.baseUrl
			? [{ label: "Web base URL", value: proj.baseUrl, mono: true }]
			: []),
		...(proj.repoPath
			? [{ label: "Repo path", value: proj.repoPath, mono: true }]
			: []),
		...(proj.rnAppDir
			? [{ label: "RN app dir", value: proj.rnAppDir, mono: true }]
			: []),
		{ label: "Registered", value: fmtTs(proj.registeredAt) },
		{ label: "Last push", value: fmtTs(lastPushIso) },
		{
			label: "Bridge",
			value: bridgeConnected ? "Connected" : "Offline",
		},
	];

	const grid = document.createElement("div");
	grid.className = "rn-settings-grid";
	for (const r of rows) {
		const rowLabel = document.createElement("div");
		rowLabel.className = "rn-settings-label";
		rowLabel.textContent = r.label;
		const rowValue = document.createElement("div");
		rowValue.className = r.mono
			? "rn-settings-value rn-settings-value-mono"
			: "rn-settings-value";
		rowValue.textContent = r.value;
		grid.append(rowLabel, rowValue);
	}

	const note = document.createElement("p");
	note.className = "rn-confirm-body rn-settings-note";
	note.textContent =
		'To change the gallery URL, token, or repo path, re-onboard via "+ Add" with the same slug — Capture will detect the existing project and update its registry entry.';

	const actions = document.createElement("div");
	actions.className = "rn-confirm-actions";
	const closeBtn = document.createElement("button");
	closeBtn.className = "btn btn-primary";
	closeBtn.textContent = "Close";
	actions.appendChild(closeBtn);

	dlg.append(title, grid, note, actions);
	backdrop.appendChild(dlg);
	document.body.appendChild(backdrop);

	const close = () => {
		backdrop.remove();
		document.removeEventListener("keydown", onKey);
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape" || e.key === "Enter") close();
	};
	closeBtn.addEventListener("click", close);
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) close();
	});
	document.addEventListener("keydown", onKey);
	queueMicrotask(() => closeBtn.focus());
}

/**
 * Opening: from the dashboard card's stethoscope button. Doctor RPC
 * fires immediately so the user sees status by the time the modal is
 * fully rendered.
 *
 * Auto-fix: each Fix button calls `req.doctorAutoFix({slug, kind})`.
 * On success we re-run the audit so the row's status flips to "ok".
 */
async function openDoctorPanel(slug: string, name?: string): Promise<void> {
	const backdrop = document.createElement("div");
	backdrop.className = "rn-confirm-backdrop";
	const dlg = document.createElement("div");
	dlg.className = "rn-confirm-dialog rn-doctor-dialog";

	const title = document.createElement("h3");
	title.className = "rn-confirm-title";
	title.textContent = `Doctor — ${name || slug}`;
	const sub = document.createElement("p");
	sub.className = "rn-confirm-body";
	sub.textContent = "Per-project health check. Findings + auto-fixes.";

	const list = ce("ul", "rn-doctor-checks");
	const summary = ce("div", "rn-doctor-summary with-spin-prefix");
	summary.append(icon("loader", { size: 14 }), document.createTextNode("Running…"));

	const actions = document.createElement("div");
	actions.className = "rn-confirm-actions";
	const closeBtn = document.createElement("button");
	closeBtn.className = "btn btn-primary";
	closeBtn.textContent = "Close";
	const refreshBtn = document.createElement("button");
	refreshBtn.className = "btn btn-ghost";
	setBtnIcon(refreshBtn, "refresh-cw", "Re-run");
	actions.append(refreshBtn, closeBtn);

	dlg.append(title, sub, summary, list, actions);
	backdrop.appendChild(dlg);
	document.body.appendChild(backdrop);

	const close = () => {
		backdrop.remove();
		document.removeEventListener("keydown", onKey);
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape") close();
	};
	closeBtn.addEventListener("click", close);
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) close();
	});
	document.addEventListener("keydown", onKey);
	refreshBtn.addEventListener("click", () => void runAudit());

	const runAudit = async (): Promise<void> => {
		summary.classList.add("with-spin-prefix");
		summary.replaceChildren(
			icon("loader", { size: 14 }),
			document.createTextNode("Running…"),
		);
		summary.removeAttribute("data-severity");
		list.replaceChildren();
		refreshBtn.classList.add("is-busy");
		refreshBtn.disabled = true;
		setBtnIcon(refreshBtn, "loader", "Re-run");
		try {
			const r = (await req.runDoctor({ slug })) as
				| {
						ok: true;
						report: {
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
										| "manual";
									label: string;
									target?: string;
								};
							}>;
							summary: { ok: number; warn: number; error: number };
						};
				  }
				| { ok: false; error: string };
			summary.classList.remove("with-spin-prefix");
			if (!r.ok) {
				summary.textContent = `Audit failed: ${r.error}`;
				return;
			}
			const s = r.report.summary;
			summary.textContent = `${s.ok} ok · ${s.warn} warn · ${s.error} error`;
			summary.dataset.severity =
				s.error > 0 ? "error" : s.warn > 0 ? "warn" : "ok";
			for (const c of r.report.checks) {
				const li = ce("li", `rn-doctor-check rn-doctor-check-${c.status}`);
				const head = ce("div", "rn-doctor-check-head");
				const dot = ce("span", `rn-doctor-check-dot ${c.status}`);
				const lbl = ce("span", "rn-doctor-check-label");
				lbl.textContent = c.label;
				head.append(dot, lbl);
				const det = ce("p", "rn-doctor-check-detail");
				det.textContent = c.detail;
				li.append(head, det);
				if (c.fixAction) {
					const fix = ce("button", "rn-doctor-check-fix");
					fix.type = "button";
					fix.textContent = c.fixAction.label;
					fix.addEventListener("click", () =>
						void runFix(c.fixAction!.kind, c.fixAction!.target, fix),
					);
					li.appendChild(fix);
				}
				list.appendChild(li);
			}
		} catch (err) {
			summary.classList.remove("with-spin-prefix");
			summary.textContent = `Audit error: ${(err as Error).message}`;
		} finally {
			refreshBtn.classList.remove("is-busy");
			refreshBtn.disabled = false;
			setBtnIcon(refreshBtn, "refresh-cw", "Re-run");
		}
	};

	const runFix = async (
		kind:
			| "bump-snap-bridge"
			| "regenerate-flows"
			| "merge-flows"
			| "install-view-shot"
			| "open-layout"
			| "manual",
		target: string | undefined,
		btn: HTMLButtonElement,
	): Promise<void> => {
		if (kind === "open-layout" && target) {
			log(`Layout file at ${target} — open it in your editor to fix manually.`, "info");
			return;
		}
		if (kind === "manual") return;
		const originalLabel = btn.textContent ?? "Fix";
		btn.disabled = true;
		btn.classList.add("is-busy");
		btn.replaceChildren(
			icon("loader", { size: 12 }),
			document.createTextNode("Working…"),
		);
		try {
			const r = (await req.doctorAutoFix({ slug, kind })) as
				| { ok: true; output: string }
				| { ok: false; error: string };
			if (!r.ok) {
				log(`Fix failed: ${r.error}`, "error");
				btn.classList.remove("is-busy");
				btn.replaceChildren(document.createTextNode("Failed — retry"));
				btn.disabled = false;
				return;
			}
			// Prefer the server's human-friendly output ("Opening Simulator.
			// Your last-used device should boot…") over the generic "Fix
			// applied" — for the runtime-state fixes (boot-simulator,
			// launch-expo, reconnect-bridge) the output is the entire UX.
			const msg =
				typeof r.output === "string" && r.output.trim().length > 0
					? r.output.trim()
					: `✓ Fix "${kind}" applied`;
			log(msg, "success");
			// runAudit will rebuild the list, replacing this btn entirely.
			void runAudit();
		} catch (err) {
			log(`Fix crashed: ${(err as Error).message}`, "error");
			btn.classList.remove("is-busy");
			btn.replaceChildren(document.createTextNode(originalLabel));
			btn.disabled = false;
		}
	};

	void runAudit();
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

async function refreshProjectRegistry(): Promise<void> {
	try {
		const r = await req.listAssignedProjects({});
		if (!r.ok) {
			// Session expired / revoked → drop to the sign-in screen.
			if (r.needsSignIn) {
				state.set((cur) => ({
					...cur,
					session: null,
					rn: { ...cur.rn, registry: [], selectedProjectSlug: null },
				}));
			}
			return;
		}
		state.set((cur) => ({
			...cur,
			session: cur.session
				? {
						...cur.session,
						isOwner: r.user.isOwner,
						role: r.user.role,
						email: r.user.email,
					}
				: cur.session,
			rn: { ...cur.rn, registry: r.projects },
		}));
	} catch {
		// ignore — keep the last-known registry so a transient network blip
		// doesn't blank the dashboard.
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

	// Topbar (#gtb-context + action buttons) carries project name + bridge
	// status; the dashboard handles project switching. applyRnState only
	// owns the in-project view (flow tree + snap grid) now.

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
	const allNonEmptyGroups = groups.filter(
		(g) => g.snaps.length > 0 || g.flow.id !== "__unassigned__",
	);
	// Hide empty declared flows by default — snap-flows.ts often declares
	// 20-40 screens, most of which haven't been captured yet, and the
	// noise drowns out the flows that have actual content. Toggle lives
	// next to the "+ New flow" button; preference persists per project.
	//
	// User-created flows always show even when empty — clicking "+ New
	// flow" should produce a visible row to rename + populate, not
	// silently disappear. We treat a flow with a `declaredId` as
	// bridge-declared (eligible for hiding); anything without one came
	// from the user or from an auto-flow that already has snaps.
	const showEmptyKey = `capture:show-empty-flows:${r.selectedProjectSlug ?? "_all"}`;
	const showEmpty = readLocal(showEmptyKey) === "1";
	const visibleGroups = showEmpty
		? allNonEmptyGroups
		: allNonEmptyGroups.filter(
				(g) => g.snaps.length > 0 || !g.flow.declaredId,
			);
	const totalFrames = filteredSnaps.length;
	const hiddenEmptyCount = allNonEmptyGroups.length - visibleGroups.length;

	renderSidebarFlowTree(refs.flowsList, visibleGroups, refs.previewBox);

	const overview = ce("div", "rn-overview");
	const overviewTitle = ce("h2", "rn-overview-title");
	overviewTitle.textContent = "All flows";
	const overviewSub = ce("p", "rn-overview-sub");
	const subText = `${visibleGroups.length} flow${visibleGroups.length === 1 ? "" : "s"} · ${totalFrames} frame${totalFrames === 1 ? "" : "s"}`;
	overviewSub.textContent = hiddenEmptyCount > 0
		? `${subText} · ${hiddenEmptyCount} empty hidden`
		: subText;
	const newFlowBtn = ce("button", "btn btn-secondary btn-sm rn-new-flow-btn");
	newFlowBtn.textContent = "+ New flow";
	newFlowBtn.title = "Create an empty flow";
	newFlowBtn.addEventListener("click", () => void doCreateFlow());
	// Toggle for empty flows. Only useful when there are some to hide;
	// suppress otherwise to keep the toolbar minimal.
	const overviewActions = ce("div", "rn-overview-actions");
	if (hiddenEmptyCount > 0 || showEmpty) {
		const toggleEmptyBtn = ce("button", "btn btn-ghost btn-sm");
		toggleEmptyBtn.type = "button";
		toggleEmptyBtn.textContent = showEmpty
			? "Hide empty"
			: `Show empty (${hiddenEmptyCount})`;
		toggleEmptyBtn.title = showEmpty
			? "Hide declared flows that have no captures yet"
			: "Show declared flows that have no captures yet";
		toggleEmptyBtn.addEventListener("click", () => {
			writeLocal(showEmptyKey, showEmpty ? "0" : "1");
			applyRnState(state.get());
		});
		overviewActions.appendChild(toggleEmptyBtn);
	}
	overviewActions.appendChild(newFlowBtn);
	const overviewMeta = ce("div", "rn-overview-meta");
	overviewMeta.append(overviewTitle, overviewSub);
	overview.append(overviewMeta, overviewActions);
	refs.previewBox.appendChild(overview);

	if (totalFrames === 0 && visibleGroups.length === 0) {
		const empty = ce("div", "rn-grid-empty");
		const emptyIcon = ce("div", "rn-grid-empty-icon");
		emptyIcon.appendChild(icon("smartphone", { size: 32, strokeWidth: 1.5 }));
		const emptyTitle = ce("div", "rn-grid-empty-title");
		emptyTitle.textContent = "No snaps in this project yet";
		const emptyHint = ce("div", "rn-grid-empty-hint");
		emptyHint.textContent = UI.rn.snap.emptyHint;
		empty.append(emptyIcon, emptyTitle, emptyHint);
		refs.previewBox.appendChild(empty);
		return;
	}

	const renderFlowSection = (
		group: RnFlowGroup,
		container: HTMLElement,
		isSub: boolean,
	): void => {
		const flowId = group.flow.id;
		const parentFlowId = group.flow.parentFlowId;
		const section = ce("section", isSub ? "rn-flow-section rn-flow-sub" : "rn-flow-section");
		section.dataset.flowId = flowId;
		section.dataset.parentFlowId = parentFlowId ?? "";
		// Section-level drag/drop for flow reordering. The grab handle in
		// the flow head sets `flowDragSrcId` on dragstart; this section
		// listens for dragover to show the drop indicator and for drop to
		// commit the new order. Sub-flow reorder is sibling-scoped — drop
		// only fires when source and target share the same parentFlowId,
		// so a sub-flow can't accidentally be promoted to top-level or
		// adopted by another parent via drag.
		if (flowId !== "__unassigned__") {
			section.addEventListener("dragover", (ev) => {
				// Snap-card drag (dragSrc set) — let the section be a fallback
				// drop target so the user can release ANYWHERE in the section,
				// not only on the narrow strip band. Drop indicator stays on
				// the strip/li level so visual feedback isn't noisy.
				if (dragSrc) {
					ev.preventDefault();
					if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
					return;
				}
				if (!flowDragSrcId || flowDragSrcId === flowId) return;
				if (flowDragSrcParent !== (parentFlowId ?? null)) return; // siblings only
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
				// Snap-card fallback drop: if a strip/li deeper in the tree
				// already handled the drop, its drag end will have cleared
				// dragSrc by the time the bubble reaches here. So we only
				// commit the move when dragSrc is still set — meaning no
				// inner target accepted, but the cursor is over this
				// section's body.
				if (dragSrc) {
					ev.preventDefault();
					if (dragSrc.flowId !== flowId) {
						// Cross-flow move into this section. Append at end —
						// fine-grained ordering is handled by intra-strip drops.
						const destSnaps = group.snaps;
						handleStripDrop(flowId, null, destSnaps);
					}
					return;
				}
				if (!flowDragSrcId || flowDragSrcId === flowId) return;
				if (flowDragSrcParent !== (parentFlowId ?? null)) return;
				ev.preventDefault();
				const above = section.classList.contains("drop-above");
				section.classList.remove("drop-above", "drop-below");
				const orderedIds = reorderSiblings(
					state.get().rn.flows,
					flowDragSrcId,
					flowId,
					above,
				);
				flowDragSrcId = null;
				flowDragSrcParent = null;
				void doReorderFlows(orderedIds);
			});
		}

		const flowHead = ce("div", "rn-flow-head");
		// Grab handle — only it triggers flow drag, so the rest of the head
		// (title, count, delete button) stays clickable without misfires.
		if (flowId !== "__unassigned__") {
			const grabHandle = ce("span", "rn-flow-grab");
			grabHandle.title = isSub
				? "Drag to reorder among sibling sub-flows"
				: "Drag to reorder this flow";
			grabHandle.textContent = "⋮⋮";
			grabHandle.draggable = true;
			grabHandle.addEventListener("dragstart", (ev) => {
				flowDragSrcId = flowId;
				flowDragSrcParent = parentFlowId ?? null;
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
				flowDragSrcParent = null;
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
		// Capture-into-this-flow: split button. Main button = auto-snap
		// (route match in this flow replaces, otherwise appends). Caret =
		// dropdown with "Snap as variant" so the user can force a new card
		// on the same slot — required when capturing long pages or filter
		// states scoped to this flow. Mirrors the global Snap split button.
		if (flowId !== "__unassigned__") {
			const flowSnapGroup = ce("div", "rn-flow-snap-group");
			const flowSnapBtn = ce("button", "btn btn-ghost btn-sm rn-flow-snap rn-flow-snap-main");
			flowSnapBtn.type = "button";
			flowSnapBtn.append(icon("camera", { size: 14 }), document.createTextNode("Capture"));
			flowSnapBtn.title = `Capture current screen into "${group.flow.name}"`;
			flowSnapBtn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				ev.preventDefault();
				void doSnap("auto", { forceFlowId: flowId });
			});
			const flowSnapCaret = ce("button", "btn btn-ghost btn-sm rn-flow-snap-caret");
			flowSnapCaret.type = "button";
			flowSnapCaret.setAttribute("aria-label", "Snap options");
			flowSnapCaret.title = "Snap options (variant capture)";
			flowSnapCaret.appendChild(icon("chevron-down", { size: 12 }));
			flowSnapCaret.addEventListener("click", (ev) => {
				ev.stopPropagation();
				ev.preventDefault();
				openSnapMenu(flowSnapCaret, { forceFlowId: flowId });
			});
			flowSnapGroup.append(flowSnapBtn, flowSnapCaret);
			flowActions.appendChild(flowSnapGroup);
		}
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
			ev.stopPropagation(); // prevent section's fallback drop from re-firing
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
				ev.stopPropagation(); // prevent strip + section fallback re-fire
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

			// "Updated" badge — shown when this slot has new captures the
			// user hasn't viewed yet (re-snap added a version since the
			// last time they opened this card's lightbox). Click clears
			// the badge AND opens the lightbox.
			const versionCount = (snap.versions?.length ?? 0) + 1;
			const seenKey = `prisma:seen:${snap.projectId}:${snap.sessionId}#${snap.sequence}`;
			const seenCount = Number(readLocal(seenKey) || "0") || 0;
			const isUpdated = versionCount > Math.max(seenCount, 1);
			let versionBadge: HTMLSpanElement | null = null;
			if (isUpdated) {
				versionBadge = ce("span", "rn-card-updated");
				versionBadge.title = `Re-snapped — ${versionCount} versions total. Click the card to compare.`;
				versionBadge.textContent = "Updated";
			}

			// Click anywhere on the card opens a lightbox like the web frame page.
			// Also marks this slot's version count as "seen" so the Updated badge
			// fades. The badge will reappear after the next re-snap.
			card.style.cursor = "zoom-in";
			card.addEventListener("click", (ev) => {
				const target = ev.target as HTMLElement;
				if (target.closest(".rn-card-delete")) return;
				if (target.closest(".rn-card-name")) return;
				// Lightbox would also fail to load — skip the click entirely.
				if (card.classList.contains("rn-card-missing")) return;
				writeLocal(seenKey, String(versionCount));
				if (versionBadge && versionBadge.isConnected) {
					versionBadge.classList.add("is-leaving");
					setTimeout(() => versionBadge?.remove(), 200);
				}
				openSnapLightbox(snap, group.snaps);
			});

			const bezel = ce("div", "rn-bezel");
			const bezelScreen = ce("div", "rn-bezel-screen");
			const img = ce("img", "rn-bezel-img");
			img.src = snapImageSrc(snap);
			img.alt = `${snap.route} #${snap.sequence}`;
			img.loading = "lazy";
			// When the PNG behind this snap is missing on disk (stale record
			// from a deleted/moved file), hide the broken-image glyph and
			// stamp a clear "missing" hint on the bezel. The card's × delete
			// button still works to prune the record. Card click is disabled
			// for missing snaps since the lightbox would also be broken.
			img.addEventListener("error", () => {
				img.style.display = "none";
				card.classList.add("rn-card-missing");
				card.title = "Screenshot file missing on disk — click × to remove this stale snap";
				card.style.cursor = "default";
				bezelScreen.style.display = "flex";
				bezelScreen.style.alignItems = "center";
				bezelScreen.style.justifyContent = "center";
				bezelScreen.style.flexDirection = "column";
				bezelScreen.style.gap = "6px";
				bezelScreen.style.color = "rgba(255,255,255,0.6)";
				bezelScreen.style.textAlign = "center";
				bezelScreen.style.padding = "16px";
				const icon = ce("div");
				icon.textContent = "⚠";
				icon.style.fontSize = "28px";
				icon.style.lineHeight = "1";
				icon.style.color = "rgba(255,180,90,0.85)";
				const label = ce("div");
				label.textContent = "File missing";
				label.style.fontSize = "12px";
				label.style.fontWeight = "600";
				label.style.letterSpacing = "0.04em";
				const sub = ce("div");
				sub.textContent = "Click × to remove";
				sub.style.fontSize = "10px";
				sub.style.opacity = "0.7";
				bezelScreen.append(icon, label, sub);
			});
			bezelScreen.appendChild(img);
			const bezelLight = ce("img", "rn-bezel-frame rn-bezel-frame-light");
			bezelLight.src = "iphone-17.png";
			bezelLight.alt = "";
			const bezelDark = ce("img", "rn-bezel-frame rn-bezel-frame-dark");
			bezelDark.src = "iphone-17-dark.png";
			bezelDark.alt = "";
			bezel.append(bezelScreen, bezelLight, bezelDark);
			attachBezelSizing(img, bezel, bezelScreen, [bezelLight, bezelDark]);

			const cardLabel = ce("div", "rn-card-label");
			const cardName = ce("p", "rn-card-name");
			const currentSnapLabel = snap.displayName || snap.route || "/";
			cardName.textContent = currentSnapLabel;
			cardName.contentEditable = "plaintext-only";
			cardName.spellcheck = false;
			cardName.title = "Click to rename — Enter saves, Esc cancels";
			cardName.draggable = false;
			// Click bubbles to the card (opens lightbox) and dragstart would
			// be hijacked by the parent — guard against both.
			cardName.addEventListener("pointerdown", (ev) => ev.stopPropagation());
			cardName.addEventListener("dragstart", (ev) => ev.preventDefault());
			cardName.addEventListener("click", (ev) => ev.stopPropagation());
			cardName.addEventListener("focus", () => {
				cardName.classList.add("editing");
				const sel = window.getSelection();
				if (sel) {
					const range = document.createRange();
					range.selectNodeContents(cardName);
					sel.removeAllRanges();
					sel.addRange(range);
				}
			});
			cardName.addEventListener("blur", () => {
				cardName.classList.remove("editing");
				const next = cardName.textContent?.trim() ?? "";
				if (next === currentSnapLabel) return;
				void doRenameSnap(snap.sessionId, snap.sequence, next);
			});
			cardName.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") {
					ev.preventDefault();
					cardName.blur();
				} else if (ev.key === "Escape") {
					ev.preventDefault();
					cardName.textContent = currentSnapLabel;
					cardName.blur();
				}
			});
			const cardSub = ce("p", "rn-card-sub");
			cardSub.textContent = new Date(snap.capturedAt).toLocaleTimeString();
			cardLabel.append(cardName, cardSub);

			if (versionBadge) bezel.appendChild(versionBadge);
			card.append(deleteBtn, bezel, cardLabel);
			li.appendChild(card);

			if (idx < group.snaps.length - 1) {
				const chev = ce("span", "rn-chevron");
				chev.appendChild(icon("chevron-right", { size: 18, strokeWidth: 1.5 }));
				chev.setAttribute("aria-hidden", "true");
				li.appendChild(chev);
			}
			strip.appendChild(li);
		});

		// Placeholders for declared screens that don't have a captured
		// snap yet — gray dashed cards labeled with the expected name.
		// Hidden screens (user soft-deleted them) drop out here.
		const declaredScreens = (group.flow.screens ?? []).filter(
			(s) => !s.hidden,
		);
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
			const deletePlaceholderBtn = ce("button", "rn-card-delete");
			deletePlaceholderBtn.type = "button";
			deletePlaceholderBtn.title = "Hide this placeholder";
			deletePlaceholderBtn.setAttribute("aria-label", "Hide placeholder");
			deletePlaceholderBtn.textContent = "×";
			deletePlaceholderBtn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				ev.preventDefault();
				void doHideScreen(flowId, screen.declaredId);
			});
			const cardLabel = ce("div", "rn-card-label");
			const cardName = ce("p", "rn-card-name");
			const currentScreenLabel = screen.name || screen.route;
			cardName.textContent = currentScreenLabel;
			cardName.contentEditable = "plaintext-only";
			cardName.spellcheck = false;
			cardName.title = "Click to rename — Enter saves, Esc cancels";
			cardName.addEventListener("pointerdown", (ev) => ev.stopPropagation());
			cardName.addEventListener("click", (ev) => ev.stopPropagation());
			cardName.addEventListener("focus", () => {
				cardName.classList.add("editing");
				const sel = window.getSelection();
				if (sel) {
					const range = document.createRange();
					range.selectNodeContents(cardName);
					sel.removeAllRanges();
					sel.addRange(range);
				}
			});
			cardName.addEventListener("blur", () => {
				cardName.classList.remove("editing");
				const next = cardName.textContent?.trim() ?? "";
				if (!next || next === currentScreenLabel) {
					cardName.textContent = currentScreenLabel;
					return;
				}
				void doRenameScreen(flowId, screen.declaredId, next);
			});
			cardName.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") {
					ev.preventDefault();
					cardName.blur();
				} else if (ev.key === "Escape") {
					ev.preventDefault();
					cardName.textContent = currentScreenLabel;
					cardName.blur();
				}
			});
			const cardSub = ce("p", "rn-card-sub");
			cardSub.textContent = screen.route;
			cardLabel.append(cardName, cardSub);
			card.append(deletePlaceholderBtn, bezel, cardLabel);
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

	// "Unseen" = snaps captured since the last time the user clicked into
	// this flow. localStorage stores the snap count as of that click; the
	// badge clears when the user views the flow and re-appears after fresh
	// captures. Recurses so a parent's badge surfaces what's new anywhere
	// underneath — clicking the parent clears the whole subtree.
	const readSeen = (flowId: string): number =>
		Number(readLocal(`prisma:flow-seen:${flowId}`) || "0") || 0;
	const writeSeen = (flowId: string, count: number): void =>
		writeLocal(`prisma:flow-seen:${flowId}`, String(count));
	const ownUnseen = (g: RnFlowGroup): number =>
		Math.max(0, g.snaps.length - readSeen(g.flow.id));
	const countUnseen = (g: RnFlowGroup): number =>
		ownUnseen(g) + g.children.reduce((n, c) => n + countUnseen(c), 0);
	const markSeenRecursive = (g: RnFlowGroup): void => {
		writeSeen(g.flow.id, g.snaps.length);
		for (const c of g.children) markSeenRecursive(c);
	};

	const renderRow = (g: RnFlowGroup, depth: number): void => {
		const flowId = g.flow.id;
		const parentFlowId = g.flow.parentFlowId;
		const row = ce("div", "rn-flow-row");
		row.dataset.targetFlowId = flowId;
		row.dataset.parentFlowId = parentFlowId ?? "";
		row.style.paddingLeft = `${4 + depth * 14}px`;
		row.setAttribute("role", "button");
		row.tabIndex = 0;
		row.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				row.click();
			}
		});

		// Sibling-scoped drag/drop, mirrors the main-area flow section
		// behavior. Same `flowDragSrcId` + `flowDragSrcParent` state, so a
		// reorder triggered from the sidebar is indistinguishable from one
		// in the grid and Both surfaces stay in sync.
		const draggable = flowId !== "__unassigned__";
		if (draggable) {
			row.addEventListener("dragover", (ev) => {
				if (!flowDragSrcId || flowDragSrcId === flowId) return;
				if (flowDragSrcParent !== (parentFlowId ?? null)) return;
				ev.preventDefault();
				if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
				const rect = row.getBoundingClientRect();
				const above = ev.clientY < rect.top + rect.height / 2;
				for (const el of host.querySelectorAll(".drop-above, .drop-below")) {
					if (el !== row) el.classList.remove("drop-above", "drop-below");
				}
				row.classList.toggle("drop-above", above);
				row.classList.toggle("drop-below", !above);
			});
			row.addEventListener("dragleave", (ev) => {
				if (ev.target === row) {
					row.classList.remove("drop-above", "drop-below");
				}
			});
			row.addEventListener("drop", (ev) => {
				if (!flowDragSrcId || flowDragSrcId === flowId) return;
				if (flowDragSrcParent !== (parentFlowId ?? null)) return;
				ev.preventDefault();
				const above = row.classList.contains("drop-above");
				row.classList.remove("drop-above", "drop-below");
				const orderedIds = reorderSiblings(
					state.get().rn.flows,
					flowDragSrcId,
					flowId,
					above,
				);
				flowDragSrcId = null;
				flowDragSrcParent = null;
				void doReorderFlows(orderedIds);
			});
		}

		if (depth > 0) {
			const arrow = ce("span", "rn-flow-arrow");
			arrow.appendChild(icon("corner-down-right", { size: 12 }));
			row.appendChild(arrow);
		}

		// Grab handle is hidden until hover; activates row-level drag without
		// clobbering the click-to-scroll on the rest of the row.
		if (draggable) {
			const grab = ce("span", "rn-flow-row-grab");
			grab.title = parentFlowId
				? "Drag to reorder among sibling sub-flows"
				: "Drag to reorder this flow";
			grab.textContent = "⋮⋮";
			grab.draggable = true;
			grab.addEventListener("dragstart", (ev) => {
				flowDragSrcId = flowId;
				flowDragSrcParent = parentFlowId ?? null;
				row.classList.add("flow-dragging");
				if (ev.dataTransfer) {
					ev.dataTransfer.effectAllowed = "move";
					ev.dataTransfer.setData("text/plain", `flow:${flowId}`);
				}
			});
			grab.addEventListener("dragend", () => {
				row.classList.remove("flow-dragging");
				for (const el of host.querySelectorAll(".drop-above, .drop-below")) {
					el.classList.remove("drop-above", "drop-below");
				}
				flowDragSrcId = null;
				flowDragSrcParent = null;
			});
			row.appendChild(grab);
		}

		const name = ce("span", "rn-flow-name");
		name.textContent = g.flow.name;

		const unseen = countUnseen(g);
		if (unseen > 0) {
			const dot = ce("span", "rn-flow-pending");
			dot.title = `${unseen} new snap${unseen === 1 ? "" : "s"} since you last viewed this flow`;
			dot.textContent = `•${unseen}`;
			row.appendChild(name);
			row.appendChild(dot);
		} else {
			row.appendChild(name);
		}

		const count = ce("span", "rn-flow-count");
		count.textContent = String(countSnaps(g));
		row.append(count);

		// Re-parent on drop: dragging a flow's grab handle onto another row
		// makes the target the new parent. Rejects self + descendant drops
		// so the tree can't loop.
		const isDescendantOf = (
			ancestorId: string,
			candidateId: string,
		): boolean => {
			const flows = state.get().rn.flows;
			let cursor: string | undefined = flows.find(
				(f) => f.id === candidateId,
			)?.parentFlowId;
			while (cursor) {
				if (cursor === ancestorId) return true;
				cursor = flows.find((f) => f.id === cursor)?.parentFlowId;
			}
			return false;
		};
		const isValidReparentTarget = (): boolean => {
			if (!flowDragSrcId) return false;
			if (flowDragSrcId === flowId) return false;
			if (isDescendantOf(flowDragSrcId, flowId)) return false;
			const src = state.get().rn.flows.find((f) => f.id === flowDragSrcId);
			if (src?.parentFlowId === flowId) return false;
			return true;
		};
		const clearOntoStyle = (): void => {
			row.classList.remove("rn-flow-row-onto");
			row.style.outline = "";
			row.style.outlineOffset = "";
			row.style.borderRadius = "";
		};
		row.addEventListener("dragover", (ev) => {
			if (!isValidReparentTarget()) return;
			ev.preventDefault();
			ev.stopPropagation();
			if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
			for (const el of host.querySelectorAll<HTMLElement>(
				".rn-flow-row-onto",
			)) {
				if (el !== row) {
					el.classList.remove("rn-flow-row-onto");
					el.style.outline = "";
					el.style.outlineOffset = "";
					el.style.borderRadius = "";
				}
			}
			row.classList.add("rn-flow-row-onto");
			row.style.outline = "2px solid var(--accent, #4f8cff)";
			row.style.outlineOffset = "-2px";
			row.style.borderRadius = "6px";
		});
		row.addEventListener("dragleave", (ev) => {
			if (ev.target !== row) return;
			clearOntoStyle();
		});
		row.addEventListener("drop", (ev) => {
			if (!isValidReparentTarget()) return;
			ev.preventDefault();
			ev.stopPropagation();
			const src = flowDragSrcId;
			clearOntoStyle();
			flowDragSrcId = null;
			flowDragSrcParent = null;
			if (src) void doReparentFlow(src, flowId);
		});

		row.addEventListener("click", (ev) => {
			// Ignore clicks that originate inside the grab handle so dragstart
			// doesn't also scroll the main area.
			if ((ev.target as HTMLElement | null)?.classList.contains("rn-flow-row-grab")) {
				return;
			}
			const target = scroller.querySelector<HTMLElement>(
				`[data-flow-id="${cssEscape(flowId)}"]`,
			);
			if (!target) return;
			target.scrollIntoView({ behavior: "smooth", block: "start" });
			// Mark this flow + all its descendants as seen, then re-render the
			// sidebar so badges update on the clicked row AND on any ancestor
			// that was only badged because of something underneath.
			markSeenRecursive(g);
			renderSidebarFlowTree(host, groups, scroller);
			const refreshed = host.querySelector<HTMLElement>(
				`.rn-flow-row[data-target-flow-id="${cssEscape(flowId)}"]`,
			);
			refreshed?.classList.add("active");
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

interface IpadBezel {
	src: string;
	/** Screen-cutout aspect (w/h) — matched against the screenshot's ratio. */
	screenAspect: number;
	/** Frame PNG aspect (w/h) — drives the bezel container's aspect-ratio. */
	frameAspect: number;
	/** Screen-cutout inset as a % of the frame, top/right/bottom/left. */
	t: number;
	r: number;
	b: number;
	l: number;
}
// iPad device frames (portrait + landscape), insets measured from each PNG's
// transparent screen cutout. A capture is matched to the closest screenAspect
// so an iPad screenshot gets an iPad frame instead of the iPhone bezel
// (which squeezed 4:3 content into a 9:19.5 phone and clipped it).
const IPAD_BEZELS: IpadBezel[] = [
	{ src: "ipad-mini-portrait", screenAspect: 0.657, frameAspect: 890 / 1275, t: 5.57, r: 8.2, b: 5.57, l: 8.2 },
	{ src: "ipad-11-portrait", screenAspect: 0.689, frameAspect: 940 / 1320, t: 4.17, r: 5.64, b: 4.17, l: 5.64 },
	{ src: "ipad-13-portrait", screenAspect: 0.75, frameAspect: 1150 / 1500, t: 4.13, r: 5.13, b: 4.13, l: 5.13 },
	{ src: "ipad-mini", screenAspect: 1.523, frameAspect: 1275 / 890, t: 8.2, r: 5.57, b: 8.2, l: 5.57 },
	{ src: "ipad-11", screenAspect: 1.451, frameAspect: 1320 / 940, t: 5.64, r: 4.17, b: 5.64, l: 4.17 },
	{ src: "ipad-13", screenAspect: 1.333, frameAspect: 1500 / 1150, t: 5.13, r: 4.13, b: 5.13, l: 4.13 },
];
const IPHONE_SCREEN_ASPECT = 0.488;

/** Closest iPad frame to a screenshot ratio, or null to keep the iPhone
 *  default when the capture is phone-shaped. Log-distance so portrait and
 *  landscape match symmetrically. */
function chooseBezel(ratio: number): IpadBezel | null {
	if (!Number.isFinite(ratio) || ratio <= 0) return null;
	let best: IpadBezel | null = null;
	let bestDist = Math.abs(Math.log(ratio / IPHONE_SCREEN_ASPECT));
	for (const b of IPAD_BEZELS) {
		const d = Math.abs(Math.log(ratio / b.screenAspect));
		if (d < bestDist) {
			bestDist = d;
			best = b;
		}
	}
	return best;
}

/** Size a bezel (card or lightbox) to a screenshot's aspect. iPad frames get
 *  the measured inset + frame PNG; phone-shaped captures reset to the CSS
 *  default + iPhone frame. Inset-based so it works for both layouts. */
function styleBezelForRatio(
	bezel: HTMLElement,
	screen: HTMLElement,
	frames: HTMLImageElement[],
	ratio: number,
	iphoneLight: string,
	iphoneDark: string,
): void {
	const choice = chooseBezel(ratio);
	const s = screen.style;
	if (!choice) {
		bezel.style.aspectRatio = "";
		s.top = "";
		s.left = "";
		s.right = "";
		s.bottom = "";
		s.width = "";
		s.height = "";
		s.borderRadius = "";
		if (frames[0]) frames[0].src = iphoneLight;
		if (frames[1]) frames[1].src = iphoneDark;
		return;
	}
	bezel.style.aspectRatio = String(choice.frameAspect);
	s.top = `${choice.t}%`;
	s.left = `${choice.l}%`;
	s.right = `${choice.r}%`;
	s.bottom = `${choice.b}%`;
	s.width = "auto";
	s.height = "auto";
	s.borderRadius = "2.6%";
	for (const f of frames) f.src = `${choice.src}.png`;
}

/** Apply the right bezel once the screenshot's intrinsic size is known, and
 *  re-apply whenever the image src changes (lightbox navigation). */
function attachBezelSizing(
	img: HTMLImageElement,
	bezel: HTMLElement,
	screen: HTMLElement,
	frames: HTMLImageElement[],
	iphoneLight = "iphone-17.png",
	iphoneDark = "iphone-17-dark.png",
): void {
	const run = (): void => {
		if (img.naturalWidth && img.naturalHeight) {
			styleBezelForRatio(
				bezel,
				screen,
				frames,
				img.naturalWidth / img.naturalHeight,
				iphoneLight,
				iphoneDark,
			);
		}
	};
	if (img.complete) run();
	img.addEventListener("load", run);
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
	const headerText = ce("div", "rn-lightbox-header-text");
	const title = ce("div", "rn-lightbox-title");
	const sub = ce("div", "rn-lightbox-sub");
	headerText.append(title, sub);
	// Re-snap this specific screen: forces the current bridge frame to
	// REPLACE this record's image regardless of route/state. The lightbox
	// closes after a successful capture; the user can click the card again
	// to see the new version (and the previous image is preserved in
	// `versions[]`).
	const snapThisBtn = ce("button", "btn btn-primary btn-sm rn-lightbox-snap");
	snapThisBtn.type = "button";
	snapThisBtn.append(icon("camera", { size: 14 }), document.createTextNode("Re-snap"));
	snapThisBtn.title = "Capture the current bridge frame and replace this screen's image";
	snapThisBtn.addEventListener("click", async () => {
		const cur = siblings[idx];
		if (!cur) return;
		snapThisBtn.disabled = true;
		try {
			await doSnap("auto", {
				forceScreen: {
					sessionId: cur.sessionId,
					sequence: cur.sequence,
				},
			});
		} finally {
			snapThisBtn.disabled = false;
		}
		closeSnapLightbox();
	});
	header.append(headerText, snapThisBtn);

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
	attachBezelSizing(img, bezel, bezelScreen, [bezelLight, bezelDark]);

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

	// Long-page row paused. For now, the recommended workflow on a long
	// scrollable page is to take multiple variant snaps (⌘⇧V) — top,
	// middle, bottom — and they cluster under the same route in the
	// timeline. The doToggleFullPage handler + wrap-screen CLI + bridge
	// full-page path all stay wired in the codebase for the eventual
	// re-enable.
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

	// Version scrubber strip — sits below the bezel inside stageMain.
	// Visible only when the active snap has past versions (re-snapped at
	// least once). Clicking a chip swaps the bezel image to that capture.
	const versionStrip = ce("div", "rn-lightbox-versions");

	stageMain.append(prevBtn, bezel, nextBtn, inspector);

	const footer = ce("div", "rn-lightbox-footer");
	const counter = ce("span", "rn-lightbox-counter");
	const hint = ce("span", "rn-lightbox-hint");
	hint.innerHTML =
		"<kbd>←</kbd> <kbd>→</kbd> siblings · <kbd>↑</kbd> <kbd>↓</kbd> versions · <kbd>Esc</kbd> close";
	footer.append(counter, hint);

	stage.append(closeBtn, header, stageMain, versionStrip, footer);
	backdrop.appendChild(stage);
	document.body.appendChild(backdrop);

	// versionIdx 0 = current (snap.image / capturedAt)
	// versionIdx 1..N = past captures from snap.versions[i-1]
	let versionIdx = 0;

	/**
	 * Reads the currently-displayed image + capturedAt from the active
	 * sibling at the active version index. Centralizes the "what is shown
	 * right now" logic so the bezel + inspector + counter agree.
	 */
	const activeVersion = (): {
		imagePath: string;
		remoteImageUrl?: string;
		capturedAt: string;
		navStack?: string[];
	} => {
		const cur = siblings[idx]!;
		if (versionIdx === 0) {
			return {
				imagePath: cur.imagePath,
				remoteImageUrl: cur.remoteImageUrl,
				capturedAt: cur.capturedAt,
				navStack: cur.navStack,
			};
		}
		const v = cur.versions?.[versionIdx - 1];
		if (!v) {
			return {
				imagePath: cur.imagePath,
				remoteImageUrl: cur.remoteImageUrl,
				capturedAt: cur.capturedAt,
				navStack: cur.navStack,
			};
		}
		return v;
	};

	const renderVersionStrip = (): void => {
		const cur = siblings[idx]!;
		const total = (cur.versions?.length ?? 0) + 1;
		versionStrip.replaceChildren();
		if (total <= 1) {
			versionStrip.style.display = "none";
			return;
		}
		versionStrip.style.display = "";
		// Chips ordered oldest → newest, left to right. Latest sits on the
		// right and is selected by default (versionIdx 0 = right-most).
		for (let i = total - 1; i >= 0; i--) {
			const isLatest = i === 0;
			const chip = ce("div", "rn-lightbox-version-chip");
			chip.dataset.active = String(versionIdx === i);
			const v =
				i === 0
					? { imagePath: cur.imagePath, capturedAt: cur.capturedAt }
					: cur.versions?.[i - 1];
			if (!v) continue;
			const thumb = ce("img", "rn-lightbox-version-thumb");
			thumb.src = snapImageSrc(v);
			thumb.alt = "";
			thumb.loading = "lazy";
			const label = ce("span", "rn-lightbox-version-label");
			label.textContent = isLatest ? "Latest" : `v${total - i}`;
			const time = ce("span", "rn-lightbox-version-time");
			time.textContent = new Date(v.capturedAt).toLocaleString();
			// × delete button — hover-revealed on each chip. Hooks
			// deleteSnapVersion which handles the "promote next-most-recent"
			// logic when the latest is removed.
			const delBtn = ce("button", "rn-lightbox-version-del");
			delBtn.type = "button";
			delBtn.title = "Delete this version";
			delBtn.setAttribute(
				"aria-label",
				isLatest ? "Delete latest version" : `Delete v${total - i}`,
			);
			delBtn.textContent = "×";
			delBtn.addEventListener("click", (ev) => {
				ev.stopPropagation();
				ev.preventDefault();
				void doDeleteSnapVersion(cur, i, total);
			});
			chip.append(thumb, label, time, delBtn);
			chip.addEventListener("click", () => {
				versionIdx = i;
				update();
			});
			versionStrip.appendChild(chip);
		}
	};

	const update = (): void => {
		const cur = siblings[idx];
		if (!cur) return;
		// Clamp versionIdx in case sibling change reduced version count.
		const versionTotal = (cur.versions?.length ?? 0) + 1;
		if (versionIdx >= versionTotal) versionIdx = 0;

		const v = activeVersion();
		img.src = snapImageSrc(v);
		title.textContent = cur.route || "/";
		const versionTag =
			versionIdx === 0
				? versionTotal > 1
					? ` · latest of ${versionTotal}`
					: ""
				: ` · v${versionTotal - versionIdx} of ${versionTotal}`;
		sub.textContent = `#${String(cur.sequence).padStart(2, "0")} · ${new Date(v.capturedAt).toLocaleString()}${versionTag}`;
		counter.textContent = `${idx + 1} / ${siblings.length}`;
		prevBtn.disabled = idx === 0;
		nextBtn.disabled = idx >= siblings.length - 1;

		inspRoute.textContent = cur.route || "/";
		inspPos.textContent = `${idx + 1} of ${siblings.length}`;
		inspCap.textContent = new Date(v.capturedAt).toLocaleString();
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

		// Long-page capture row. We can't reliably introspect whether the
		// Long-page row paused — kept the inspFullPage container empty so
		// the layout doesn't reflow when re-enabled. The clickable
		// Enable/Disable + doToggleFullPage wiring stays in the codebase
		// for the eventual re-enable.

		renderVersionStrip();
	};
	update();

	const onKey = (ev: KeyboardEvent): void => {
		if (ev.key === "Escape") {
			ev.preventDefault();
			closeSnapLightbox();
		} else if (ev.key === "ArrowLeft" && idx > 0) {
			ev.preventDefault();
			idx -= 1;
			versionIdx = 0;
			update();
		} else if (ev.key === "ArrowRight" && idx < siblings.length - 1) {
			ev.preventDefault();
			idx += 1;
			versionIdx = 0;
			update();
		} else if (ev.key === "ArrowDown") {
			const cur = siblings[idx];
			const total = (cur?.versions?.length ?? 0) + 1;
			if (total > 1 && versionIdx < total - 1) {
				ev.preventDefault();
				versionIdx += 1;
				update();
			}
		} else if (ev.key === "ArrowUp") {
			if (versionIdx > 0) {
				ev.preventDefault();
				versionIdx -= 1;
				update();
			}
		}
	};
	prevBtn.addEventListener("click", () => {
		if (idx > 0) {
			idx -= 1;
			versionIdx = 0;
			update();
		}
	});
	nextBtn.addEventListener("click", () => {
		if (idx < siblings.length - 1) {
			idx += 1;
			versionIdx = 0;
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
		const kind = state.get().source.kind;
		// "url" mode (web projects) needs polling too — the Chrome extension
		// pushes snaps via HTTP, bypassing the view's RPC, so the Library has
		// no other way to learn about them. "iossim" is the original case.
		if (kind !== "iossim" && kind !== "url") {
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

// Live current-route indicator — polls the connected bridge every 2s
// when a project is selected, updates `state.rn.currentRoute` so the
// topbar pill shows "Connected · /reservation/abc123". Skipped when no
// project is selected or bridge isn't online for it; lighter cadence
// than the status poll because requestState round-trips to the device.
let rnRoutePollTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Auto-snap state machine:
 *   - `lastSnappedRoute`: the last route we already snapped. Stays the
 *     same when the user lingers on a screen so we don't fire a snap
 *     every 2s.
 *   - `pendingSnapRoute` + `pendingSnapAt`: tracks a route the user
 *     just navigated to but we haven't snapped yet. We wait 1s of
 *     stability (no further nav) before firing — gives the screen time
 *     to render data, dismiss splash, etc.
 */
let lastSnappedRoute: string | null = null;
let pendingSnapRoute: string | null = null;
let pendingSnapAt = 0;
const AUTO_SNAP_SETTLE_MS = 1000;

function ensureRouteIndicatorPolling(): void {
	if (rnRoutePollTimer) return;
	rnRoutePollTimer = setInterval(async () => {
		const cur = state.get();
		if (cur.source.kind !== "iossim") {
			if (rnRoutePollTimer) {
				clearInterval(rnRoutePollTimer);
				rnRoutePollTimer = null;
			}
			return;
		}
		const slug = cur.rn.selectedProjectSlug;
		if (!slug || !cur.rn.projects.includes(slug)) {
			if (cur.rn.currentRoute !== null) {
				state.set((c) => ({ ...c, rn: { ...c.rn, currentRoute: null } }));
			}
			// Clear pending snap state when project context goes away.
			pendingSnapRoute = null;
			lastSnappedRoute = null;
			return;
		}
		try {
			const r = await req.getBridgeRoute({ projectSlug: slug });
			const next = r.ok ? r.route ?? null : null;
			if (next !== cur.rn.currentRoute) {
				state.set((c) => ({ ...c, rn: { ...c.rn, currentRoute: next } }));
			}
			// Auto-snap logic — fires only when the toggle is ON, the
			// bridge is reporting a route, and the route is new (not
			// what we last snapped or what's currently pending).
			if (isAutoSnapOn() && next && !cur.rn.busy && !cur.rn.pushing) {
				if (next !== lastSnappedRoute && next !== pendingSnapRoute) {
					// New route detected — start the settle clock.
					pendingSnapRoute = next;
					pendingSnapAt = Date.now();
				} else if (
					next === pendingSnapRoute &&
					Date.now() - pendingSnapAt >= AUTO_SNAP_SETTLE_MS
				) {
					// Same route for at least the settle window — fire.
					const routeToSnap = pendingSnapRoute;
					pendingSnapRoute = null;
					lastSnappedRoute = routeToSnap;
					void doSnap("auto").catch((err) => {
						log(
							`Auto-snap failed: ${(err as Error).message}`,
							"error",
						);
						// Reset so the user can retry by navigating away
						// and back, instead of being stuck on a route
						// we silently skip.
						lastSnappedRoute = null;
					});
				}
				// If the route changed AGAIN before settle, the first
				// branch above resets pendingSnapAt — natural debounce.
			}
		} catch {
			// Bridge dropped mid-poll — clear the indicator. The next
			// status poll will pick up the disconnect and grey out
			// the snap button.
			if (cur.rn.currentRoute !== null) {
				state.set((c) => ({ ...c, rn: { ...c.rn, currentRoute: null } }));
			}
			pendingSnapRoute = null;
		}
	}, 2000);
}

function stopRnPolling(): void {
	if (rnPollTimer) {
		clearInterval(rnPollTimer);
		rnPollTimer = null;
	}
	if (rnRoutePollTimer) {
		clearInterval(rnRoutePollTimer);
		rnRoutePollTimer = null;
	}
}

state.subscribe((s) => {
	// Never poll or auto-refresh while signed out. Critically, this also breaks a
	// busy-loop: when a session expires mid-project, refreshProjectRegistry's
	// needsSignIn branch sets session=null + registry=[] while source.kind stays
	// "iossim" — without this guard that state change would re-enter the
	// registry-empty refresh below and spin forever.
	if (!s.session) {
		stopRnPolling();
		return;
	}
	if (s.source.kind === "iossim") {
		ensureRnPolling();
		ensureRouteIndicatorPolling();
		if (s.rn.registry.length === 0) void refreshProjectRegistry();
	} else if (s.source.kind === "url") {
		// Web projects also need the snap-status poll so extension-pushed
		// snaps appear in the Library without a manual refresh.
		ensureRnPolling();
	}
});

// Cmd+Shift+S → snap (replace existing slot), Cmd+Shift+V → snap as variant
// (force a new card on the same slot). Both only when in RN mode.
window.addEventListener("keydown", (e) => {
	if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
	if (state.get().source.kind !== "iossim") return;
	if (e.key === "s" || e.key === "S") {
		e.preventDefault();
		void doSnap("auto");
	} else if (e.key === "v" || e.key === "V") {
		e.preventDefault();
		void doSnap("variant");
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

