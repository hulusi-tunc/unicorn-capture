/**
 * Onboarding 2.0 — 4-phase stepper modal.
 *
 *   Detect → Plan → Install → Verify
 *
 * Replaces the old single-page form (openWizard / doSubmitWizard in
 * view/index.ts). Self-contained so view/index.ts only needs to call
 * `openWizardV2(deps)` from the "+ Add" button.
 *
 * Each phase has its own DOM section; the stepper switches by toggling
 * a single `data-active` attribute on the modal root. Install + Verify
 * share a streamed log built from `onInitProgress` events.
 */

import { icon } from "../lib/icon";
import type {
	InstallPlanInput,
	InstallProgressMessage,
	RepoFingerprint,
	ScenarioRunnerRPC,
} from "../lib/rpc";

type Req = (...args: unknown[]) => unknown;
type LogFn = (msg: string, level?: "info" | "success" | "warn" | "error") => void;

export interface WizardDeps {
	/** The Electroview RPC `request` proxy — `req.detectRepo({...})` etc. */
	req: {
		pickRepoPath: ScenarioRunnerRPC["bun"]["requests"]["pickRepoPath"]["params"] extends Record<string, unknown>
			? Req
			: Req;
		detectRepo: Req;
		runInstaller: Req;
		improveSnapFlows: Req;
	};
	/**
	 * Subscribe to `onInitProgress` messages. Returns an unsubscribe fn.
	 * Wizard registers per-install handlers via this so progress lines
	 * route into the right Install screen.
	 */
	subscribeProgress: (
		handler: (msg: InstallProgressMessage) => void,
	) => () => void;
	log: LogFn;
	/** localStorage helpers (already present in view/index.ts). */
	readLocal: (key: string) => string;
	writeLocal: (key: string, value: string) => void;
	/** Refresh sidebar after a successful install. */
	refreshProjectRegistry: () => Promise<void> | void;
}

interface WizardState {
	phase: "detect" | "plan" | "install" | "verify";
	repoPath: string;
	fingerprint: RepoFingerprint | null;
	plan: InstallPlanInput | null;
	progress: InstallProgressMessage[];
	outcome: {
		ok: boolean;
		error?: string;
		verify?: {
			bridgeConnected: boolean;
			flowCount?: number;
			screenCount?: number;
			fullPageReady?: boolean;
			notes: string[];
		};
	} | null;
	/** Locally-known unsubscribe so we don't leak listeners across opens. */
	unsubscribe: (() => void) | null;
	closing: boolean;
}

export function openWizardV2(deps: WizardDeps): void {
	const state: WizardState = {
		phase: "detect",
		repoPath: "",
		fingerprint: null,
		plan: null,
		progress: [],
		outcome: null,
		unsubscribe: null,
		closing: false,
	};

	const root = document.createElement("div");
	root.className = "wiz2-backdrop";
	root.dataset.phase = state.phase;
	const dialog = document.createElement("div");
	dialog.className = "wiz2-dialog";
	root.appendChild(dialog);

	// Stepper header
	const stepperBar = document.createElement("ol");
	stepperBar.className = "wiz2-stepper";
	const stepLabels: Array<[WizardState["phase"], string]> = [
		["detect", "Detect"],
		["plan", "Plan"],
		["install", "Install"],
		["verify", "Verify"],
	];
	const stepNodes: Record<string, HTMLLIElement> = {};
	for (const [key, label] of stepLabels) {
		const li = document.createElement("li");
		li.dataset.phase = key;
		li.textContent = label;
		stepperBar.appendChild(li);
		stepNodes[key] = li;
	}
	dialog.appendChild(stepperBar);

	// Body — one section per phase, only the active one displays
	const body = document.createElement("div");
	body.className = "wiz2-body";
	dialog.appendChild(body);

	const sections: Record<WizardState["phase"], HTMLElement> = {
		detect: buildDetectSection(),
		plan: buildPlanSection(),
		install: buildInstallSection(),
		verify: buildVerifySection(),
	};
	for (const phase of ["detect", "plan", "install", "verify"] as const) {
		body.appendChild(sections[phase]);
	}

	// Footer buttons (created before syncPhase since it reads their .hidden/.disabled)
	const footer = document.createElement("div");
	footer.className = "wiz2-footer";
	const cancelBtn = makeBtn("Cancel", "btn btn-ghost");
	const backBtn = makeBtn("Back", "btn btn-secondary");
	const nextBtn = makeBtn("Continue", "btn btn-primary");
	footer.append(cancelBtn, backBtn, nextBtn);
	dialog.appendChild(footer);

	syncPhase();

	cancelBtn.addEventListener("click", () => close());
	backBtn.addEventListener("click", () => goBack());
	nextBtn.addEventListener("click", () => void goNext());

	document.body.appendChild(root);

	// Esc closes when not actively running an install
	const onKey = (ev: KeyboardEvent) => {
		if (ev.key === "Escape" && state.phase !== "install") close();
	};
	document.addEventListener("keydown", onKey);

	// ── phase sections ────────────────────────────────────────────────────

	function buildDetectSection(): HTMLElement {
		const sec = document.createElement("section");
		sec.className = "wiz2-section wiz2-section-detect";
		sec.innerHTML = `
			<div class="wiz2-detect-empty">
				<h3>Pick a repo to onboard</h3>
				<p class="wiz2-hint">Capture will scan it — no edits yet — and show what it found.</p>
				<button class="btn btn-primary wiz2-pick-btn" type="button">Browse for repo…</button>
				<p class="wiz2-or">or drop a folder anywhere on this dialog</p>
			</div>
			<div class="wiz2-detect-result" hidden></div>
		`;
		const pickBtn = sec.querySelector<HTMLButtonElement>(".wiz2-pick-btn")!;
		pickBtn.addEventListener("click", () => void doPickRepo());

		// Drag-and-drop folder support
		root.addEventListener("dragover", (e) => {
			e.preventDefault();
			root.classList.add("wiz2-dragging");
		});
		root.addEventListener("dragleave", () => {
			root.classList.remove("wiz2-dragging");
		});
		root.addEventListener("drop", (e) => {
			e.preventDefault();
			root.classList.remove("wiz2-dragging");
			const file = e.dataTransfer?.files?.[0];
			if (!file) return;
			// In Electrobun, dropped files give a path via webkitRelativePath / name
			// — but we only need the directory. For MVP, just hint that the user
			// should still use the picker.
			deps.log(
				`Drag-drop received "${file.name}" — open the picker to confirm folder`,
				"info",
			);
		});
		return sec;
	}

	function buildPlanSection(): HTMLElement {
		const sec = document.createElement("section");
		sec.className = "wiz2-section wiz2-section-plan";
		sec.hidden = true;
		sec.innerHTML = `
			<h3>What will happen</h3>
			<div class="wiz2-plan-summary"></div>
			<ul class="wiz2-plan-checklist"></ul>
			<div class="wiz2-plan-fields">
				<label class="wiz2-field">
					<span>Slug (kebab-case identifier)</span>
					<input type="text" class="input wiz2-slug" autocomplete="off" />
				</label>
				<label class="wiz2-field">
					<span>Display name (optional)</span>
					<input type="text" class="input wiz2-name" autocomplete="off" />
				</label>
				<label class="wiz2-field">
					<span>Platform URL</span>
					<input type="text" class="input wiz2-platform-url" autocomplete="off" />
				</label>
				<label class="wiz2-field">
					<span>Setup token (or paste an existing pgt_… project token)</span>
					<input type="text" class="input wiz2-token" autocomplete="off" />
				</label>
			</div>
		`;
		return sec;
	}

	function buildInstallSection(): HTMLElement {
		const sec = document.createElement("section");
		sec.className = "wiz2-section wiz2-section-install";
		sec.hidden = true;
		sec.innerHTML = `
			<h3 class="with-spin-prefix"><span class="wiz2-installing-text">Installing…</span></h3>
			<ol class="wiz2-step-list"></ol>
			<details class="wiz2-output">
				<summary>View command output</summary>
				<pre class="wiz2-output-pre"></pre>
			</details>
		`;
		// Prepend a Lucide loader SVG so the heading carries the activity-language
		// spinner prefix. The CSS rule `.with-spin-prefix > .ic` rotates it.
		const h3 = sec.querySelector("h3")!;
		h3.prepend(icon("loader", { size: 16 }));
		return sec;
	}

	function buildVerifySection(): HTMLElement {
		const sec = document.createElement("section");
		sec.className = "wiz2-section wiz2-section-verify";
		sec.hidden = true;
		sec.innerHTML = `
			<div class="wiz2-verify-card"></div>
		`;
		return sec;
	}

	// ── flow ──────────────────────────────────────────────────────────────

	async function doPickRepo(): Promise<void> {
		const r = (await deps.req.pickRepoPath({})) as
			| { ok: true; path: string }
			| { ok: false; error: string };
		if (!r.ok) {
			deps.log(`Pick canceled: ${r.error}`, "info");
			return;
		}
		state.repoPath = r.path;
		const det = (await deps.req.detectRepo({ repoPath: r.path })) as
			| { ok: true; fingerprint: RepoFingerprint }
			| { ok: false; error: string };
		if (!det.ok) {
			renderDetectError(det.error);
			return;
		}
		state.fingerprint = det.fingerprint;
		renderDetectResult(det.fingerprint);
	}

	function renderDetectError(message: string): void {
		const sec = sections.detect;
		const result = sec.querySelector<HTMLElement>(".wiz2-detect-result")!;
		result.hidden = false;
		result.innerHTML = `<div class="wiz2-error">${escapeHtml(message)}</div>`;
		nextBtn.disabled = true;
	}

	function renderDetectResult(fp: RepoFingerprint): void {
		const sec = sections.detect;
		const result = sec.querySelector<HTMLElement>(".wiz2-detect-result")!;
		result.hidden = false;
		const empty = sec.querySelector<HTMLElement>(".wiz2-detect-empty")!;
		empty.hidden = true;

		const pickedLabel = fp.picked
			? `${fp.picked.relativeFromRepo}${fp.picked.hasAppFolder ? " (Expo Router)" : ""}`
			: "(not found)";
		const bridgeLabel =
			fp.snapBridge.state === "missing"
				? "missing"
				: fp.snapBridge.state === "floating"
					? `floating (${truncate(fp.snapBridge.current, 40)})`
					: `pinned ${fp.snapBridge.current}${fp.snapBridge.matchesSuggested ? " ✓" : ` (will bump to ${fp.snapBridge.suggested})`}`;
		const layoutLabel =
			fp.layoutFile.wiringState === "wired"
				? "wired ✓"
				: fp.layoutFile.wiringState === "absent"
					? `not wired (${fp.layoutFile.componentShape})`
					: "ast-unsupported (manual paste needed)";

		result.innerHTML = `
			<h3>Found this</h3>
			<dl class="wiz2-fp">
				<dt>Repo</dt>             <dd>${escapeHtml(fp.repoPath)}</dd>
				<dt>Workspace</dt>        <dd>${escapeHtml(fp.workspaceRoot)}${fp.isMonorepo ? " (monorepo)" : ""}</dd>
				<dt>RN app</dt>           <dd>${escapeHtml(pickedLabel)}</dd>
				<dt>Layout flavor</dt>    <dd>${fp.rnLayout}</dd>
				<dt>Package manager</dt>  <dd>${fp.packageManager}</dd>
				<dt>snap-bridge</dt>      <dd>${escapeHtml(bridgeLabel)}</dd>
				<dt>view-shot</dt>        <dd>${fp.viewShot.installed ? `installed${fp.viewShot.podsInstalled ? " (+ pods)" : " (pods not run)"}` : "missing"}</dd>
				<dt>_layout.tsx</dt>      <dd>${escapeHtml(layoutLabel)}</dd>
				<dt>snap-flows.ts</dt>    <dd>${fp.flowsFile.path ? "present" : "absent"}</dd>
				<dt>useSnapTarget</dt>    <dd>${fp.hookFile.path ? "present" : "absent"}</dd>
			</dl>
			${fp.candidates.length > 1 ? renderCandidatePicker(fp) : ""}
		`;
		nextBtn.disabled = !fp.picked;
	}

	function renderCandidatePicker(fp: RepoFingerprint): string {
		const opts = fp.candidates
			.map(
				(c, i) =>
					`<option value="${i}">${escapeHtml(c.relativeFromRepo)}${c.hasAppFolder ? " (has app/)" : ""}</option>`,
			)
			.join("");
		return `<label class="wiz2-field"><span>Multiple RN packages found — pick one</span><select class="select wiz2-candidate">${opts}</select></label>`;
	}

	function fillPlan(): void {
		if (!state.fingerprint) return;
		const fp = state.fingerprint;
		const sec = sections.plan;
		const summary = sec.querySelector<HTMLElement>(".wiz2-plan-summary")!;
		const list = sec.querySelector<HTMLElement>(".wiz2-plan-checklist")!;
		const slugInput = sec.querySelector<HTMLInputElement>(".wiz2-slug")!;
		const nameInput = sec.querySelector<HTMLInputElement>(".wiz2-name")!;
		const urlInput = sec.querySelector<HTMLInputElement>(".wiz2-platform-url")!;
		const tokenInput = sec.querySelector<HTMLInputElement>(".wiz2-token")!;

		// Defaults — prefer the repo folder name ("ovria") over the RN
		// package.json `name` field, which is often the generic "mobile" or
		// "app" in monorepos and produces colliding slugs.
		const defaultSlug = pickDefaultSlug(fp);
		slugInput.value = defaultSlug;
		nameInput.value = titlecase(defaultSlug);
		urlInput.value = deps.readLocal("capture.platformUrl") || "http://localhost:3010";
		tokenInput.value = deps.readLocal("capture.setupToken") || "";

		const items: Array<{ id: string; label: string; checked: boolean; toggleable: boolean; rationale?: string }> = [
			{
				id: "platformRegister",
				label: fp.snapBridge.state === "pinned" && fp.snapBridge.matchesSuggested ? "Use existing platform record" : "Register on platform (or reuse existing)",
				checked: true,
				toggleable: false,
			},
			{
				id: "addBridgeDep",
				label: fp.snapBridge.state === "pinned" && fp.snapBridge.matchesSuggested
					? `snap-bridge already pinned at ${fp.snapBridge.current}`
					: `Pin snap-bridge to ${fp.snapBridge.suggested}`,
				checked: true,
				toggleable: false,
			},
			{
				id: "writeMetroConfig",
				label: fp.isMonorepo
					? "Write metro.config.js (correct workspaceRoot for this layout)"
					: "Skip metro.config.js (single-package layout)",
				checked: fp.isMonorepo,
				toggleable: false,
			},
			{
				id: "writeUseSnapTargetHook",
				label: fp.hookFile.path
					? "useSnapTarget hook already present"
					: "Write hooks/useSnapTarget.ts",
				checked: !fp.hookFile.path,
				toggleable: true,
			},
			{
				id: "runPackageInstall",
				label: `Run ${fp.packageManager} install`,
				checked: true,
				toggleable: true,
			},
			{
				id: "installViewShot",
				label: fp.viewShot.installed
					? "react-native-view-shot already installed"
					: "Install react-native-view-shot (full-page capture)",
				checked: !fp.viewShot.installed,
				toggleable: true,
			},
			{
				id: "runPodInstall",
				label: fp.iosWorkspace.exists
					? "Run pod install (iOS)"
					: "Skip pod install (no ios workspace)",
				checked: fp.iosWorkspace.exists,
				toggleable: fp.iosWorkspace.exists,
			},
			{
				id: "patchLayout",
				label: fp.layoutFile.wiringState === "wired"
					? "Layout already wired"
					: "Wire installSnapBridge into root _layout",
				checked: fp.layoutFile.wiringState !== "wired",
				toggleable: false,
			},
			{
				id: "runSnapFlowsScan",
				label: "Generate snap-flows.ts from app/ routes",
				checked: true,
				toggleable: true,
			},
			{
				id: "verify",
				label: "Auto-launch app & verify bridge connects",
				checked: true,
				toggleable: true,
			},
		];

		list.innerHTML = items
			.map(
				(it) => `<li class="wiz2-plan-item">
				<input type="checkbox" id="wiz2-opt-${it.id}" ${it.checked ? "checked" : ""} ${it.toggleable ? "" : "disabled"} />
				<label for="wiz2-opt-${it.id}">${escapeHtml(it.label)}</label>
			</li>`,
			)
			.join("");

		summary.innerHTML = `Onboarding ${escapeHtml(fp.repoPath)}${fp.picked ? ` → ${escapeHtml(fp.picked.relativeFromRepo)}` : ""}.`;
	}

	function readPlanInput(): InstallPlanInput | null {
		if (!state.fingerprint) return null;
		const sec = sections.plan;
		const slug = (sec.querySelector<HTMLInputElement>(".wiz2-slug")!).value.trim();
		const name = (sec.querySelector<HTMLInputElement>(".wiz2-name")!).value.trim();
		const platformUrl = (sec.querySelector<HTMLInputElement>(".wiz2-platform-url")!).value.trim();
		const tokenField = (sec.querySelector<HTMLInputElement>(".wiz2-token")!).value.trim();

		if (!slug) {
			deps.log("Slug is required", "error");
			return null;
		}
		if (!platformUrl) {
			deps.log("Platform URL is required", "error");
			return null;
		}
		if (!tokenField) {
			deps.log("Setup token (or pgt_ project token) is required", "error");
			return null;
		}

		const checked = (id: string): boolean =>
			Boolean((sec.querySelector<HTMLInputElement>(`#wiz2-opt-${id}`))?.checked);

		const projectToken = tokenField.startsWith("pgt_") ? tokenField : undefined;
		const setupToken = projectToken ? undefined : tokenField;

		return {
			slug,
			name: name || undefined,
			platform: "ios",
			platformUrl,
			setupToken,
			projectToken,
			fingerprint: state.fingerprint,
			options: {
				runPackageInstall: checked("runPackageInstall"),
				installViewShot: checked("installViewShot"),
				runPodInstall: checked("runPodInstall"),
				runSnapFlowsScan: checked("runSnapFlowsScan"),
				writeUseSnapTargetHook: checked("writeUseSnapTargetHook"),
				verifyAfterInstall: checked("verify"),
			},
		};
	}

	async function startInstall(plan: InstallPlanInput): Promise<void> {
		state.plan = plan;
		state.progress = [];
		state.outcome = null;
		renderInstallEmpty();
		nextBtn.disabled = true;
		backBtn.disabled = true;

		// Persist URL + token for next time
		deps.writeLocal("capture.platformUrl", plan.platformUrl);
		if (plan.setupToken) deps.writeLocal("capture.setupToken", plan.setupToken);

		// Subscribe to progress messages
		state.unsubscribe = deps.subscribeProgress((msg) => {
			state.progress.push(msg);
			renderProgress(msg);
		});

		try {
			const outcome = (await deps.req.runInstaller({ plan })) as {
				ok: boolean;
				error?: string;
				verify?: WizardState["outcome"] extends infer T
					? T extends { verify?: infer V }
						? V
						: never
					: never;
			};
			state.outcome = outcome;
			state.unsubscribe?.();
			state.unsubscribe = null;
			state.phase = "verify";
			syncPhase();
			renderVerify();
			void deps.refreshProjectRegistry();
		} catch (err) {
			state.outcome = {
				ok: false,
				error: (err as Error)?.message ?? String(err),
			};
			state.unsubscribe?.();
			state.unsubscribe = null;
			state.phase = "verify";
			syncPhase();
			renderVerify();
		} finally {
			backBtn.disabled = false;
			nextBtn.disabled = false;
		}
	}

	function renderInstallEmpty(): void {
		const sec = sections.install;
		const list = sec.querySelector<HTMLElement>(".wiz2-step-list")!;
		list.innerHTML = "";
		(sec.querySelector<HTMLElement>(".wiz2-output-pre")!).textContent = "";
	}

	function renderProgress(msg: InstallProgressMessage): void {
		const sec = sections.install;
		const list = sec.querySelector<HTMLElement>(".wiz2-step-list")!;
		const outputPre = sec.querySelector<HTMLElement>(".wiz2-output-pre")!;
		let row = list.querySelector<HTMLElement>(`[data-step="${cssEscape(msg.stepId)}"]`);
		if (!row) {
			row = document.createElement("li");
			row.dataset.step = msg.stepId;
			row.className = "wiz2-step-row";
			list.appendChild(row);
		}
		row.dataset.phase = msg.phase;
		row.textContent = msg.message;
		if (msg.outputLine) {
			outputPre.textContent += msg.outputLine + "\n";
			outputPre.scrollTop = outputPre.scrollHeight;
		}
	}

	function renderVerify(): void {
		const sec = sections.verify;
		const card = sec.querySelector<HTMLElement>(".wiz2-verify-card")!;
		const o = state.outcome;
		if (!o) {
			card.innerHTML = "";
			return;
		}
		if (!o.ok) {
			card.className = "wiz2-verify-card wiz2-verify-failed";
			card.innerHTML = `
				<h3>Install failed</h3>
				<p>${escapeHtml(o.error ?? "Unknown error")}</p>
				<p class="wiz2-hint">Rolled back any changes that succeeded before the failure. Fix the issue + re-run from Detect.</p>
			`;
			nextBtn.textContent = "Close";
			return;
		}
		const v = o.verify;
		const verifyLines = v
			? [
					v.bridgeConnected ? "✓ Bridge connected" : "⚠ Bridge didn't connect (Doctor warning)",
					v.flowCount !== undefined ? `✓ ${v.flowCount} flows / ${v.screenCount ?? 0} screens declared` : "",
					v.fullPageReady ? "✓ Full-page capture ready" : "ℹ Full-page capture is opt-in — default snap uses iOS Sim viewport. Wrap individual ScrollView content in <View ref={useSnapTarget()}> only on screens where you want long-page snaps.",
					...v.notes.map((n) => `· ${n}`),
				]
				.filter(Boolean)
				.map((l) => `<li>${escapeHtml(l)}</li>`)
				.join("")
			: "<li>Skipped verify (you toggled it off in Plan).</li>";
		card.className = "wiz2-verify-card wiz2-verify-ok";
		const slug = state.plan?.slug ?? "";
		card.innerHTML = `
			<h3>Done — ready to snap</h3>
			<ul class="wiz2-verify-checks">${verifyLines}</ul>
			<div class="wiz2-improve">
				<div class="wiz2-improve-title">✨ Improve flow grouping</div>
				<p class="wiz2-improve-body">Default flows are path-based — fine for snapping but rough on real user journeys. Hand them to Claude Code with screen context (JSDoc, imports, top strings) and get back a regrouped <code>snap-flows.ts</code> in seconds.</p>
				<div class="wiz2-improve-actions">
					<button type="button" class="btn btn-secondary wiz2-improve-btn" data-slug="${escapeHtml(slug)}">Copy improver prompt</button>
					<span class="wiz2-improve-status" aria-live="polite"></span>
				</div>
				<p class="wiz2-improve-hint">Paste into Claude Code in your project's repo, save the suggested <code>snap-flows.ts</code> over the existing one, then click Refresh on the project card to re-ingest.</p>
			</div>
		`;
		const improveBtn = card.querySelector<HTMLButtonElement>(".wiz2-improve-btn");
		const improveStatus = card.querySelector<HTMLElement>(".wiz2-improve-status");
		if (improveBtn && improveStatus && slug) {
			improveBtn.addEventListener("click", () =>
				void runImprover(slug, improveBtn, improveStatus),
			);
		} else if (improveBtn) {
			improveBtn.disabled = true;
		}
		nextBtn.textContent = "Open project";
	}

	async function runImprover(
		slug: string,
		btn: HTMLButtonElement,
		statusEl: HTMLElement,
	): Promise<void> {
		const originalLabel = btn.textContent ?? "Copy improver prompt";
		btn.disabled = true;
		btn.classList.add("is-busy");
		btn.replaceChildren(
			icon("loader", { size: 14 }),
			document.createTextNode("Building prompt…"),
		);
		statusEl.classList.add("with-spin-prefix");
		statusEl.replaceChildren(
			icon("loader", { size: 12 }),
			document.createTextNode("Building prompt…"),
		);
		const resetStatus = (text: string): void => {
			statusEl.classList.remove("with-spin-prefix");
			statusEl.textContent = text;
		};
		try {
			const r = (await deps.req.improveSnapFlows({ slug })) as
				| { ok: true; clipboardPayload: string; flowsFilePath: string; summary: string }
				| { ok: false; error: string };
			if (!r.ok) {
				resetStatus(`Failed: ${r.error}`);
				deps.log(`Improver failed: ${r.error}`, "error");
				btn.classList.remove("is-busy");
				btn.replaceChildren(document.createTextNode(originalLabel));
				btn.disabled = false;
				return;
			}
			const copied = await copyToClipboard(r.clipboardPayload);
			btn.classList.remove("is-busy");
			if (copied) {
				resetStatus(`Copied (${r.summary}) — paste into Claude Code`);
				deps.log(`✨ Improver prompt copied (${r.summary})`, "success");
				btn.replaceChildren(document.createTextNode("✓ Copied"));
			} else {
				resetStatus("Couldn't access the clipboard — opening a fallback window");
				deps.log(
					"Clipboard blocked by WKWebView — opened the prompt in a viewer window so you can copy manually",
					"warn",
				);
				openPromptViewer(r.clipboardPayload, r.summary);
				btn.replaceChildren(document.createTextNode("View prompt"));
				btn.disabled = false;
			}
		} catch (err) {
			resetStatus(`Failed: ${(err as Error).message}`);
			deps.log(`Improver crashed: ${(err as Error).message}`, "error");
			btn.classList.remove("is-busy");
			btn.replaceChildren(document.createTextNode(originalLabel));
			btn.disabled = false;
		}
	}

	// ── controls ──────────────────────────────────────────────────────────

	function syncPhase(): void {
		root.dataset.phase = state.phase;
		for (const phase of ["detect", "plan", "install", "verify"] as const) {
			sections[phase].hidden = phase !== state.phase;
			stepNodes[phase]!.dataset.state =
				phase === state.phase
					? "active"
					: phaseOrder(phase) < phaseOrder(state.phase)
						? "done"
						: "pending";
		}
		// Footer button labels
		if (state.phase === "detect") {
			cancelBtn.hidden = false;
			backBtn.hidden = true;
			nextBtn.textContent = "Continue";
			nextBtn.disabled = !state.fingerprint?.picked;
		} else if (state.phase === "plan") {
			cancelBtn.hidden = false;
			backBtn.hidden = false;
			nextBtn.textContent = "Set up";
			nextBtn.disabled = false;
		} else if (state.phase === "install") {
			cancelBtn.hidden = true;
			backBtn.hidden = true;
			nextBtn.textContent = "Working…";
			nextBtn.disabled = true;
		} else if (state.phase === "verify") {
			cancelBtn.hidden = true;
			backBtn.hidden = !state.outcome?.ok;
			nextBtn.textContent = state.outcome?.ok ? "Open project" : "Close";
			nextBtn.disabled = false;
		}
	}

	function goBack(): void {
		if (state.phase === "plan") {
			state.phase = "detect";
		} else if (state.phase === "verify" && !state.outcome?.ok) {
			state.phase = "detect";
		}
		syncPhase();
	}

	async function goNext(): Promise<void> {
		if (state.phase === "detect") {
			if (!state.fingerprint?.picked) return;
			state.phase = "plan";
			syncPhase();
			fillPlan();
			return;
		}
		if (state.phase === "plan") {
			const plan = readPlanInput();
			if (!plan) return;
			state.phase = "install";
			syncPhase();
			void startInstall(plan);
			return;
		}
		if (state.phase === "verify") {
			close();
			return;
		}
	}

	function close(): void {
		if (state.closing) return;
		state.closing = true;
		state.unsubscribe?.();
		document.removeEventListener("keydown", onKey);
		root.remove();
	}
}

// ── small utils ─────────────────────────────────────────────────────────

/**
 * Copy to clipboard with WKWebView-safe fallback. The async Clipboard API
 * needs an "allow access" permission that WKWebView usually denies, so we
 * fall back to the legacy textarea + execCommand("copy") trick which works
 * inside any user-gesture handler. Returns true on success.
 */
async function copyToClipboard(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// permission denied — fall through to legacy path
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		ta.style.pointerEvents = "none";
		ta.setAttribute("readonly", "readonly");
		document.body.appendChild(ta);
		ta.select();
		ta.setSelectionRange(0, text.length);
		const ok = document.execCommand("copy");
		document.body.removeChild(ta);
		return ok;
	} catch {
		return false;
	}
}

/**
 * Last-resort viewer: clipboard blocked + execCommand failed. Show the
 * prompt in a scrollable, pre-selected `<textarea>` so the user can
 * Cmd+A / Cmd+C themselves.
 */
function openPromptViewer(text: string, summary: string): void {
	const backdrop = document.createElement("div");
	backdrop.className = "wiz2-prompt-backdrop";
	backdrop.innerHTML = `
		<div class="wiz2-prompt-dialog">
			<div class="wiz2-prompt-header">
				<div class="wiz2-prompt-title">Improver prompt — ${summary}</div>
				<button type="button" class="wiz2-prompt-close" aria-label="Close">×</button>
			</div>
			<p class="wiz2-prompt-hint">Clipboard access was blocked by WKWebView. Click in the box, then ⌘A → ⌘C to copy.</p>
			<textarea class="wiz2-prompt-text" readonly></textarea>
		</div>
	`;
	const ta = backdrop.querySelector<HTMLTextAreaElement>(".wiz2-prompt-text");
	const closeBtn = backdrop.querySelector<HTMLButtonElement>(".wiz2-prompt-close");
	if (ta) {
		ta.value = text;
		// Preselect so ⌘A is unnecessary in most cases.
		setTimeout(() => {
			ta.focus();
			ta.select();
		}, 50);
	}
	const close = () => backdrop.remove();
	closeBtn?.addEventListener("click", close);
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) close();
	});
	document.body.appendChild(backdrop);
}

function makeBtn(label: string, className: string): HTMLButtonElement {
	const b = document.createElement("button");
	b.type = "button";
	b.className = className;
	b.textContent = label;
	return b;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64) || "new-project";
}

/**
 * Pick a sensible default slug for the project. Repo folder name beats
 * package.json `name` because monorepos commonly use generic names ("mobile",
 * "app", "frontend") at the package level — those collide across projects
 * and don't tell the designer what they're capturing.
 *
 * Order:
 *   1. Repo folder name (e.g. "ovria" from "/Users/x/ovria")
 *   2. package.json name IF it's not a generic placeholder
 *   3. "new-project"
 */
const GENERIC_PKG_NAMES = new Set([
	"mobile",
	"app",
	"frontend",
	"main",
	"client",
	"web",
	"native",
	"rn",
	"react-native",
]);

function pickDefaultSlug(fp: RepoFingerprint): string {
	const folderSlug = slugify(basename(fp.repoPath));
	if (folderSlug && folderSlug !== "new-project") {
		return folderSlug;
	}
	const pkgName = fp.picked?.packageJsonName;
	if (pkgName && !GENERIC_PKG_NAMES.has(pkgName.toLowerCase())) {
		return slugify(pkgName);
	}
	return "new-project";
}

function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const idx = trimmed.lastIndexOf("/");
	return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function titlecase(s: string): string {
	return s
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

function phaseOrder(p: WizardState["phase"]): number {
	return { detect: 0, plan: 1, install: 2, verify: 3 }[p];
}

function cssEscape(s: string): string {
	return s.replace(/["\\]/g, "\\$&");
}
