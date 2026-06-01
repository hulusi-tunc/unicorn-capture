// Bundle the extension's popup + background-service-worker TypeScript
// into plain JS that Chrome can load as an unpacked extension.
// Run: bun extensions/chrome/build.ts

import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outdir = join(here, "dist");

// Wipe only the built JS — leave manifest.json + popup.html + any icons.
await rm(join(outdir, "popup.js"), { force: true });
await rm(join(outdir, "background.js"), { force: true });

const result = await Bun.build({
	entrypoints: [join(here, "src/popup.ts"), join(here, "src/background.ts")],
	outdir,
	target: "browser",
	format: "esm",
	minify: false,
	sourcemap: "linked",
	naming: "[name].js",
});

if (!result.success) {
	for (const m of result.logs) console.error(m);
	process.exit(1);
}

console.log(`Built ${result.outputs.length} files → ${outdir}`);
for (const o of result.outputs) console.log(`  ${o.path}`);
