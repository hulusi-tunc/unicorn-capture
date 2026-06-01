// Unicorn Capture side-panel popup. Drives chrome.debugger / CDP for the
// screenshot + PDF directly from the popup process (no MV3 service worker
// round-trip, which is racy). The popup itself is rendered inside Chrome's
// native side panel, so it persists while the user clicks around the page.

const CAPTURE_BASE = "http://localhost:9876";
const PROJECT_STORAGE_KEY = "uc.lastProjectSlug";
const FLOW_STORAGE_PREFIX = "uc.lastFlow:";
const STANDARD_WIDTH = 1440;
const STANDARD_HEIGHT = 900;
const SCALE = 2;
// Pause this long after each snap so the CDP screenshot buffer (30+ MB for
// a full-page Retina PNG) has time to be GC'd before the next attach. Stops
// Chrome from OOMing on rapid-fire snaps.
const INTER_SNAP_THROTTLE_MS = 350;

type Project = { slug: string; name: string; baseUrl?: string };
type FlowOption = { id: string; name: string; parentFlowId?: string };

const urlEl = document.getElementById("url") as HTMLDivElement;
const projectEl = document.getElementById("project") as HTMLSelectElement;
const flowTrigger = document.getElementById("flow-trigger") as HTMLButtonElement;
const flowLabel = document.getElementById("flow-trigger-label") as HTMLSpanElement;
const flowPop = document.getElementById("flow-pop") as HTMLDivElement;
const flowSearch = document.getElementById("flow-search") as HTMLInputElement;
const flowList = document.getElementById("flow-list") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const viewportBtn = document.getElementById("snap-viewport") as HTMLButtonElement;
const fullPageBtn = document.getElementById("snap-fullpage") as HTMLButtonElement;
const pdfBtn = document.getElementById("snap-pdf") as HTMLButtonElement;

// In-memory flow list for the custom picker. Each row carries its depth so
// the renderer can draw a tree-indent prefix; ancestors lets us future-proof
// "show parent breadcrumb on match" if we ever add it.
let flowOptions: { id: string; name: string; depth: number; ancestors: string[] }[] = [];
let activeIndex = 0;

function setStatus(message: string, kind: "idle" | "working" | "success" | "error") {
	statusEl.textContent = message;
	statusEl.className = `status ${kind}`;
}

async function readSourceTab(): Promise<chrome.tabs.Tab | null> {
	// Side panel shares the browser window with the content tabs. lastFocusedWindow
	// + windowType filter targets the real page tab even if the side panel
	// itself was just focused.
	try {
		const [tab] = await chrome.tabs.query({
			active: true,
			lastFocusedWindow: true,
			windowType: "normal",
		});
		return tab ?? null;
	} catch {
		return null;
	}
}

async function loadProjects() {
	try {
		const res = await fetch(`${CAPTURE_BASE}/web-ext/projects`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = (await res.json()) as
			| { ok: true; projects: Project[] }
			| { ok: false; error: string };
		if (!body.ok) throw new Error(body.error);
		const projects = body.projects;
		projectEl.innerHTML = "";
		if (projects.length === 0) {
			const opt = document.createElement("option");
			opt.value = "";
			opt.textContent = "No web projects — add one in Capture";
			projectEl.appendChild(opt);
			projectEl.disabled = true;
			return;
		}
		for (const p of projects) {
			const opt = document.createElement("option");
			opt.value = p.slug;
			opt.textContent = p.name;
			projectEl.appendChild(opt);
		}
		const stored = await chrome.storage.local.get(PROJECT_STORAGE_KEY);
		const remembered = stored[PROJECT_STORAGE_KEY] as string | undefined;
		if (remembered && projects.some((p) => p.slug === remembered)) {
			projectEl.value = remembered;
		}
		projectEl.disabled = false;
		viewportBtn.disabled = false;
		fullPageBtn.disabled = false;
		pdfBtn.disabled = false;
		setStatus("Ready.", "idle");
		await loadFlowsForCurrentProject();
	} catch (err) {
		setStatus(
			`Can't reach Capture at ${CAPTURE_BASE}. Is the app running?`,
			"error",
		);
		projectEl.innerHTML = '<option value="">Capture offline</option>';
		projectEl.disabled = true;
		console.error("loadProjects failed", err);
	}
}

projectEl.addEventListener("change", () => {
	void chrome.storage.local.set({ [PROJECT_STORAGE_KEY]: projectEl.value });
	void loadFlowsForCurrentProject();
});

// ─── custom flow picker ──────────────────────────────────────────────────
// Native <select> can't render tree indent reliably (Chrome's OS-native
// dropdown ignores leading whitespace + applies its own theme). This is a
// lightweight popover: button trigger, search input, indented list, keyboard
// arrows + enter + escape, single-click select.

function getCurrentFlowId(): string {
	return flowTrigger.dataset.value ?? "";
}

function setCurrentFlow(id: string, name: string): void {
	flowTrigger.dataset.value = id;
	flowLabel.textContent = name;
	const slug = projectEl.value;
	if (slug) {
		void chrome.storage.local.set({ [FLOW_STORAGE_PREFIX + slug]: id });
	}
}

function setFlowPopOpen(open: boolean): void {
	flowPop.hidden = !open;
	flowTrigger.classList.toggle("is-open", open);
	if (open) {
		flowSearch.value = "";
		renderFlowList("");
		setTimeout(() => flowSearch.focus(), 0);
	}
}

function treeGlyph(depth: number): string {
	if (depth === 0) return "";
	return `${"  ".repeat(depth - 1)}└─`;
}

type OptionInit = { id: string; name: string; tree: string; isCurrent: boolean };

function makeOption(o: OptionInit): HTMLElement {
	const el = document.createElement("div");
	el.className = "flow-opt";
	if (o.isCurrent) el.classList.add("is-selected");
	el.dataset.value = o.id;
	el.setAttribute("role", "option");
	const check = document.createElement("span");
	check.className = "flow-opt-check";
	check.textContent = o.isCurrent ? "✓" : "";
	const tree = document.createElement("span");
	tree.className = "flow-opt-tree";
	tree.textContent = o.tree;
	const name = document.createElement("span");
	name.className = "flow-opt-name";
	name.textContent = o.name;
	el.append(check, tree, name);
	// mousedown (not click) so the pick lands BEFORE the input's blur fires
	// the click-outside handler that would otherwise close the popover.
	el.addEventListener("mousedown", (ev) => {
		ev.preventDefault();
		setCurrentFlow(o.id, o.name);
		setFlowPopOpen(false);
	});
	return el;
}

function updateActiveHighlight(): void {
	const items = flowList.querySelectorAll<HTMLElement>(".flow-opt");
	items.forEach((el, i) => el.classList.toggle("is-active", i === activeIndex));
	const active = items[activeIndex];
	if (active) active.scrollIntoView({ block: "nearest" });
}

function renderFlowList(filter: string): void {
	flowList.innerHTML = "";
	const q = filter.trim().toLowerCase();
	const current = getCurrentFlowId();

	const autoMatches = !q || "auto from url".includes(q);
	if (autoMatches) {
		flowList.appendChild(
			makeOption({ id: "", name: "Auto (from URL)", tree: "", isCurrent: current === "" }),
		);
		if (flowOptions.length > 0) {
			const div = document.createElement("div");
			div.className = "flow-section-divider";
			flowList.appendChild(div);
		}
	}

	let shown = 0;
	for (const f of flowOptions) {
		if (q && !f.name.toLowerCase().includes(q)) continue;
		flowList.appendChild(
			makeOption({
				id: f.id,
				name: f.name,
				tree: treeGlyph(f.depth),
				isCurrent: current === f.id,
			}),
		);
		shown += 1;
	}

	if (!autoMatches && shown === 0) {
		const empty = document.createElement("div");
		empty.className = "flow-opt-empty";
		empty.textContent = "No flows match.";
		flowList.appendChild(empty);
	}

	activeIndex = 0;
	updateActiveHighlight();
}

flowTrigger.addEventListener("click", () => {
	if (flowTrigger.disabled) return;
	setFlowPopOpen(flowPop.hidden);
});

flowSearch.addEventListener("input", () => {
	renderFlowList(flowSearch.value);
});

flowSearch.addEventListener("keydown", (ev) => {
	const items = flowList.querySelectorAll<HTMLElement>(".flow-opt");
	if (items.length === 0) return;
	if (ev.key === "ArrowDown") {
		ev.preventDefault();
		activeIndex = Math.min(activeIndex + 1, items.length - 1);
		updateActiveHighlight();
	} else if (ev.key === "ArrowUp") {
		ev.preventDefault();
		activeIndex = Math.max(activeIndex - 1, 0);
		updateActiveHighlight();
	} else if (ev.key === "Enter") {
		ev.preventDefault();
		const target = items[activeIndex];
		if (target) target.dispatchEvent(new MouseEvent("mousedown"));
	} else if (ev.key === "Escape") {
		ev.preventDefault();
		setFlowPopOpen(false);
		flowTrigger.focus();
	}
});

document.addEventListener("mousedown", (ev) => {
	if (flowPop.hidden) return;
	const target = ev.target as HTMLElement;
	if (target.closest("#flow-combo")) return;
	setFlowPopOpen(false);
});

async function loadFlowsForCurrentProject(): Promise<void> {
	const slug = projectEl.value;
	flowOptions = [];
	if (!slug) {
		flowTrigger.disabled = true;
		setCurrentFlow("", "Auto (from URL)");
		return;
	}
	try {
		const res = await fetch(
			`${CAPTURE_BASE}/web-ext/flows?projectId=${encodeURIComponent(slug)}`,
		);
		const body = (await res.json()) as
			| { ok: true; flows: FlowOption[] }
			| { ok: false; error: string };
		if (!body.ok) throw new Error(body.error);
		const byParent = new Map<string | undefined, FlowOption[]>();
		for (const f of body.flows) {
			const key = f.parentFlowId ?? undefined;
			const list = byParent.get(key) ?? [];
			list.push(f);
			byParent.set(key, list);
		}
		const flat: typeof flowOptions = [];
		const walk = (parent: string | undefined, depth: number, ancestors: string[]) => {
			for (const f of byParent.get(parent) ?? []) {
				flat.push({ id: f.id, name: f.name, depth, ancestors });
				walk(f.id, depth + 1, [...ancestors, f.id]);
			}
		};
		walk(undefined, 0, []);
		flowOptions = flat;
		flowTrigger.disabled = false;

		const stored = await chrome.storage.local.get(FLOW_STORAGE_PREFIX + slug);
		const remembered = stored[FLOW_STORAGE_PREFIX + slug] as string | undefined;
		const match = remembered ? flat.find((f) => f.id === remembered) : null;
		if (match) {
			setCurrentFlow(match.id, match.name);
		} else {
			setCurrentFlow("", "Auto (from URL)");
		}
	} catch (err) {
		flowTrigger.disabled = true;
		setCurrentFlow("", "Auto (from URL)");
		console.warn("loadFlowsForCurrentProject failed", err);
	}
}

// ─── CDP capture ─────────────────────────────────────────────────────────

function sendCmd(
	target: chrome.debugger.Debuggee,
	method: string,
	params: Record<string, unknown>,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		chrome.debugger.sendCommand(target, method, params, (result) => {
			const err = chrome.runtime.lastError;
			if (err) reject(new Error(`${method}: ${err.message}`));
			else resolve(result);
		});
	});
}

function wait(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function captureViaCdp(
	tabId: number,
	fullPage: boolean,
): Promise<Uint8Array> {
	const target: chrome.debugger.Debuggee = { tabId };
	let attached = false;
	let overridden = false;
	try {
		await chrome.debugger.attach(target, "1.3");
		attached = true;
		await sendCmd(target, "Emulation.setDeviceMetricsOverride", {
			width: STANDARD_WIDTH,
			height: STANDARD_HEIGHT,
			deviceScaleFactor: SCALE,
			mobile: false,
		});
		overridden = true;
		await wait(150);

		const shotParams: Record<string, unknown> = {
			format: "png",
			// fromSurface MUST be true — recent Chrome rejects false with
			// "Only screenshots from surface are allowed." captureBeyondViewport
			// already makes Chrome render from the layout viewport (honoring the
			// metrics override), so we don't need fromSurface:false for that.
			fromSurface: true,
			captureBeyondViewport: true,
			optimizeForSpeed: false,
		};
		if (!fullPage) {
			shotParams.clip = {
				x: 0,
				y: 0,
				width: STANDARD_WIDTH,
				height: STANDARD_HEIGHT,
				scale: 1,
			};
		}
		const shot = (await sendCmd(target, "Page.captureScreenshot", shotParams)) as {
			data: string;
		};
		const bytes = base64ToBytes(shot.data);
		// Drop the base64 string reference so the renderer can GC ~10+ MB
		// between snaps.
		(shot as { data?: string }).data = undefined;
		return bytes;
	} finally {
		if (overridden) {
			await sendCmd(target, "Emulation.clearDeviceMetricsOverride", {}).catch(
				() => {},
			);
		}
		if (attached) {
			await chrome.debugger.detach(target).catch(() => {});
		}
	}
}

let lastSnapAt = 0;
let snapInFlight = false;

async function snap(fullPage: boolean) {
	if (snapInFlight) return;
	const sinceLast = Date.now() - lastSnapAt;
	if (sinceLast < INTER_SNAP_THROTTLE_MS) {
		await wait(INTER_SNAP_THROTTLE_MS - sinceLast);
	}
	const tab = await readSourceTab();
	if (!tab?.id || !tab.url) {
		setStatus("No active tab in the browser window.", "error");
		return;
	}
	const projectId = projectEl.value;
	if (!projectId) {
		setStatus("Pick a project first.", "error");
		return;
	}
	snapInFlight = true;
	viewportBtn.disabled = true;
	fullPageBtn.disabled = true;
	pdfBtn.disabled = true;
	setStatus(fullPage ? "Capturing full page…" : "Capturing viewport…", "working");
	let pngBytes: Uint8Array | null = null;
	try {
		pngBytes = await captureViaCdp(tab.id, fullPage);
		setStatus("Uploading…", "working");
		const params = new URLSearchParams({
			projectId,
			url: tab.url,
			fullPage: fullPage ? "1" : "0",
		});
		if (tab.title) params.set("title", tab.title);
		const flowId = getCurrentFlowId();
		if (flowId) params.set("flowId", flowId);
		const res = await fetch(`${CAPTURE_BASE}/web-ext/snap?${params}`, {
			method: "POST",
			headers: { "content-type": "image/png" },
			body: pngBytes,
		});
		const body = (await res.json()) as
			| {
					ok: true;
					record: { route: string };
					placement: { flowName: string; kind: string };
			  }
			| { ok: false; error: string };
		if (!body.ok) {
			setStatus(body.error, "error");
			return;
		}
		const verb = body.placement.kind === "auto-new" ? "New flow" : "Added to";
		setStatus(
			`Snapped → ${verb} "${body.placement.flowName}" (${body.record.route})`,
			"success",
		);
		urlEl.textContent = tab.url;
	} catch (err) {
		setStatus(`Snap failed: ${(err as Error).message}`, "error");
	} finally {
		pngBytes = null;
		snapInFlight = false;
		lastSnapAt = Date.now();
		viewportBtn.disabled = false;
		fullPageBtn.disabled = false;
		pdfBtn.disabled = false;
	}
}

async function captureFullPagePdf(tabId: number): Promise<Uint8Array> {
	const target: chrome.debugger.Debuggee = { tabId };
	let attached = false;
	let overridden = false;
	try {
		await chrome.debugger.attach(target, "1.3");
		attached = true;
		await sendCmd(target, "Emulation.setDeviceMetricsOverride", {
			width: STANDARD_WIDTH,
			height: STANDARD_HEIGHT,
			deviceScaleFactor: 1,
			mobile: false,
		});
		overridden = true;
		await wait(150);
		// Paginate at viewport size — each PDF page is 1440×900 (15×9.375
		// inches at 96dpi). A previous single-page approach generated one
		// 15×83-inch sheet which every PDF viewer fits-to-page, making the
		// content tiny. Multi-page lets the reader flip through chunks at
		// native scale.
		const pdf = (await sendCmd(target, "Page.printToPDF", {
			printBackground: true,
			preferCSSPageSize: false,
			marginTop: 0,
			marginBottom: 0,
			marginLeft: 0,
			marginRight: 0,
			paperWidth: STANDARD_WIDTH / 96,
			paperHeight: STANDARD_HEIGHT / 96,
			landscape: false,
			scale: 1,
		})) as { data: string };
		const bytes = base64ToBytes(pdf.data);
		(pdf as { data?: string }).data = undefined;
		return bytes;
	} finally {
		if (overridden) {
			await sendCmd(target, "Emulation.clearDeviceMetricsOverride", {}).catch(
				() => {},
			);
		}
		if (attached) {
			await chrome.debugger.detach(target).catch(() => {});
		}
	}
}

function buildPdfFilename(tab: chrome.tabs.Tab): string {
	let host = "page";
	let path = "";
	try {
		const u = new URL(tab.url ?? "");
		host = u.hostname.replace(/^www\./, "");
		path = u.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/[^a-z0-9._-]+/gi, "-");
	} catch {}
	const stamp = new Date()
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace("T", "_")
		.slice(0, 19);
	const stem = path ? `${host}-${path}` : host;
	return `unicorn-capture/${stem}-${stamp}.pdf`;
}

async function savePdf() {
	if (snapInFlight) return;
	const sinceLast = Date.now() - lastSnapAt;
	if (sinceLast < INTER_SNAP_THROTTLE_MS) {
		await wait(INTER_SNAP_THROTTLE_MS - sinceLast);
	}
	const tab = await readSourceTab();
	if (!tab?.id || !tab.url) {
		setStatus("No active tab in the browser window.", "error");
		return;
	}
	snapInFlight = true;
	viewportBtn.disabled = true;
	fullPageBtn.disabled = true;
	pdfBtn.disabled = true;
	setStatus("Generating PDF…", "working");
	let pdfBytes: Uint8Array | null = null;
	let blobUrl: string | null = null;
	try {
		pdfBytes = await captureFullPagePdf(tab.id);
		const blob = new Blob([pdfBytes], { type: "application/pdf" });
		blobUrl = URL.createObjectURL(blob);
		const filename = buildPdfFilename(tab);
		await new Promise<void>((resolve, reject) => {
			chrome.downloads.download(
				{ url: blobUrl as string, filename, saveAs: false },
				(id) => {
					const err = chrome.runtime.lastError;
					if (err || id === undefined) {
						reject(new Error(err?.message ?? "download failed"));
					} else resolve();
				},
			);
		});
		setStatus(`Saved → Downloads/${filename}`, "success");
	} catch (err) {
		setStatus(`PDF failed: ${(err as Error).message}`, "error");
	} finally {
		if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl as string), 60_000);
		pdfBytes = null;
		snapInFlight = false;
		lastSnapAt = Date.now();
		viewportBtn.disabled = false;
		fullPageBtn.disabled = false;
		pdfBtn.disabled = false;
	}
}

viewportBtn.addEventListener("click", () => void snap(false));
fullPageBtn.addEventListener("click", () => void snap(true));
pdfBtn.addEventListener("click", () => void savePdf());

async function refreshTabDisplay() {
	const tab = await readSourceTab();
	urlEl.textContent = tab?.url ?? "(no active tab)";
}

// Live-update the URL line as the user navigates / switches tabs in the
// main window so the side panel always shows what the next snap will hit.
chrome.tabs.onActivated.addListener(() => void refreshTabDisplay());
chrome.tabs.onUpdated.addListener((_id, info) => {
	if (info.url) void refreshTabDisplay();
});
chrome.windows.onFocusChanged.addListener(() => void refreshTabDisplay());

void (async () => {
	await refreshTabDisplay();
	await loadProjects();
})();
