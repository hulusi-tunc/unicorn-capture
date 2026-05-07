import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Result } from "../lib/schemas";

const FRAMEWORK_HINTS: Array<{
	name: string;
	deps: string[];
	build: string;
	outDir: string[];
}> = [
	{
		name: "Next.js",
		deps: ["next"],
		build: "next build && next export",
		outDir: ["out", ".next/out"],
	},
	{ name: "Vite", deps: ["vite"], build: "vite build", outDir: ["dist"] },
	{
		name: "Create React App",
		deps: ["react-scripts"],
		build: "react-scripts build",
		outDir: ["build"],
	},
	{
		name: "Angular",
		deps: ["@angular/cli"],
		build: "ng build",
		outDir: ["dist"],
	},
	{
		name: "SvelteKit",
		deps: ["@sveltejs/kit"],
		build: "vite build",
		outDir: ["build", ".svelte-kit/output"],
	},
	{
		name: "Nuxt",
		deps: ["nuxt"],
		build: "nuxt generate",
		outDir: ["dist", ".output/public"],
	},
	{ name: "Astro", deps: ["astro"], build: "astro build", outDir: ["dist"] },
	{
		name: "Vue CLI",
		deps: ["@vue/cli-service"],
		build: "vue-cli-service build",
		outDir: ["dist"],
	},
];

function detectFramework(
	rootDir: string,
): { name: string; build: string; outDir: string[] } | null {
	for (const sub of [".", "apps", "packages"]) {
		const base = sub === "." ? rootDir : join(rootDir, sub);
		if (!existsSync(base)) continue;
		const entries =
			sub === "."
				? [base]
				: (() => {
						try {
							return readdirSync(base).map((d) => join(base, d));
						} catch {
							return [];
						}
					})();
		for (const dir of entries) {
			const pkg = join(dir, "package.json");
			if (!existsSync(pkg)) continue;
			try {
				const json = JSON.parse(readFileSync(pkg, "utf-8"));
				const allDeps = {
					...(json.dependencies || {}),
					...(json.devDependencies || {}),
				};
				for (const fw of FRAMEWORK_HINTS) {
					if (fw.deps.some((d) => allDeps[d])) return fw;
				}
			} catch {}
		}
	}
	return null;
}

function walk(
	dir: string,
	root: string,
	out: string[] = [],
	depth = 0,
	max = 6,
): string[] {
	if (depth > max) return out;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.startsWith(".") || e === "node_modules") continue;
		const full = join(dir, e);
		try {
			const st = statSync(full);
			if (st.isDirectory()) walk(full, root, out, depth + 1, max);
			else out.push(relative(root, full));
		} catch {}
	}
	return out;
}

export function detectEntry(dir: string): Result<string> {
	const files = walk(dir, dir);
	if (!files.length) return { ok: false, error: `Empty directory: ${dir}` };

	const score = (f: string): number => {
		const lower = f.toLowerCase();
		const depth = f.split(/[\\/]/).length - 1;
		if (lower === "index.html" || lower === "index.htm") return 1000 - depth;
		if (lower.endsWith("/index.html") || lower.endsWith("/index.htm"))
			return 800 - depth;
		if (lower === "main.html" || lower === "app.html") return 600 - depth;
		if (lower.endsWith(".html") || lower.endsWith(".htm")) return 400 - depth;
		return 0;
	};

	const ranked = files
		.map((f) => ({ f, s: score(f) }))
		.filter((x) => x.s > 0)
		.sort((a, b) => b.s - a.s);
	if (!ranked.length) {
		const fw = detectFramework(dir);
		if (fw) {
			return {
				ok: false,
				error: `This looks like a ${fw.name} source project (no built HTML found). Please build it first:\n\n  ${fw.build}\n\nThen point Scenario Runner at the output folder (typically ./${fw.outDir[0]}) or zip it up.`,
			};
		}
		return {
			ok: false,
			error: `No HTML entry found in ${dir}. If this is source code (TS/JSX), build it first and try the output directory.`,
		};
	}
	return { ok: true, value: ranked[0].f };
}
