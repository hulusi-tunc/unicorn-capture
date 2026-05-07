// End-to-end smoke test for the desktop side of Unicorn Capture.
// Boots the snap server, opens a same-process mock bridge that pretends to
// be an RN app, performs one snap, asserts the manifest + image landed.
//
// Prereq: an iOS Simulator device booted (any device, any state).
//
// Run with: bun tests/snap-orchestrator-test.ts

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createSnapOrchestrator } from "../src/bun/snap-orchestrator";
import { startSnapServer } from "../src/bun/snap-server";

const PORT = 9876;
const OUT_DIR = resolve(import.meta.dir, ".out/snaps");

const server = startSnapServer({
	port: PORT,
	log: (m) => console.log(`  [server] ${m}`),
});
console.log(`✓ Snap server up on ws://localhost:${PORT}`);

// Open a fake snap-bridge in the same process to prove the protocol works
// without needing a real RN app yet.
const mock = new WebSocket(`ws://localhost:${PORT}`);
await new Promise<void>((res, rej) => {
	mock.addEventListener("open", () => res(), { once: true });
	mock.addEventListener("error", () => rej(new Error("mock bridge could not connect")), { once: true });
});
mock.send(
	JSON.stringify({ kind: "hello", projectId: "mock-folleli" }),
);
mock.addEventListener("message", (e) => {
	let msg: { cmd?: string; id?: string };
	try {
		msg = JSON.parse(e.data as string);
	} catch {
		return;
	}
	if (msg.cmd === "get-state") {
		mock.send(
			JSON.stringify({
				kind: "state",
				id: msg.id,
				projectId: "mock-folleli",
				snapshot: {
					route: "/profile",
					navStack: ["(tabs)", "profile"],
					stateHash: "default",
				},
				ts: Date.now(),
			}),
		);
	}
});
console.log(`✓ Mock bridge connected as "mock-folleli"`);

await new Promise((r) => setTimeout(r, 50));

const orch = await createSnapOrchestrator({
	server,
	outDir: OUT_DIR,
});
console.log(`✓ Orchestrator session: ${orch.sessionId}`);

const result = await orch.snap();
if (!result.ok) {
	console.error(`✗ snap failed: ${result.error}`);
	mock.close();
	server.stop();
	process.exit(1);
}

const { record } = result;
console.log(`✓ Snap recorded`);
console.log(`  project:  ${record.projectId}`);
console.log(`  session:  ${record.sessionId}`);
console.log(`  seq:      ${record.sequence}`);
console.log(`  route:    ${record.route}`);
console.log(`  state:    ${record.stateHash}`);
console.log(`  image:    ${record.image}`);

const imagePath = resolve(OUT_DIR, record.image);
if (!existsSync(imagePath)) {
	console.error(`✗ image missing on disk: ${imagePath}`);
	mock.close();
	server.stop();
	process.exit(1);
}
const sizeKb = (statSync(imagePath).size / 1024).toFixed(1);
console.log(`            (${sizeKb} KB on disk)`);

const manifestPath = resolve(OUT_DIR, "manifest.json");
if (!existsSync(manifestPath)) {
	console.error(`✗ manifest.json missing`);
	mock.close();
	server.stop();
	process.exit(1);
}

console.log("");
console.log(`✓ End-to-end snap loop works.`);
console.log(`  Manifest: ${manifestPath}`);

mock.close();
server.stop();
process.exit(0);
