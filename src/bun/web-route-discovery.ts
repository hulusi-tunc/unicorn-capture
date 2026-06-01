/**
 * Crawl a web base URL to discover internal routes. Mirrors what the
 * web wizard does during Phase 2: the user gives a base URL, we
 * surface what paths exist on the site so they can preview the
 * auto-generated flow grouping before committing.
 *
 * Implementation: server-side fetch (no CORS), regex-based HTML parse
 * (cheap, no jsdom). Two-level crawl: fetch base, extract internal
 * <a href> links, then for each unique path fetch ONCE more to grab
 * its <title> for the flow preview. SPAs without server-rendered HTML
 * return just "/" with a hint so the UI can suggest manual entry.
 *
 * Hard caps:
 *   - 50 routes total (`limit` param overrides up to a ceiling)
 *   - 2000ms per fetch (long-running customer sites shouldn't stall
 *     the wizard)
 *   - 12 concurrent fetches max
 */

const FETCH_TIMEOUT_MS = 2000;
const MAX_CONCURRENT_FETCHES = 12;
const HARD_LIMIT = 200;
// ASCII-only — Bun's fetch rejects non-ASCII bytes (e.g. em-dash) in header values.
const USER_AGENT =
	"UnicornCapture/1.0 (+https://unicorn-studio.com) route-discovery";

export interface RouteDiscoveryResult {
	baseUrl: string;
	routes: Array<{ path: string; title?: string }>;
	skipped: number;
	hint: "ok" | "spa" | "auth-wall" | "blocked";
}

export async function discoverWebRoutes(
	baseUrlRaw: string,
	limit: number,
): Promise<RouteDiscoveryResult> {
	let baseUrl: URL;
	try {
		baseUrl = new URL(baseUrlRaw);
	} catch {
		throw new Error("Base URL is not a valid URL.");
	}
	const cap = Math.min(limit, HARD_LIMIT);

	const rootHtml = await fetchText(baseUrl.toString());
	if (rootHtml === null) {
		return {
			baseUrl: baseUrl.toString(),
			routes: [],
			skipped: 0,
			hint: "blocked",
		};
	}
	if (looksLikeAuthWall(rootHtml)) {
		// Still try to extract links; the wall might link to other
		// pre-auth marketing pages.
	}

	const rootPath = pathOf(baseUrl);
	const rootTitle = extractTitle(rootHtml) ?? undefined;
	const collected = new Map<string, { path: string; title?: string }>();
	collected.set(rootPath, { path: rootPath, title: rootTitle });

	const { paths, skipped } = extractInternalLinks(rootHtml, baseUrl);
	const candidates = paths.filter((p) => p !== rootPath).slice(0, cap - 1);

	if (candidates.length === 0) {
		// No links at all → almost certainly an SPA hiding everything
		// behind JS, OR a single-page marketing site.
		return {
			baseUrl: baseUrl.toString(),
			routes: [...collected.values()],
			skipped,
			hint: paths.length === 0 ? "spa" : "ok",
		};
	}

	// Bounded concurrency — Bun's fetch is async-ready but we don't
	// want to hammer the target site with 50 parallel requests.
	const titles = new Map<string, string | undefined>();
	const queue = [...candidates];
	const workers: Promise<void>[] = [];
	for (let i = 0; i < Math.min(MAX_CONCURRENT_FETCHES, queue.length); i++) {
		workers.push(
			(async () => {
				while (queue.length > 0) {
					const path = queue.shift();
					if (!path) break;
					const url = new URL(path, baseUrl.toString()).toString();
					const html = await fetchText(url);
					titles.set(path, html ? extractTitle(html) : undefined);
				}
			})(),
		);
	}
	await Promise.all(workers);

	for (const path of candidates) {
		collected.set(path, { path, title: titles.get(path) ?? undefined });
	}

	const sorted = [...collected.values()].sort((a, b) => a.path.localeCompare(b.path));
	return {
		baseUrl: baseUrl.toString(),
		routes: sorted,
		skipped,
		hint: "ok",
	};
}

/**
 * Fetch a URL with a timeout. Returns null on any network / non-2xx
 * outcome — caller decides whether that's a hard failure or just a
 * "skip this URL" event.
 */
async function fetchText(url: string): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: {
				"user-agent": USER_AGENT,
				accept: "text/html,application/xhtml+xml",
			},
			redirect: "follow",
		});
		if (!res.ok) return null;
		const ct = res.headers.get("content-type") ?? "";
		if (!ct.includes("html") && !ct.includes("xml")) return null;
		const txt = await res.text();
		// Cap body size — some sites return huge generated SPAs and we
		// only need the head + a few link-laden tags.
		return txt.length > 1_500_000 ? txt.slice(0, 1_500_000) : txt;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function pathOf(url: URL): string {
	const p = url.pathname || "/";
	return p === "" ? "/" : p;
}

const TITLE_RE = /<title[^>]*>([^<]+)<\/title>/i;
function extractTitle(html: string): string | null {
	const m = TITLE_RE.exec(html);
	if (!m?.[1]) return null;
	const raw = m[1].trim();
	return raw.length === 0 ? null : raw.slice(0, 140);
}

const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
function extractInternalLinks(
	html: string,
	baseUrl: URL,
): { paths: string[]; skipped: number } {
	const seen = new Set<string>();
	let skipped = 0;
	let match: RegExpExecArray | null;
	HREF_RE.lastIndex = 0;
	while ((match = HREF_RE.exec(html))) {
		const raw = match[1] ?? match[2] ?? match[3];
		if (!raw) continue;
		const trimmed = raw.trim();
		if (
			!trimmed ||
			trimmed.startsWith("#") ||
			trimmed.startsWith("mailto:") ||
			trimmed.startsWith("tel:") ||
			trimmed.startsWith("javascript:")
		) {
			skipped += 1;
			continue;
		}
		let target: URL;
		try {
			target = new URL(trimmed, baseUrl.toString());
		} catch {
			skipped += 1;
			continue;
		}
		// Same-origin filter — refs to docs.example.com or external
		// sites are noise for flow grouping.
		if (target.origin !== baseUrl.origin) {
			skipped += 1;
			continue;
		}
		// Drop query + hash so /products?sort=asc and /products#reviews
		// collapse to /products. Capture's stateHash will differentiate
		// later if the designer wants per-filter variants.
		const path = target.pathname || "/";
		seen.add(path);
	}
	return { paths: [...seen], skipped };
}

function looksLikeAuthWall(html: string): boolean {
	const lower = html.toLowerCase();
	return (
		(lower.includes("sign in") ||
			lower.includes("log in") ||
			lower.includes("login")) &&
		(lower.includes("password") || lower.includes("email")) &&
		lower.length < 80_000
	);
}
