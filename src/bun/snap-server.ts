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

interface ClientInfo {
	ws: ServerWebSocket<ClientInfo>;
	projectId: string;
	connectedAt: number;
}

interface PendingRequest {
	id: string;
	resolve: (response: StateResponse) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface SnapServer {
	readonly port: number;
	clientCount(): number;
	clients(): readonly Pick<ClientInfo, "projectId" | "connectedAt">[];
	requestState(opts?: { timeoutMs?: number }): Promise<StateResponse>;
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

	const server: Server = Bun.serve<ClientInfo, unknown>({
		port,
		fetch(req, srv) {
			if (
				srv.upgrade(req, {
					data: {
						ws: null as unknown as ServerWebSocket<ClientInfo>,
						projectId: "",
						connectedAt: Date.now(),
					},
				})
			) {
				return undefined;
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
					log(`hello from project "${m.projectId}"`);
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
				}
			},
			close(ws) {
				clients.delete(ws.data);
				log(`client disconnected (${clients.size} remaining)`);
			},
		},
	});

	function pickPrimary(): ClientInfo | null {
		let primary: ClientInfo | null = null;
		for (const c of clients) {
			if (!primary || c.connectedAt > primary.connectedAt) primary = c;
		}
		return primary;
	}

	function requestState(
		opts: { timeoutMs?: number } = {},
	): Promise<StateResponse> {
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const primary = pickPrimary();
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
			pending.set(id, { id, resolve, reject, timer });
			try {
				primary.ws.send(JSON.stringify({ cmd: "get-state", id }));
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
			})),
		requestState,
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
