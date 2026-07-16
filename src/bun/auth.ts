import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GALLERY_URL, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

/**
 * Signed-in user session for Capture. Stored on disk so the desktop app stays
 * signed in across restarts. The tokens are Supabase GoTrue tokens obtained via
 * the password grant; the access token is sent as a Bearer to the gallery's
 * user-scoped endpoints (/api/projects/mine, /api/projects).
 *
 * NOTE: this file lives in ~/Library/Application Support and contains a refresh
 * token. That's the same trust level as a browser keeping a Supabase session in
 * localStorage. If we later want hardening, move tokens into the macOS Keychain.
 */
export interface CaptureSession {
	accessToken: string;
	refreshToken: string;
	/** Epoch SECONDS at which the access token expires (from GoTrue). */
	expiresAt: number;
	userId: string;
	email: string;
	role: "agency" | "customer";
	/** True for the single studio owner — sees every project. */
	isOwner: boolean;
	signedInAt: string;
}

/** A project the signed-in user may work on, as returned by /api/projects/mine. */
export interface AssignedProject {
	id: string;
	slug: string;
	name: string;
	platform: string;
	projectToken: string | null;
	previewImageUrl: string | null;
	accentColor: string | null;
	createdAt: string;
}

export interface MineUser {
	id: string;
	email: string;
	role: "agency" | "customer";
	isOwner: boolean;
}

interface MineResponse {
	user: MineUser;
	projects: AssignedProject[];
}

interface GrantOk {
	access_token: string;
	refresh_token: string;
	/** Epoch seconds. */
	expires_at: number;
	user: { id: string; email?: string };
}

export function sessionPath(): string {
	return join(
		homedir(),
		"Library",
		"Application Support",
		"UnicornCapture",
		"session.json",
	);
}

export function loadSession(): CaptureSession | null {
	const p = sessionPath();
	if (!existsSync(p)) return null;
	try {
		const s = JSON.parse(readFileSync(p, "utf8"));
		if (
			s &&
			typeof s.accessToken === "string" &&
			typeof s.refreshToken === "string" &&
			typeof s.userId === "string"
		) {
			return s as CaptureSession;
		}
		return null;
	} catch {
		return null;
	}
}

export function saveSession(s: CaptureSession): void {
	const p = sessionPath();
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, `${JSON.stringify(s, null, 2)}\n`, "utf8");
}

export function clearSession(): void {
	const p = sessionPath();
	try {
		if (existsSync(p)) rmSync(p, { force: true });
	} catch {
		// best effort
	}
}

/** POST to GoTrue's token endpoint (password or refresh_token grant). */
async function tokenGrant(
	grantType: "password" | "refresh_token",
	body: Record<string, unknown>,
): Promise<GrantOk | { error: string }> {
	let resp: Response;
	try {
		resp = await fetch(
			`${SUPABASE_URL}/auth/v1/token?grant_type=${grantType}`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					apikey: SUPABASE_ANON_KEY,
					authorization: `Bearer ${SUPABASE_ANON_KEY}`,
				},
				body: JSON.stringify(body),
			},
		);
	} catch (err) {
		return {
			error: `Could not reach the sign-in server: ${(err as Error).message}`,
		};
	}
	const text = await resp.text();
	// biome-ignore lint/suspicious/noExplicitAny: GoTrue JSON is loosely typed.
	let json: any;
	try {
		json = JSON.parse(text);
	} catch {
		return { error: `Unexpected sign-in response (${resp.status}).` };
	}
	if (!resp.ok) {
		return {
			error:
				json.error_description ||
				json.msg ||
				json.error ||
				`Sign-in failed (${resp.status}).`,
		};
	}
	if (!json.access_token || !json.refresh_token) {
		return { error: "Sign-in succeeded but no session was returned." };
	}
	return json as GrantOk;
}

/** GET /api/projects/mine with a user access token. */
async function fetchMine(
	accessToken: string,
): Promise<MineResponse | { status: number; error: string }> {
	let resp: Response;
	try {
		resp = await fetch(`${GALLERY_URL}/api/projects/mine`, {
			headers: { authorization: `Bearer ${accessToken}` },
		});
	} catch (err) {
		return {
			status: 0,
			error: `Could not reach the gallery: ${(err as Error).message}`,
		};
	}
	const text = await resp.text();
	// biome-ignore lint/suspicious/noExplicitAny: gallery JSON is loosely typed.
	let json: any;
	try {
		json = JSON.parse(text);
	} catch {
		return {
			status: resp.status,
			error: `Unexpected gallery response (${resp.status}).`,
		};
	}
	if (!resp.ok) {
		return {
			status: resp.status,
			error: json.error || `Gallery error (${resp.status}).`,
		};
	}
	return json as MineResponse;
}

/**
 * Sign in with email + password. On success persists the session and returns
 * it together with the initial assigned-project list. If the credentials are
 * valid but the account can't use Capture (e.g. not a studio member), the
 * gallery's message is surfaced as the error.
 */
export async function signIn(
	email: string,
	password: string,
): Promise<
	| { ok: true; session: CaptureSession; projects: AssignedProject[] }
	| { ok: false; error: string }
> {
	const cleanEmail = email.trim().toLowerCase();
	if (!cleanEmail || !password) {
		return { ok: false, error: "Email and password are required." };
	}

	const grant = await tokenGrant("password", {
		email: cleanEmail,
		password,
	});
	if ("error" in grant) return { ok: false, error: grant.error };

	const mine = await fetchMine(grant.access_token);
	if ("error" in mine) return { ok: false, error: mine.error };

	const session: CaptureSession = {
		accessToken: grant.access_token,
		refreshToken: grant.refresh_token,
		expiresAt: grant.expires_at,
		userId: mine.user.id,
		email: mine.user.email || cleanEmail,
		role: mine.user.role,
		isOwner: mine.user.isOwner,
		signedInAt: new Date().toISOString(),
	};
	saveSession(session);
	return { ok: true, session, projects: mine.projects };
}

/**
 * Return a non-expired access token, refreshing it if needed. Returns null if
 * there is no session or the refresh failed (caller should force re-sign-in).
 */
export async function getValidAccessToken(): Promise<string | null> {
	const s = loadSession();
	if (!s) return null;
	const nowSec = Math.floor(Date.now() / 1000);
	if (s.expiresAt - nowSec > 60) return s.accessToken;

	const grant = await tokenGrant("refresh_token", {
		refresh_token: s.refreshToken,
	});
	if ("error" in grant) {
		clearSession();
		return null;
	}
	saveSession({
		...s,
		accessToken: grant.access_token,
		refreshToken: grant.refresh_token,
		expiresAt: grant.expires_at,
	});
	return grant.access_token;
}

/**
 * Fetch the projects assigned to the signed-in user (owner → all). Refreshes
 * the token if needed and keeps the stored session's role/isOwner fresh.
 */
export async function listAssignedProjects(): Promise<
	| { ok: true; user: MineUser; projects: AssignedProject[] }
	| { ok: false; error: string; needsSignIn?: boolean }
> {
	const token = await getValidAccessToken();
	if (!token) {
		return {
			ok: false,
			error: "Your session has expired. Please sign in again.",
			needsSignIn: true,
		};
	}
	const mine = await fetchMine(token);
	if ("error" in mine) {
		return { ok: false, error: mine.error, needsSignIn: mine.status === 401 };
	}
	const s = loadSession();
	if (s) {
		saveSession({
			...s,
			role: mine.user.role,
			isOwner: mine.user.isOwner,
			email: mine.user.email || s.email,
		});
	}
	return { ok: true, user: mine.user, projects: mine.projects };
}
