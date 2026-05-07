import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ApplicationMenu,
	BrowserView,
	BrowserWindow,
	Utils,
} from "electrobun/bun";
import type { ScenarioRunnerRPC } from "../lib/rpc";
import { validateDeviceConfig, validateScenario } from "../lib/schemas";
import { captureRect } from "./screencapture";
import { resolveSource } from "./sources";

const DBG_LOG = "/tmp/prisma-debug.log";
const dbg = (m: string) => {
	try {
		appendFileSync(DBG_LOG, `[${new Date().toISOString()}] ${m}\n`);
	} catch {}
	console.log(m);
};

process.on("uncaughtException", (e) => dbg(`UNCAUGHT: ${e?.stack || e}`));
process.on("unhandledRejection", (e: any) =>
	dbg(`UNHANDLED: ${e?.stack || e}`),
);

dbg(`prisma starting cwd=${process.cwd()}`);

// Resolve the bundle root so config files work both in dev (cwd=project) and packaged (cwd=.app/MacOS).
function bundleRoot(): string {
	try {
		// In .app: this file lives at Contents/Resources/app/bun/index.js → Resources/app is the right anchor
		const here = dirname(fileURLToPath(import.meta.url));
		const candidates = [
			resolve(here, ".."), // → Resources/app (samples next to bun/)
			resolve(here, "../.."), // → Resources
			process.cwd(),
		];
		for (const c of candidates) {
			if (existsSync(join(c, "samples"))) return c;
		}
		return process.cwd();
	} catch {
		return process.cwd();
	}
}
const ROOT = bundleRoot();
dbg(`ROOT=${ROOT}`);

function screenshotsDir(): string {
	const dir = join(process.cwd(), "screenshots-output");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

let currentSourceCleanup: (() => void) | null = null;
function freeCurrentSource(): void {
	if (currentSourceCleanup) {
		try {
			currentSourceCleanup();
		} catch (e: any) {
			dbg(`source cleanup err: ${e?.message}`);
		}
		currentSourceCleanup = null;
	}
}

const rpc = BrowserView.defineRPC<ScenarioRunnerRPC>({
	maxRequestTime: 600000,
	handlers: {
		requests: {
			resolveSource: async (input) => {
				freeCurrentSource();
				const r = await resolveSource(input);
				if (!r.ok) return { ok: false, error: r.error };
				currentSourceCleanup = r.value.cleanup;
				return { ok: true, baseUrl: r.value.baseUrl, entry: r.value.entry };
			},
			cleanupSources: async () => {
				freeCurrentSource();
				return { ok: true };
			},
			pickPath: async () => {
				try {
					const paths = await Utils.openFileDialog({
						canChooseFiles: true,
						canChooseDirectory: true,
						allowsMultipleSelection: false,
						allowedFileTypes: "*",
					});
					if (!paths.length || !paths[0])
						return { ok: false, error: "Canceled" };
					const p = paths[0];
					const lower = p.toLowerCase();
					const isArchive =
						lower.endsWith(".zip") ||
						lower.endsWith(".tar") ||
						lower.endsWith(".tar.gz") ||
						lower.endsWith(".tgz");
					return {
						ok: true,
						path: p,
						inferredKind: isArchive ? "archive" : "folder",
					};
				} catch (e: any) {
					return { ok: false, error: e?.message || "Picker failed" };
				}
			},
			validateScenario: async ({ yaml }) => {
				const r = validateScenario(yaml);
				return r.ok
					? { ok: true, value: r.value }
					: { ok: false, error: r.error };
			},
			validateDevices: async ({ yaml }) => {
				const r = validateDeviceConfig(yaml);
				return r.ok
					? { ok: true, value: r.value }
					: { ok: false, error: r.error };
			},
			captureRect: async ({ x, y, width, height, name }) => {
				const r = captureRect({ x, y, width, height }, screenshotsDir(), name);
				return r.ok
					? { ok: true, path: r.path }
					: { ok: false, error: r.error };
			},
			getConfig: async () => {
				const read = (rel: string) => {
					for (const base of [ROOT, process.cwd(), join(ROOT, "Resources")]) {
						try {
							return readFileSync(join(base, rel), "utf-8");
						} catch {}
					}
					return "";
				};
				return {
					devicesYaml: read("samples/devices.yaml"),
					scenarioYaml: read("samples/scenarios.yaml"),
				};
			},
		},
		messages: {},
	},
});

// Standard macOS menu — required for Cmd+C/V/X/Z/A keystrokes to work in inputs.
try {
	ApplicationMenu.setApplicationMenu([
		{
			label: "Prisma",
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "pasteAndMatchStyle" },
				{ role: "delete" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "toggleFullScreen" },
			],
		},
		{
			label: "Window",
			submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
		},
	] as any);
	dbg("ApplicationMenu set");
} catch (e: any) {
	dbg(`ApplicationMenu err: ${e?.message}`);
}

dbg("creating BrowserWindow…");
let _win: BrowserWindow | null = null;
try {
	_win = new BrowserWindow({
		title: "Prisma",
		url: "views://mainview/index.html",
		frame: { x: 0, y: 0, width: 1440, height: 900 },
		rpc,
	});
	dbg(`BrowserWindow created id=${_win?.id}`);
} catch (e: any) {
	dbg(`BrowserWindow FAILED: ${e?.stack || e}`);
}

process.on("exit", () => freeCurrentSource());
