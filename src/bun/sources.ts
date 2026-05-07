import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { SourceInput } from "../lib/rpc";
import type { Result } from "../lib/schemas";
import { detectEntry } from "./entry-detector";
import { createStaticServer, type StaticServer } from "./static-server";

export interface ResolvedSource {
	baseUrl: string;
	entry?: string;
	cleanup: () => void;
}

function extractArchive(archivePath: string): Result<string> {
	const tmp = mkdtempSync(join(tmpdir(), "scenrun-"));
	const ext = extname(archivePath).toLowerCase();
	const lower = archivePath.toLowerCase();

	let cmd: string[];
	if (ext === ".zip") cmd = ["unzip", "-q", "-o", archivePath, "-d", tmp];
	else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz"))
		cmd = ["tar", "-xzf", archivePath, "-C", tmp];
	else if (ext === ".tar") cmd = ["tar", "-xf", archivePath, "-C", tmp];
	else {
		rmSync(tmp, { recursive: true, force: true });
		return { ok: false, error: `Unsupported archive: ${ext}` };
	}

	const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "pipe" });
	if (r.status !== 0) {
		rmSync(tmp, { recursive: true, force: true });
		return {
			ok: false,
			error: `Extract failed: ${r.stderr?.toString() || "unknown"}`,
		};
	}
	return { ok: true, value: tmp };
}

export async function resolveSource(
	src: SourceInput,
): Promise<Result<ResolvedSource>> {
	if (src.kind === "url") {
		try {
			new URL(src.url);
		} catch {
			return { ok: false, error: `Invalid URL: ${src.url}` };
		}
		return { ok: true, value: { baseUrl: src.url, cleanup: () => {} } };
	}

	let rootDir: string;
	let cleanupTmp: (() => void) | null = null;

	if (src.kind === "archive") {
		if (!existsSync(src.path))
			return { ok: false, error: `Archive not found: ${src.path}` };
		const ex = extractArchive(src.path);
		if (!ex.ok) return ex;
		rootDir = ex.value;
		cleanupTmp = () => rmSync(rootDir, { recursive: true, force: true });
	} else {
		if (!existsSync(src.path))
			return { ok: false, error: `Folder not found: ${src.path}` };
		rootDir = src.path;
	}

	const entry = detectEntry(rootDir);
	if (!entry.ok) {
		cleanupTmp?.();
		return entry;
	}

	// Rebase server root to entry's containing dir so absolute /asset paths inside HTML resolve.
	// e.g. archive contains dist/index.html → serve from <tmp>/dist, entry = "index.html".
	const entryDir = dirname(entry.value);
	const serveRoot = entryDir === "." ? rootDir : join(rootDir, entryDir);
	const entryFile = basename(entry.value);

	let server: StaticServer;
	try {
		server = createStaticServer(serveRoot);
	} catch (e: any) {
		cleanupTmp?.();
		return { ok: false, error: `Server start failed: ${e.message}` };
	}

	return {
		ok: true,
		value: {
			baseUrl: server.url,
			entry: entryFile,
			cleanup: () => {
				server.stop();
				cleanupTmp?.();
			},
		},
	};
}
