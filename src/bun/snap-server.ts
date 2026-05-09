import type { Server, ServerWebSocket } from "bun";

export interface SnapSnapshot {
	route: string;
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
}

interface PendingRequest {
	id: string;
	kind: "state" | "capture";
	resolve: (response: StateResponse | CaptureResponse) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface CaptureResponse {
	/** Base64-encoded PNG of the full page content. */
	image: string;
}

export interface SnapServer {
	readonly port: number;
	clientCount(): number;
	clients(): readonly Pick<
		ClientInfo,
		"projectId" | "connectedAt" | "declaredFlows"
	>[];
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
	 * Subscribe to a client's first valid flow declaration. The handler
	 * fires once per (projectId, declaration) pair — re-connections with
	 * the same declaration are de-duped. Returns an unsubscribe function.
	 */
	onDeclaredFlows(
		handler: (projectId: string, decl: DeclaredFlows) => void,
	): () => void;
	stop(): void;
}

export interface StartSnapServerOptions {
	port?: number;
	log?: (msg: string) => void;
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
				log(
					`declared-flows subscriber error: ${(err as Error).message}`,
				);
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

				if (m.kind === "hello" && typeof m.projectId === "string") {
					ws.data.projectId = m.projectId;
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
							new Error(typeof m.error === "string" ? m.error : "capture failed"),
						);
						return;
					}
					if (typeof m.image !== "string" || m.image.length === 0) {
						p.reject(new Error("malformed capture response from bridge"));
						return;
					}
					p.resolve({ image: m.image });
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
		requestState,
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

function countDeclaredScreens(flows: readonly DeclaredFlow[]): number {
	let n = 0;
	for (const f of flows) {
		n += (f.screens ?? []).length;
		if (f.flows) n += countDeclaredScreens(f.flows);
	}
	return n;
}
