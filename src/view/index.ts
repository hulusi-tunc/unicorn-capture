import { Electroview } from "electrobun/view";
import type {
	FlowResult,
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
};

// ─── RPC ───
// 10 min timeout — covers user-interactive RPCs (file picker), source extraction, full runs.
const rpc = Electroview.defineRPC<ScenarioRunnerRPC>({
	maxRequestTime: 600000,
	handlers: { requests: {}, messages: {} },
});
const electroview = new Electroview({ rpc });
const req = (electroview.rpc as any).request;

// ─── ATOMS (template fns, no inline styles) ───
const cls = (...xs: (string | false | undefined | null)[]) =>
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
			${empty(null, UI.labels.empty.noFlow + " — add a flow or click Record.")}`;
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
			`Config received — devices.yaml: ${cfg.devicesYaml ? cfg.devicesYaml.length + "B" : "EMPTY"}, scenarios.yaml: ${cfg.scenarioYaml ? cfg.scenarioYaml.length + "B" : "EMPTY"}`,
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
