// Smoke test: capture the booted iOS Simulator's screen and save a PNG.
// Run with: bun tests/simulator-test.ts
//
// Prereq: at least one iOS Simulator device booted (Simulator.app open with a device).
// Output lands at ./tests/.out/simulator-smoke.png

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { captureSimulator } from "../src/bun/simulator";

const outPath = resolve(import.meta.dir, ".out/simulator-smoke.png");
mkdirSync(dirname(outPath), { recursive: true });

const result = captureSimulator(outPath);
if (!result.ok) {
	console.error(`✗ ${result.error}`);
	process.exit(1);
}

if (!existsSync(outPath)) {
	console.error(`✗ simctl reported success but no file at ${outPath}`);
	process.exit(1);
}

const sizeKb = (statSync(outPath).size / 1024).toFixed(1);
console.log("✓ Simulator screen captured");
console.log(`  ${outPath}`);
console.log(`  ${sizeKb} KB`);
console.log("");
console.log("Open the file to verify it's the simulator content (not your desktop).");
process.exit(0);
