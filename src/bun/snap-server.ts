import type { Server, ServerWebSocket } from "bun";

export interface SnapSnapshot {
	route: string;
	/**
	 * Router pattern for `route` with dynamic segments preserved (e.g.
	 * `/reservation/:id` for a concrete pathname of `/reservation/abc123`).
	 * When present, the orchestrator uses this to keep all snaps of the
	 * same parameterized screen in a single flow instead of spawning one
	 * flow per id. Optional — older snap-bridge versions don't send it,
	 * in which case the orchestrator falls back to literal-route matching.
	 */
	routePattern?: string;
	navStack?: string[];
	stateHash?: string;
	extras?: Record<string, unknown>;
}

export interface StateResponse {
	projectId: string;
	snapshot: SnapSnapshot;
	ts: number;
}

/**
 * Mirror of `@unicorn-studio/snap-bridge`'s `SnapFlowsDeclaration` —
 * we keep a local copy because snap-bridge is an RN-side dev dep, not
 * something we want to depend on at runtime here.
 */
export interface DeclaredFlowScreen {
	id?: string;
	name?: string;
	route: string;
	stateHash?: string;
}

export interface DeclaredFlow {
	id: string;
	name?: string;
	screens?: DeclaredFlowScreen[];
	flows?: DeclaredFlow[];
}

export interface DeclaredFlows {
	version: 1;
	flows: DeclaredFlow[];
}

interface ClientInfo {
	ws: ServerWebSocket<ClientInfo>;
	projectId: string;
	connectedAt: number;
	/** Whatever flow declaration this client sent in its hello message. */
	declaredFlows: DeclaredFlows | null;
	/**
	 * Stable per-install id the bridge derives from `expo-application`.
	 * When present and matching a recent session for the same projectId,
	 * the orchestrator resumes that session instead of minting a new
	 * one — so hot-reloads stop spawning ghost sessions in the timeline.
	 * Empty string for older bridges that don't send it.
	 */
	clientId: string;
}

interface PendingRequest {
	id: string;
	kind: "state" | "capture" | "navigate";
	resolve: (
		response: StateResponse | CaptureResponse | NavigateResponse,
	) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface NavigateResponse {
	projectId: string;
	/**
	 * The route the bridge actually ended up on. Usually equal to the
	 * requested route, but may differ when a redirect (e.g. AuthGate)
	 * fires between `router.replace()` and the ready ack — see
	 * `requestedRoute` + `redirected` below.
	 */
	route: string;
	stateHash?: string;
	/**
	 * Bridge-reported settle-time for the route (ms from receiving `goto`
	 * to firing `ready`). Tour driver uses this to detect flaky screens.
	 */
	settleMs?: number;
	/**
	 * Present when the bridge detected a redirect between the requested
	 * `goto` and the final pathname. `route` holds the final destination,
	 * `requestedRoute` holds the original request. Requires snap-bridge
	 * v0.8.2+ — older bridges always ack the requested route, so absence
	 * does NOT prove a redirect didn't happen.
	 */
	requestedRoute?: string;
	redirected?: boolean;
}

export interface CaptureResponse {
	/** Base64-encoded PNG of the full page content. */
	image: string;
	/**
	 * The wrapped snap-target's window-relative bounds at capture time +
	 * device pixel ratio. Optional — older bridge versions don't report
	 * this. Capture uses it to identify the "chrome strips" (everything
	 * outside the snap-target's rect inside the viewport) on a regular
	 * simulator screenshot, then stitches those strips onto the long-page
	 * output so sticky chrome (status bar, tab bar) stays visible.
	 */
	measurements?: {
		x: number;
		y: number;
		width: number;
		height: number;
		viewportWidth: number;
		viewportHeight: number;
		pixelRatio: number;
	};
}

export interface SnapServer {
	readonly port: number;
	clientCount(): number;
	clients(): readonly Pick<
		ClientInfo,
		"projectId" | "connectedAt" | "declaredFlows"
	>[];
	/**
	 * Look up the stable bridge clientId for a currently-connected
	 * project. Returns empty string when no bridge is connected for that
	 * project or when the bridge is older than Item 13 and didn't send
	 * one. Used by the orchestrator to route snaps to a resumed session
	 * across hot-reloads.
	 */
	getClientId(projectId: string): string;
	/**
	 * Close every currently-open bridge socket. The bridge's onclose
	 * handler kicks in and triggers its 3-second reconnect logic — so
	 * within a few seconds the user gets a fresh hello with the latest
	 * declared flows. Surfaced as the "Reconnect" fix action in the
	 * Doctor panel for the case where the bridge looks stuck.
	 */
	forceReconnect(): void;
	requestState(opts?: {
		timeoutMs?: number;
		/** Pin to a specific bridge by its slug; falls back to most-recent. */
		projectId?: string;
	}): Promise<StateResponse>;
	/**
	 * Ask the most-recently-connected bridge (or the one matching `projectId`,
	 * if pinned) to capture its registered SnapTarget as a base64 PNG (full
	 * content, not just viewport). Resolves with the bytes; rejects when the
	 * bridge isn't connected, no target is registered, react-native-view-shot
	 * is missing, or the request times out. Capture-side caller should fall
	 * back to simctl in those cases.
	 */
	requestFullPageCapture(opts?: {
		timeoutMs?: number;
		projectId?: string;
	}): Promise<CaptureResponse>;
	/**
	 * Ask the bridge to navigate to `route` (with optional path params) and
	 * resolve once the bridge fires its `ready` ack. Pairs with the customer-
	 * project tour driver — the bridge is expected to call `router.navigate`
	 * then post `{ kind: "ready", id, route, stateHash }` back over the WS.
	 */
	requestNavigate(opts: {
		route: string;
		params?: Record<string, string | number>;
		projectId?: string;
		timeoutMs?: number;
	}): Promise<NavigateResponse>;
	/**
	 * Subscribe to a client's first valid flow declaration. The handler
	 * fires once per (projectId, declaration) pair — re-connections with
	 * the same declaration are de-duped. Returns an unsubscribe function.
	 */
	onDeclaredFlows(
		handler: (projectId: string, decl: DeclaredFlows) => void,
	): () => void;
	stop(): void;
}

/**
 * Minimal surface the snap-server needs from the orchestrator to serve the
 * `/tour/*` HTTP endpoints. Kept as a thin interface so snap-server stays
 * decoupled from snap-orchestrator.ts (which is a much heavier dependency).
 */
export interface TourBackend {
	/** A snap-orchestrator-shaped snap. Returns the manifest record on success. */
	snap(opts?: {
		projectId?: string;
		flowId?: string;
		label?: string;
	}): Promise<
		{ ok: true; record: Record<string, unknown> } | { ok: false; error: string }
	>;
}

/**
 * Surface the snap-server needs to serve `/web-ext/*` HTTP endpoints used
 * by the Chrome extension. Stays decoupled from the orchestrator + the
 * project registry for the same reasons as TourBackend.
 */
export interface WebExtBackend {
	listWebProjects(): Promise<
		Array<{ slug: string; name: string; baseUrl?: string }>
	>;
	listFlowsForProject(
		projectId: string,
	): Promise<Array<{ id: string; name: string; parentFlowId?: string }>>;
	recordSnap(opts: {
		projectId: string;
		url: string;
		title?: string;
		fullPage?: boolean;
		flowId?: string;
		pngBytes: Uint8Array;
	}): Promise<
		| {
				ok: true;
				record: Record<string, unknown>;
				placement: Record<string, unknown>;
		  }
		| { ok: false; error: string }
	>;
	/**
	 * Attach a recorded motion clip (webm/mp4) to the latest snap of the
	 * page's route. Requires the still to exist — it doubles as poster.
	 */
	attachVideo(opts: {
		projectId: string;
		url: string;
		videoBytes: Uint8Array;
		mimeType: string;
	}): Promise<
		| { ok: true; record: Record<string, unknown>; route: string }
		| { ok: false; error: string }
	>;
}

export interface StartSnapServerOptions {
	port?: number;
	log?: (msg: string) => void;
	/**
	 * Lazy accessor for the tour backend. Lazy because the orchestrator is
	 * typically created *after* the server starts (the server's port is
	 * needed inside the orchestrator). Returns null if no orchestrator is
	 * available yet — `/tour/snap` returns 503 in that case.
	 */
	tourBackend?: () => TourBackend | null;
	/**
	 * Lazy accessor for the web-extension backend. Same lazy-init reasoning
	 * as tourBackend. Returns null until the orchestrator + project registry
	 * are ready — `/web-ext/snap` returns 503 in that case.
	 */
	webExtBackend?: () => WebExtBackend | null;
}

const DEFAULT_PORT = 9876;
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * WebSocket server that brokers metadata requests from the desktop tool to
 * any connected `@unicorn-studio/snap-bridge` clients (running inside RN apps).
 *
 * Lifecycle:
 *   - bridge connects → sends `{kind:"hello", projectId}`
 *   - server.requestState() → sends `{cmd:"get-state", id}` to most-recent client
 *   - bridge replies `{kind:"state", id, projectId, snapshot, ts}` → resolves promise
 */
export function startSnapServer(
	options: StartSnapServerOptions = {},
): SnapServer {
	const port = options.port ?? DEFAULT_PORT;
	const log = options.log ?? ((m) => console.log(`[snap-server] ${m}`));
	const tourBackend = options.tourBackend ?? (() => null);
	const webExtBackend = options.webExtBackend ?? (() => null);

	const clients = new Set<ClientInfo>();
	const pending = new Map<string, PendingRequest>();
	const declaredFlowSubscribers = new Set<
		(projectId: string, decl: DeclaredFlows) => void
	>();
	// Hash of last-seen declaration per project, so re-hellos with the
	// same shape don't fire subscribers redundantly.
	const lastDeclByProject = new Map<string, string>();

	function fireDeclaredFlows(projectId: string, decl: DeclaredFlows) {
		const sig = JSON.stringify(decl);
		if (lastDeclByProject.get(projectId) === sig) return;
		lastDeclByProject.set(projectId, sig);
		for (const sub of declaredFlowSubscribers) {
			try {
				sub(projectId, decl);
			} catch (err) {
				log(`declared-flows subscriber error: ${(err as Error).message}`);
			}
		}
	}

	function parseDeclaredFlows(raw: unknown): DeclaredFlows | null {
		if (!raw || typeof raw !== "object") return null;
		const r = raw as { version?: unknown; flows?: unknown };
		if (r.version !== 1 || !Array.isArray(r.flows)) return null;
		const flows: DeclaredFlow[] = [];
		for (const f of r.flows) {
			const node = parseDeclaredFlow(f);
			if (node) flows.push(node);
		}
		return { version: 1, flows };
	}

	function parseDeclaredFlow(raw: unknown): DeclaredFlow | null {
		if (!raw || typeof raw !== "object") return null;
		const r = raw as Record<string, unknown>;
		if (typeof r.id !== "string" || !r.id) return null;
		const node: DeclaredFlow = { id: r.id };
		if (typeof r.name === "string") node.name = r.name;
		if (Array.isArray(r.screens)) {
			const screens: DeclaredFlowScreen[] = [];
			for (const s of r.screens) {
				if (!s || typeof s !== "object") continue;
				const sr = s as Record<string, unknown>;
				if (typeof sr.route !== "string" || !sr.route) continue;
				const screen: DeclaredFlowScreen = { route: sr.route };
				if (typeof sr.id === "string") screen.id = sr.id;
				if (typeof sr.name === "string") screen.name = sr.name;
				if (typeof sr.stateHash === "string") screen.stateHash = sr.stateHash;
				screens.push(screen);
			}
			if (screens.length > 0) node.screens = screens;
		}
		if (Array.isArray(r.flows)) {
			const subFlows: DeclaredFlow[] = [];
			for (const f of r.flows) {
				const sub = parseDeclaredFlow(f);
				if (sub) subFlows.push(sub);
			}
			if (subFlows.length > 0) node.flows = subFlows;
		}
		return node;
	}

	const server: Server = Bun.serve<ClientInfo, unknown>({
		port,
		async fetch(req, srv) {
			if (
				srv.upgrade(req, {
					data: {
						ws: null as unknown as ServerWebSocket<ClientInfo>,
						projectId: "",
						connectedAt: Date.now(),
						declaredFlows: null,
						clientId: "",
					},
				})
			) {
				return undefined;
			}
			// Serve snap image PNGs over HTTP so the view can load them with
			// plain <img src="..."> — WKWebView blocks file:// from views://.
			const url = new URL(req.url);
			if (url.pathname === "/img") {
				const path = url.searchParams.get("path");
				if (!path) return new Response("missing path", { status: 400 });
				try {
					const file = Bun.file(path);
					if (!(await file.exists())) {
						return new Response("not found", { status: 404 });
					}
					return new Response(file, {
						headers: {
							"Content-Type": "image/png",
							"Access-Control-Allow-Origin": "*",
							"Cache-Control": "public, max-age=300",
						},
					});
				} catch (err) {
					return new Response(`read failed: ${(err as Error).message}`, {
						status: 500,
					});
				}
			}

			// ── /tour/* — programmatic-tour HTTP API ─────────────────────────
			// Pairs with src/sdk/tour-client.ts in customer projects. See
			// docs/tour.md for the full protocol.
			if (url.pathname === "/tour/status") {
				return jsonResponse({
					bridges: [...clients].map((c) => ({
						projectId: c.projectId,
						connectedAt: c.connectedAt,
						declaredFlows: c.declaredFlows,
					})),
				});
			}

			if (url.pathname === "/tour/flows") {
				const projectId = url.searchParams.get("projectId") ?? undefined;
				const primary = pickPrimary(projectId);
				if (!primary) {
					return jsonResponse(
						{ ok: false, error: "no bridge connected" },
						{ status: 503 },
					);
				}
				return jsonResponse({
					ok: true,
					projectId: primary.projectId,
					flows: primary.declaredFlows?.flows ?? [],
				});
			}

			if (url.pathname === "/tour/goto" && req.method === "POST") {
				let body: Record<string, unknown>;
				try {
					body = (await req.json()) as Record<string, unknown>;
				} catch {
					return jsonResponse(
						{ ok: false, error: "invalid JSON body" },
						{ status: 400 },
					);
				}
				const route = typeof body.route === "string" ? body.route : "";
				if (!route) {
					return jsonResponse(
						{ ok: false, error: "missing route" },
						{ status: 400 },
					);
				}
				const projectId =
					typeof body.projectId === "string" ? body.projectId : undefined;
				const params =
					body.params && typeof body.params === "object"
						? (body.params as Record<string, string | number>)
						: undefined;
				const timeoutMs =
					typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;
				try {
					const result = await requestNavigate({
						route,
						projectId,
						params,
						timeoutMs,
					});
					return jsonResponse({ ok: true, ...result });
				} catch (err) {
					return jsonResponse(
						{ ok: false, error: (err as Error).message },
						{ status: 504 },
					);
				}
			}

			// ── /web-ext/* — Chrome extension HTTP API ───────────────────────
			// Paired with extensions/chrome (Manifest V3). The extension's
			// service worker GETs the project list to populate its popup, then
			// POSTs PNG bytes captured via CDP. Returns CORS headers so the
			// popup (chrome-extension://…) can call them directly without a
			// content-script proxy.
			if (url.pathname.startsWith("/web-ext/")) {
				if (req.method === "OPTIONS") {
					return new Response(null, {
						status: 204,
						headers: {
							"Access-Control-Allow-Origin": "*",
							"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
							"Access-Control-Allow-Headers": "content-type",
							"Access-Control-Max-Age": "86400",
						},
					});
				}
			}

			if (url.pathname === "/web-ext/projects" && req.method === "GET") {
				const backend = webExtBackend();
				if (!backend) {
					return jsonResponse(
						{ ok: false, error: "web-ext backend not ready" },
						{ status: 503 },
					);
				}
				try {
					const projects = await backend.listWebProjects();
					return jsonResponse({ ok: true, projects });
				} catch (err) {
					return jsonResponse(
						{ ok: false, error: (err as Error).message },
						{ status: 500 },
					);
				}
			}

			if (url.pathname === "/web-ext/flows" && req.method === "GET") {
				const backend = webExtBackend();
				if (!backend) {
					return jsonResponse(
						{ ok: false, error: "web-ext backend not ready" },
						{ status: 503 },
					);
				}
				const projectId = url.searchParams.get("projectId") ?? "";
				if (!projectId) {
					return jsonResponse(
						{ ok: false, error: "projectId required" },
						{ status: 400 },
					);
				}
				try {
					const flows = await backend.listFlowsForProject(projectId);
					return jsonResponse({ ok: true, flows });
				} catch (err) {
					return jsonResponse(
						{ ok: false, error: (err as Error).message },
						{ status: 500 },
					);
				}
			}

			if (url.pathname === "/web-ext/snap" && req.method === "POST") {
				const backend = webExtBackend();
				if (!backend) {
					return jsonResponse(
						{ ok: false, error: "web-ext backend not ready" },
						{ status: 503 },
					);
				}
				const projectId = url.searchParams.get("projectId") ?? "";
				const pageUrl = url.searchParams.get("url") ?? "";
				const title = url.searchParams.get("title") ?? undefined;
				const fullPage = url.searchParams.get("fullPage") === "1";
				const flowId = url.searchParams.get("flowId") || undefined;
				if (!projectId || !pageUrl) {
					return jsonResponse(
						{ ok: false, error: "projectId and url are required" },
						{ status: 400 },
					);
				}
				const ct = req.headers.get("content-type") ?? "";
				if (!ct.startsWith("image/png")) {
					return jsonResponse(
						{
							ok: false,
							error: `expected image/png body, got '${ct || "<none>"}'`,
						},
						{ status: 415 },
					);
				}
				const ab = await req.arrayBuffer();
				const pngBytes = new Uint8Array(ab);
				if (pngBytes.byteLength === 0) {
					return jsonResponse(
						{ ok: false, error: "empty PNG body" },
						{ status: 400 },
					);
				}
				try {
					const result = await backend.recordSnap({
						projectId,
						url: pageUrl,
						title,
						fullPage,
						flowId,
						pngBytes,
					});
					return jsonResponse(result, {
						status: result.ok ? 200 : 500,
					});
				} catch (err) {
					return jsonResponse(
						{ ok: false, error: (err as Error).message },
						{ status: 500 },
					);
				}
			}

			if (url.pathname === "/web-ext/video" && req.method === "POST") {
				const backend = webExtBackend();
				if (!backend) {
					return jsonResponse(
						{ ok: false, error: "web-ext backend not ready" },
						{ status: 503 },
					);
				}
				const projectId = url.searchParams.get("projectId") ?? "";
				const pageUrl = url.searchParams.get("url") ?? "";
				if (!projectId || !pageUrl) {
					return jsonResponse(
						{ ok: false, error: "projectId and url are required" },
						{ status: 400 },
					);
				}
				const ct = req.headers.get("content-type") ?? "";
				if (!ct.startsWith("video/webm") && !ct.startsWith("video/mp4")) {
					return jsonResponse(
						{
							ok: false,
							error: `expected video/webm or video/mp4 body, got '${ct || "<none>"}'`,
						},
						{ status: 415 },
					);
				}
				const ab = await req.arrayBuffer();
				const videoBytes = new Uint8Array(ab);
				if (videoBytes.byteLength === 0) {
					return jsonResponse(
						{ ok: false, error: "empty video body" },
						{ status: 400 },
					);
				}
				try {
					const result = await backend.attachVideo({
						projectId,
						url: pageUrl,
						videoBytes,
						mimeType: ct.split(";")[0] ?? "video/webm",
					});
					return jsonResponse(result, {
						status: result.ok ? 200 : 500,
					});
				} catch (err) {
					return jsonResponse(
						{ ok: false, error: (err as Error).message },
						{ status: 500 },
					);
				}
			}

			if (url.pathname === "/tour/snap" && req.method === "POST") {
				const backend = tourBackend();
				if (!backend) {
					return jsonResponse(
						{ ok: false, error: "snap orchestrator not initialised" },
						{ status: 503 },
					);
				}
				let body: Record<string, unknown> = {};
				try {
					body = (await req.json()) as Record<string, unknown>;
				} catch {
					/* empty body is fine */
				}
				const projectId =
					typeof body.projectId === "string" ? body.projectId : undefined;
				const flowId =
					typeof body.flowId === "string" ? body.flowId : undefined;
				const label = typeof body.label === "string" ? body.label : undefined;
				const result = await backend.snap({ projectId, flowId, label });
				if (!result.ok) {
					return jsonResponse(result, { status: 500 });
				}
				return jsonResponse(result);
			}

			return new Response("Unicorn Capture snap server", { status: 200 });
		},
		websocket: {
			open(ws) {
				ws.data.ws = ws;
				clients.add(ws.data);
				log(`client connected (${clients.size} total) — waiting for hello`);
			},
			message(ws, raw) {
				let msg: unknown;
				try {
					msg =
						typeof raw === "string"
							? JSON.parse(raw)
							: JSON.parse(new TextDecoder().decode(raw));
				} catch {
					return;
				}
				if (!msg || typeof msg !== "object") return;
				const m = msg as Record<string, unknown>;

				if (m.kind === "heartbeat") {
					// Bridge ping — reply immediately so its watch timer
					// stamps lastAck and keeps the socket alive.
					try {
						ws.send(JSON.stringify({ cmd: "heartbeat-ack", ts: Date.now() }));
					} catch {}
					return;
				}

				if (m.kind === "hello" && typeof m.projectId === "string") {
					ws.data.projectId = m.projectId;
					// Newer bridges (Item 13+) send a stable clientId so
					// hot-reloads resume the prior capture session. Older
					// bridges omit it; we store empty string and the
					// orchestrator falls back to per-launch session ids.
					ws.data.clientId =
						typeof m.clientId === "string" ? m.clientId : "";
					const declared = parseDeclaredFlows(m.flows);
					ws.data.declaredFlows = declared;
					if (declared) {
						const screenCount = countDeclaredScreens(declared.flows);
						log(
							`hello from project "${m.projectId}" — declared ${declared.flows.length} flow(s), ${screenCount} screen(s)`,
						);
						fireDeclaredFlows(m.projectId, declared);
					} else {
						log(`hello from project "${m.projectId}"`);
					}
					return;
				}

				if (m.kind === "state" && typeof m.id === "string") {
					const p = pending.get(m.id);
					if (!p) return;
					pending.delete(m.id);
					clearTimeout(p.timer);
					if (
						typeof m.projectId !== "string" ||
						!m.snapshot ||
						typeof m.snapshot !== "object"
					) {
						p.reject(new Error("malformed state response from bridge"));
						return;
					}
					p.resolve({
						projectId: m.projectId,
						snapshot: m.snapshot as SnapSnapshot,
						ts: typeof m.ts === "number" ? m.ts : Date.now(),
					});
					return;
				}

				if (m.kind === "capture" && typeof m.id === "string") {
					const p = pending.get(m.id);
					if (!p) return;
					pending.delete(m.id);
					clearTimeout(p.timer);
					if (m.ok === false) {
						p.reject(
							new Error(
								typeof m.error === "string" ? m.error : "capture failed",
							),
						);
						return;
					}
					if (typeof m.image !== "string" || m.image.length === 0) {
						p.reject(new Error("malformed capture response from bridge"));
						return;
					}
					const measurements = parseMeasurements(m.measurements);
					p.resolve({ image: m.image, measurements });
					return;
				}

				if (m.kind === "ready" && typeof m.id === "string") {
					const p = pending.get(m.id);
					if (!p) return;
					pending.delete(m.id);
					clearTimeout(p.timer);
					if (m.ok === false) {
						p.reject(
							new Error(
								typeof m.error === "string" ? m.error : "navigation failed",
							),
						);
						return;
					}
					if (typeof m.route !== "string") {
						p.reject(new Error("malformed ready response from bridge"));
						return;
					}
					p.resolve({
						projectId:
							typeof m.projectId === "string" ? m.projectId : ws.data.projectId,
						route: m.route,
						stateHash:
							typeof m.stateHash === "string" ? m.stateHash : undefined,
						settleMs: typeof m.settleMs === "number" ? m.settleMs : undefined,
						requestedRoute:
							typeof m.requestedRoute === "string"
								? m.requestedRoute
								: undefined,
						redirected: m.redirected === true ? true : undefined,
					});
				}
			},
			close(ws) {
				clients.delete(ws.data);
				log(`client disconnected (${clients.size} remaining)`);
			},
		},
	});

	function pickPrimary(projectId?: string): ClientInfo | null {
		// When the caller pins a projectId (the user has a project selected
		// in the sidebar), route requests to that project's bridge — even
		// if a different bridge connected more recently. Falls back to the
		// most-recently-connected client when no slug is pinned or no
		// match is found.
		let pinned: ClientInfo | null = null;
		let latest: ClientInfo | null = null;
		for (const c of clients) {
			if (projectId && c.projectId === projectId) {
				if (!pinned || c.connectedAt > pinned.connectedAt) pinned = c;
			}
			if (!latest || c.connectedAt > latest.connectedAt) latest = c;
		}
		return pinned ?? latest;
	}

	function requestState(
		opts: { timeoutMs?: number; projectId?: string } = {},
	): Promise<StateResponse> {
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const primary = pickPrimary(opts.projectId);
		if (!primary) {
			return Promise.reject(
				new Error(
					"No snap-bridge connected. Make sure your RN app is running with @unicorn-studio/snap-bridge installed and the bridge has connected.",
				),
			);
		}
		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(
					new Error(
						`requestState timed out after ${timeoutMs}ms — bridge connected but did not reply.`,
					),
				);
			}, timeoutMs);
			pending.set(id, {
				id,
				kind: "state",
				resolve: resolve as (r: StateResponse | CaptureResponse) => void,
				reject,
				timer,
			});
			try {
				primary.ws.send(JSON.stringify({ cmd: "get-state", id }));
			} catch (err) {
				clearTimeout(timer);
				pending.delete(id);
				reject(err as Error);
			}
		});
	}

	function requestNavigate(opts: {
		route: string;
		params?: Record<string, string | number>;
		projectId?: string;
		timeoutMs?: number;
	}): Promise<NavigateResponse> {
		// Default to 20s — settle waits for animations + first paint + any
		// <SnapReady/> the customer wraps around async screen content.
		const timeoutMs = opts.timeoutMs ?? 20000;
		const primary = pickPrimary(opts.projectId);
		if (!primary) {
			return Promise.reject(
				new Error(
					"No snap-bridge connected. Boot the customer app first, then re-run the tour.",
				),
			);
		}
		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(
					new Error(
						`tour goto "${opts.route}" timed out after ${timeoutMs}ms — bridge connected but did not ack ready.`,
					),
				);
			}, timeoutMs);
			pending.set(id, {
				id,
				kind: "navigate",
				resolve: resolve as (
					r: StateResponse | CaptureResponse | NavigateResponse,
				) => void,
				reject,
				timer,
			});
			try {
				primary.ws.send(
					JSON.stringify({
						cmd: "goto",
						id,
						route: opts.route,
						params: opts.params ?? {},
					}),
				);
			} catch (err) {
				clearTimeout(timer);
				pending.delete(id);
				reject(err as Error);
			}
		});
	}

	function requestFullPageCapture(
		opts: { timeoutMs?: number; projectId?: string } = {},
	): Promise<CaptureResponse> {
		// Capture can be slow on big pages — give it more breathing room
		// than requestState by default.
		const timeoutMs = opts.timeoutMs ?? 15000;
		const primary = pickPrimary(opts.projectId);
		if (!primary) {
			return Promise.reject(new Error("No snap-bridge connected."));
		}
		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(
					new Error(
						`capture-full-page timed out after ${timeoutMs}ms — bridge connected but didn't reply.`,
					),
				);
			}, timeoutMs);
			pending.set(id, {
				id,
				kind: "capture",
				resolve: resolve as (r: StateResponse | CaptureResponse) => void,
				reject,
				timer,
			});
			try {
				primary.ws.send(JSON.stringify({ cmd: "capture-full-page", id }));
			} catch (err) {
				clearTimeout(timer);
				pending.delete(id);
				reject(err as Error);
			}
		});
	}

	return {
		port,
		clientCount: () => clients.size,
		clients: () =>
			[...clients].map((c) => ({
				projectId: c.projectId,
				connectedAt: c.connectedAt,
				declaredFlows: c.declaredFlows,
			})),
		getClientId: (projectId: string) => {
			// Most-recently-connected first so a hot-reload's new socket
			// shadows the old (lingering) one before it times out.
			const ordered = [...clients].sort(
				(a, b) => b.connectedAt - a.connectedAt,
			);
			for (const c of ordered) {
				if (c.projectId === projectId) return c.clientId ?? "";
			}
			return "";
		},
		forceReconnect: () => {
			// Snapshot first — closing inside the iterator mutates the
			// `clients` set as onclose handlers fire and de-register.
			const snapshot = [...clients];
			for (const c of snapshot) {
				try {
					// Code 1012 = "Service Restart" per RFC 6455 — semantically
					// "I'm restarting, please reconnect."
					c.ws.close(1012, "force-reconnect");
				} catch {}
			}
			log(`force-reconnect: closed ${snapshot.length} bridge connection(s)`);
		},
		requestState,
		requestNavigate,
		requestFullPageCapture,
		onDeclaredFlows: (handler) => {
			declaredFlowSubscribers.add(handler);
			// Replay last-known decls so a late subscriber catches up.
			for (const c of clients) {
				if (c.declaredFlows && c.projectId) {
					try {
						handler(c.projectId, c.declaredFlows);
					} catch {}
				}
			}
			return () => {
				declaredFlowSubscribers.delete(handler);
			};
		},
		stop: () => {
			for (const p of pending.values()) {
				clearTimeout(p.timer);
				p.reject(new Error("snap server stopped"));
			}
			pending.clear();
			server.stop(true);
		},
	};
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("Content-Type", "application/json");
	headers.set("Access-Control-Allow-Origin", "*");
	return new Response(JSON.stringify(body), { ...init, headers });
}

function countDeclaredScreens(flows: readonly DeclaredFlow[]): number {
	let n = 0;
	for (const f of flows) {
		n += (f.screens ?? []).length;
		if (f.flows) n += countDeclaredScreens(f.flows);
	}
	return n;
}

/**
 * Validate the wire-format measurements payload from the bridge. Returns
 * undefined on any malformed input — Capture falls back to chrome-less
 * long-page in that case.
 */
function parseMeasurements(
	raw: unknown,
): CaptureResponse["measurements"] | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const m = raw as Record<string, unknown>;
	const num = (k: string): number | null => {
		const v = m[k];
		return typeof v === "number" && Number.isFinite(v) ? v : null;
	};
	const x = num("x");
	const y = num("y");
	const width = num("width");
	const height = num("height");
	const viewportWidth = num("viewportWidth");
	const viewportHeight = num("viewportHeight");
	const pixelRatio = num("pixelRatio");
	if (
		x === null ||
		y === null ||
		width === null ||
		height === null ||
		viewportWidth === null ||
		viewportHeight === null ||
		pixelRatio === null
	) {
		return undefined;
	}
	return { x, y, width, height, viewportWidth, viewportHeight, pixelRatio };
}
