#!/usr/bin/env bun
import { resolve } from "node:path";
import { createSnapOrchestrator } from "./snap-orchestrator";
import { startSnapServer } from "./snap-server";
import { uploadSession } from "./upload";

const PORT = Number(process.env.SNAP_PORT ?? 9876);
const OUT_DIR = resolve(process.cwd(), process.env.SNAP_OUT ?? "snaps");
const UPLOAD_URL = process.env.SNAP_UPLOAD_URL;
const UPLOAD_TOKEN = process.env.SNAP_UPLOAD_TOKEN;

const server = startSnapServer({
	port: PORT,
	log: () => {}, // suppress server chatter; we render our own status line
});

const orch = await createSnapOrchestrator({
	server,
	outDir: OUT_DIR,
});

console.log("Unicorn Studio — RN snap mode");
console.log(`  port:    ws://localhost:${PORT}`);
console.log(`  out:     ${OUT_DIR}`);
console.log(`  session: ${orch.sessionId}`);
if (UPLOAD_URL && UPLOAD_TOKEN) {
	console.log(`  upload:  ${UPLOAD_URL}`);
} else if (UPLOAD_URL || UPLOAD_TOKEN) {
	console.log(
		"  upload:  \x1b[33mDISABLED — set BOTH SNAP_UPLOAD_URL and SNAP_UPLOAD_TOKEN to enable\x1b[0m",
	);
} else {
	console.log("  upload:  disabled (local-only)");
}
console.log("");
console.log(
	"Press SPACE to snap, U to upload now (keep going), Q to upload+quit.",
);
console.log(
	"Make sure your RN app is running with @unicorn-studio/snap-bridge.",
);
console.log("");

let busy = false;
let connectedProjects: string[] = [];

function refreshStatus(): void {
	connectedProjects = server
		.clients()
		.map((c) => c.projectId)
		.filter(Boolean);
}

setInterval(refreshStatus, 250);

let lastStatus = "";
function renderStatus(): void {
	const n = server.clientCount();
	const projs = connectedProjects.length
		? connectedProjects.join(", ")
		: "(none)";
	const status =
		n > 0
			? `\x1b[32m●\x1b[0m bridge connected — ${projs}`
			: "\x1b[33m○\x1b[0m waiting for bridge…";
	if (status !== lastStatus) {
		process.stdout.write(`\r${" ".repeat(80)}\r${status}\n`);
		lastStatus = status;
	}
}

setInterval(renderStatus, 500);

// Single-key stdin
const stdin = process.stdin;
if (!stdin.isTTY) {
	console.log(
		"(stdin is not a TTY — interactive controls disabled. snaps only via SIGUSR1.)",
	);
} else {
	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");
	stdin.on("data", async (raw) => {
		const c = raw.toString();
		if (c === "q" || c === "Q" || c === "") {
			await finishSession();
			console.log("👋 bye");
			server.stop();
			process.exit(0);
		}
		if (c === " " || c === "\r" || c === "s" || c === "S") {
			await doSnap();
		}
		if (c === "u" || c === "U") {
			await finishSession({ keepAlive: true });
		}
	});
}

// Also allow snapping via SIGUSR1 — handy for menu-bar apps later.
process.on("SIGUSR1", () => void doSnap());

async function doSnap(): Promise<void> {
	if (busy) return;
	busy = true;
	if (server.clientCount() === 0) {
		console.log("\x1b[31m✗\x1b[0m no bridge connected — snap skipped");
		busy = false;
		return;
	}
	process.stdout.write("snapping… ");
	const r = await orch.snap();
	if (r.ok) {
		const r2 = r.record;
		console.log(
			`\x1b[32m✓\x1b[0m #${r2.sequence}  ${r2.route}  [${r2.stateHash}]  → ${r2.image}`,
		);
	} else {
		console.log(`\x1b[31m✗\x1b[0m ${r.error}`);
	}
	busy = false;
}

async function finishSession(
	opts: { keepAlive?: boolean } = {},
): Promise<void> {
	const session = orch.getSession();
	if (session.snaps.length === 0) return;
	if (!UPLOAD_URL || !UPLOAD_TOKEN) {
		if (!opts.keepAlive) {
			console.log(
				`\nSession recorded with ${session.snaps.length} snap(s) — upload disabled, kept locally.`,
			);
		}
		return;
	}
	console.log(
		`\n\x1b[34m↑\x1b[0m uploading session (${session.snaps.length} snap(s))…`,
	);
	const result = await uploadSession({
		url: UPLOAD_URL,
		token: UPLOAD_TOKEN,
		outDir: orch.outDir,
		session,
		flows: orch.listFlows(),
		allSnaps: orch.listAllSnaps(),
		log: (m) => console.log(`  ${m}`),
	});
	if (result.ok) {
		console.log(
			`\x1b[32m✓\x1b[0m uploaded to ${result.appSlug || "platform"} — ${result.framesCount} frame(s), build ${result.buildId.slice(0, 8)}`,
		);
	} else {
		console.log(`\x1b[31m✗\x1b[0m upload failed: ${result.error}`);
		console.log(
			`  session is still on disk at ${orch.outDir} — re-run with same SNAP_OUT to retry.`,
		);
	}
}
