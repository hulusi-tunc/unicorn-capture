/**
 * Tour client — drives Unicorn Capture's `/tour/*` HTTP API from a customer
 * project (e.g. ovria). Designed to be a single-file zero-dep import: copy
 * this file into your project's scripts directory, or symlink it from the
 * Unicorn Capture install.
 *
 * Usage (in ovria/scripts/tour.ts):
 *
 *   import { Tour } from "./tour-client";
 *
 *   const tour = new Tour({ projectId: "ovria" });
 *   await tour.run([
 *     "/",
 *     "/splash",
 *     ["/thread/:conv", { conv: "conv1" }],
 *   ]);
 *
 * Prerequisites:
 *   1. Unicorn Capture is running (serves snap-server on :9876).
 *   2. The customer RN app is running in the iOS simulator with
 *      `@unicorn-studio/snap-bridge` v0.8+ and `<SnapTourHandler/>` mounted.
 *
 * See docs/tour.md for the full architecture.
 */

export interface TourOptions {
	/** Slug of the project, must match the bridge's hello.projectId. */
	projectId: string;
	/** Override the snap-server URL. Defaults to env SNAP_BASE_URL or localhost:9876. */
	baseUrl?: string;
	/** Per-step timeout in ms. Defaults to 20s. */
	timeoutMs?: number;
	/** Optional logger. Defaults to console.log. */
	log?: (msg: string) => void;
}

export interface NavigateResult {
	projectId: string;
	/** The route the bridge actually ended up on. */
	route: string;
	stateHash?: string;
	settleMs?: number;
	/**
	 * Present when the bridge (v0.8.2+) detected a redirect after the
	 * requested `goto` — e.g. an AuthGate replaced `/home` with `/splash`
	 * before settle. `route` holds the final pathname, `requestedRoute`
	 * holds the original request. Older bridges always ack the requested
	 * route and never set this — absence is NOT proof a redirect didn't
	 * happen.
	 */
	requestedRoute?: string;
	redirected?: boolean;
}

export interface SnapResult {
	record: Record<string, unknown>;
}

export interface BridgeStatus {
	bridges: Array<{
		projectId: string;
		connectedAt: number;
		declaredFlows: unknown;
	}>;
}

/**
 * One entry in `tour.run([...])`. Either a bare route string, or a
 * `[route, params]` tuple — params expand `:foo` placeholders.
 */
export type TourStep =
	| string
	| [string, Record<string, string | number>]
	| {
			route: string;
			params?: Record<string, string | number>;
			label?: string;
			flowId?: string;
			/** Skip the snap on this step — useful for transient screens. */
			skipSnap?: boolean;
	  };

export class Tour {
	readonly projectId: string;
	readonly baseUrl: string;
	readonly timeoutMs: number;
	private readonly log: (msg: string) => void;

	constructor(opts: TourOptions) {
		this.projectId = opts.projectId;
		this.baseUrl =
			opts.baseUrl ??
			(typeof process !== "undefined" && process.env?.SNAP_BASE_URL) ??
			"http://localhost:9876";
		this.timeoutMs = opts.timeoutMs ?? 20000;
		this.log = opts.log ?? ((m) => console.log(m));
	}

	/**
	 * Navigate to `route`, substituting any `:param` placeholders with values
	 * from `params`. Resolves once the bridge fires its `ready` ack.
	 */
	async goto(
		route: string,
		params?: Record<string, string | number>,
	): Promise<NavigateResult> {
		const expanded = expandRoute(route, params);
		const r = await this.post("/tour/goto", {
			projectId: this.projectId,
			route: expanded,
			params: params ?? {},
			timeoutMs: this.timeoutMs,
		});
		if (!r.ok) throw new Error(`tour.goto("${expanded}"): ${r.error}`);
		return {
			projectId: r.projectId as string,
			route: r.route as string,
			stateHash: r.stateHash as string | undefined,
			settleMs: r.settleMs as number | undefined,
			requestedRoute: r.requestedRoute as string | undefined,
			redirected: r.redirected as boolean | undefined,
		};
	}

	/**
	 * Snap the current screen via the running orchestrator. The snap lands
	 * in the Capture app's current session and shows up in the gallery
	 * immediately.
	 */
	async snap(opts?: { flowId?: string; label?: string }): Promise<SnapResult> {
		const r = await this.post("/tour/snap", {
			projectId: this.projectId,
			flowId: opts?.flowId,
			label: opts?.label,
		});
		if (!r.ok) throw new Error(`tour.snap(): ${r.error}`);
		return { record: r.record as Record<string, unknown> };
	}

	/** Returns the snap-server's view of connected bridges. */
	async status(): Promise<BridgeStatus> {
		const r = await fetch(`${this.baseUrl}/tour/status`);
		if (!r.ok) {
			throw new Error(`tour.status(): HTTP ${r.status}`);
		}
		return (await r.json()) as BridgeStatus;
	}

	/**
	 * Returns the declared flows the bridge announced in its `hello`. Useful
	 * if you want the tour to be self-driving: `await tour.run(await tour.routesFromFlows())`.
	 */
	async flows(): Promise<
		Array<{ id: string; screens?: Array<{ route: string }> }>
	> {
		const r = await fetch(
			`${this.baseUrl}/tour/flows?projectId=${encodeURIComponent(this.projectId)}`,
		);
		if (!r.ok) {
			const body = await safeJson(r);
			throw new Error(
				`tour.flows(): ${body?.error ?? `HTTP ${r.status}`} — is the bridge connected?`,
			);
		}
		const body = (await r.json()) as {
			ok: boolean;
			flows: Array<{ id: string; screens?: Array<{ route: string }> }>;
		};
		return body.flows ?? [];
	}

	/**
	 * Convenience: extracts every route from the declared flows in order.
	 * Use as a fallback when you don't want to hand-list routes.
	 */
	async routesFromFlows(): Promise<string[]> {
		const flows = await this.flows();
		const routes: string[] = [];
		const walk = (
			items: Array<{
				id?: string;
				screens?: Array<{ route: string }>;
				flows?: Array<unknown>;
			}>,
		) => {
			for (const f of items) {
				for (const s of f.screens ?? []) {
					if (s.route) routes.push(s.route);
				}
				if (f.flows) walk(f.flows as never);
			}
		};
		walk(flows);
		return routes;
	}

	/**
	 * Walk a list of steps. For each: goto → snap (unless skipSnap). Stops
	 * at the first error and re-throws — wrap in try/catch if you want to
	 * keep going.
	 *
	 * `failOnRedirect`: when the bridge (v0.8.2+) reports a redirect between
	 * the requested route and the final pathname (e.g. AuthGate sent
	 * `/home` → `/splash`), throw instead of snapping. Default warns and
	 * continues — the snap will show the redirected screen, which is at
	 * least truthful. Strict tours should enable this.
	 */
	async run(
		steps: TourStep[],
		opts: { failOnRedirect?: boolean } = {},
	): Promise<void> {
		let i = 0;
		for (const step of steps) {
			i++;
			const norm = normalizeStep(step);
			this.log(`[${i}/${steps.length}] goto ${norm.route}`);
			try {
				const nav = await this.goto(norm.route, norm.params);
				if (nav.redirected) {
					const note = `redirected ${nav.requestedRoute ?? norm.route} → ${nav.route}`;
					if (opts.failOnRedirect) {
						throw new Error(note);
					}
					this.log(`  ⚠ ${note}`);
				}
				if (norm.skipSnap) continue;
				const snap = await this.snap({
					flowId: norm.flowId,
					label: norm.label,
				});
				this.log(
					`  ✓ snap ${nav.route}${nav.settleMs ? ` (settle ${nav.settleMs}ms)` : ""} → ${
						(snap.record.image as string | undefined) ?? "?"
					}`,
				);
			} catch (err) {
				this.log(`  ✗ ${(err as Error).message}`);
				throw err;
			}
		}
	}

	private async post(
		path: string,
		body: unknown,
	): Promise<Record<string, unknown>> {
		const r = await fetch(`${this.baseUrl}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const json = (await safeJson(r)) as Record<string, unknown> | null;
		if (!json) {
			throw new Error(`${path}: HTTP ${r.status} (no JSON body)`);
		}
		return json;
	}
}

function normalizeStep(step: TourStep): {
	route: string;
	params?: Record<string, string | number>;
	label?: string;
	flowId?: string;
	skipSnap?: boolean;
} {
	if (typeof step === "string") return { route: step };
	if (Array.isArray(step)) return { route: step[0], params: step[1] };
	return step;
}

/**
 * Substitute `:foo` placeholders in `route` with values from `params`.
 * Missing params are left as-is (the bridge may have its own defaulting).
 */
export function expandRoute(
	route: string,
	params?: Record<string, string | number>,
): string {
	if (!params) return route;
	return route.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (full, name) => {
		const v = params[name];
		return v === undefined ? full : String(v);
	});
}

async function safeJson(r: Response): Promise<unknown | null> {
	try {
		return await r.json();
	} catch {
		return null;
	}
}
