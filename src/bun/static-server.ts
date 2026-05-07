import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { RECORDER_SCRIPT } from "../lib/recorder-script";
import { RUNNER_SCRIPT } from "../lib/runner-script";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".map": "application/json",
	".txt": "text/plain; charset=utf-8",
};

export interface StaticServer {
	port: number;
	url: string;
	stop: () => void;
}

export function createStaticServer(rootDir: string): StaticServer {
	const root = resolve(rootDir);

	const server = Bun.serve({
		port: 0,
		fetch(req) {
			let url = decodeURIComponent(new URL(req.url).pathname);
			if (url === "/") url = "/index.html";

			const candidate = normalize(join(root, url));
			if (!candidate.startsWith(root))
				return new Response("Forbidden", { status: 403 });

			const inject = true;

			const tryFile = (p: string): Response | null => {
				try {
					const st = statSync(p);
					if (st.isDirectory()) return tryFile(join(p, "index.html"));
					const ext = extname(p);
					const mime = MIME[ext] || "application/octet-stream";
					let content: Buffer | string = readFileSync(p);
					if (inject && (ext === ".html" || ext === ".htm")) {
						const html = content.toString("utf-8");
						const tag = `<script>${RECORDER_SCRIPT}</script><script>${RUNNER_SCRIPT}</script>`;
						content = html.includes("</body>")
							? html.replace("</body>", `${tag}</body>`)
							: html + tag;
					}
					return new Response(content as any, {
						status: 200,
						headers: {
							"Content-Type": mime,
							"Access-Control-Allow-Origin": "*",
							"Cache-Control": "no-cache",
						},
					});
				} catch {
					return null;
				}
			};

			const direct = tryFile(candidate);
			if (direct) return direct;
			if (!extname(url)) {
				const fallback = tryFile(join(root, "index.html"));
				if (fallback) return fallback;
			}
			return new Response("Not Found", {
				status: 404,
				headers: { "Content-Type": "text/plain" },
			});
		},
	});

	const port = server.port ?? 0;
	return {
		port,
		url: `http://localhost:${port}`,
		stop: () => server.stop(true),
	};
}
