import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSource } from "../src/bun/sources";

let pass = 0, fail = 0;
const ok = (m: string) => { console.log(`✓ ${m}`); pass++; };
const ko = (m: string) => { console.error(`✗ ${m}`); fail++; };

async function fetchInjected(baseUrl: string, entry?: string) {
	const url = entry ? `${baseUrl}/${entry}` : `${baseUrl}/`;
	const res = await fetch(url);
	const html = await res.text();
	return { status: res.status, html };
}

async function testArchive() {
	const p = process.env.PRISMA_TEST_ZIP || "";
	if (!p) { console.log("(skipping archive test — set PRISMA_TEST_ZIP=/path/to.zip)"); return; }
	if (!existsSync(p)) return ko(`archive missing: ${p}`);
	const r = await resolveSource({ kind: "archive", path: p });
	if (!r.ok) return ko(`archive resolve: ${r.error}`);
	ok(`archive resolved → ${r.value.baseUrl}/${r.value.entry}`);
	const f = await fetchInjected(r.value.baseUrl, r.value.entry);
	if (f.status !== 200) ko(`archive HTTP ${f.status}`); else ok("archive HTTP 200");
	if (!f.html.includes("__scenrun_recorder")) ko("archive: recorder missing"); else ok("archive: recorder injected");
	if (!f.html.includes("__scenrun_runner")) ko("archive: runner missing"); else ok("archive: runner injected");
	r.value.cleanup();
	ok("archive cleanup");
}

async function testFolder() {
	const tmp = mkdtempSync(join(tmpdir(), "prisma-test-"));
	writeFileSync(join(tmp, "index.html"), `<!DOCTYPE html><html><body><h1>folder test</h1></body></html>`);
	writeFileSync(join(tmp, "style.css"), `body{color:red}`);
	const r = await resolveSource({ kind: "folder", path: tmp });
	if (!r.ok) { rmSync(tmp, { recursive: true }); return ko(`folder resolve: ${r.error}`); }
	ok(`folder resolved → ${r.value.baseUrl}/${r.value.entry}`);
	const f = await fetchInjected(r.value.baseUrl, r.value.entry);
	if (f.status !== 200 || !f.html.includes("folder test")) ko("folder content wrong"); else ok("folder serves index.html");
	if (!f.html.includes("__scenrun_recorder")) ko("folder: recorder missing"); else ok("folder: recorder injected");
	const css = await fetch(`${r.value.baseUrl}/style.css`);
	if (css.status === 200 && (await css.text()).includes("color:red")) ok("folder serves css"); else ko("folder css wrong");
	r.value.cleanup();
	rmSync(tmp, { recursive: true });
	ok("folder cleanup");
}

async function testUrlPassthrough() {
	const r = await resolveSource({ kind: "url", url: "https://example.com" });
	if (!r.ok) return ko(`url: ${r.error}`);
	if (r.value.baseUrl !== "https://example.com") ko(`url: wrong baseUrl ${r.value.baseUrl}`); else ok("url passthrough");
	r.value.cleanup();
}

async function testInvalidUrl() {
	const r = await resolveSource({ kind: "url", url: "not a url" });
	if (r.ok) ko("invalid url should fail"); else ok(`invalid url rejected: "${r.error}"`);
}

async function testMissingArchive() {
	const r = await resolveSource({ kind: "archive", path: "/nonexistent.zip" });
	if (r.ok) ko("missing archive should fail"); else ok(`missing archive rejected: "${r.error}"`);
}

async function testEntryDetection() {
	const tmp = mkdtempSync(join(tmpdir(), "prisma-test-"));
	const sub = join(tmp, "apps", "web");
	mkdirSync(sub, { recursive: true });
	writeFileSync(join(sub, "index.html"), "<html>nested entry</html>");
	const r = await resolveSource({ kind: "folder", path: tmp });
	if (!r.ok) { rmSync(tmp, { recursive: true }); return ko(`nested resolve: ${r.error}`); }
	if (!r.value.entry || !r.value.entry.includes("index.html")) ko(`nested entry wrong: ${r.value.entry}`);
	else ok(`nested entry detected: ${r.value.entry}`);
	r.value.cleanup();
	rmSync(tmp, { recursive: true });
}

async function main() {
	console.log("=== Prisma pipeline tests ===\n");
	await testArchive();
	console.log();
	await testFolder();
	console.log();
	await testUrlPassthrough();
	console.log();
	await testInvalidUrl();
	console.log();
	await testMissingArchive();
	console.log();
	await testEntryDetection();
	console.log(`\n=== ${pass} passed, ${fail} failed ===`);
	process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
