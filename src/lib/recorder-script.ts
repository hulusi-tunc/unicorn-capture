// Injected into the previewed page to record user interactions.
// Posts events to parent via postMessage.

export const RECORDER_SCRIPT = `
(function () {
	if (window.__scenrun_recorder) return;
	window.__scenrun_recorder = true;

	let recording = false;

	function post(msg) {
		try { parent.postMessage(Object.assign({ __scenrun: true }, msg), "*"); } catch (e) {}
	}

	function selector(el) {
		if (!el || el === document.body) return "body";
		if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return "#" + el.id;
		for (const a of ["data-test", "data-testid", "data-cy", "data-qa"]) {
			const v = el.getAttribute && el.getAttribute(a);
			if (v) return "[" + a + "=\\"" + v.replace(/"/g, '\\\\"') + "\\"]";
		}
		const path = [];
		let cur = el;
		while (cur && cur.nodeType === 1 && cur !== document.body && path.length < 6) {
			let part = cur.tagName.toLowerCase();
			if (cur.classList && cur.classList.length) {
				const cls = Array.from(cur.classList).filter((c) => !/^(active|hover|focus|selected)$/.test(c)).slice(0, 2);
				if (cls.length) part += "." + cls.join(".");
			}
			const sibs = cur.parentNode ? Array.from(cur.parentNode.children).filter((c) => c.tagName === cur.tagName) : [];
			if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
			path.unshift(part);
			cur = cur.parentNode;
		}
		return path.join(" > ");
	}

	function send(action, extra) {
		if (!recording) return;
		post({ kind: "step", step: Object.assign({ action: action, ts: Date.now() }, extra) });
	}

	document.addEventListener("click", function (e) {
		if (!recording) return;
		const t = e.target;
		send("click", { selector: selector(t), text: (t.innerText || "").slice(0, 40) });
	}, true);

	document.addEventListener("change", function (e) {
		if (!recording) return;
		const t = e.target;
		if (t.tagName === "SELECT") send("select", { selector: selector(t), value: t.value });
		else if (t.tagName === "INPUT" && (t.type === "checkbox" || t.type === "radio")) send("click", { selector: selector(t) });
	}, true);

	let typeTimer = null;
	let typeBuffer = new Map();
	document.addEventListener("input", function (e) {
		if (!recording) return;
		const t = e.target;
		if (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA") return;
		const sel = selector(t);
		typeBuffer.set(sel, t.value);
		clearTimeout(typeTimer);
		typeTimer = setTimeout(function () {
			typeBuffer.forEach(function (v, s) { send("type", { selector: s, value: v }); });
			typeBuffer.clear();
		}, 400);
	}, true);

	let lastUrl = location.href;
	setInterval(function () {
		if (location.href !== lastUrl) {
			lastUrl = location.href;
			send("navigate", { url: location.pathname + location.search });
		}
	}, 250);

	window.addEventListener("message", function (e) {
		const d = e.data;
		if (!d || !d.__scenrun_cmd) return;
		if (d.cmd === "start" || d.cmd === "resume") { recording = true; post({ kind: "status", recording: true }); }
		else if (d.cmd === "pause" || d.cmd === "stop") { recording = false; post({ kind: "status", recording: false }); }
	});

	// Surface iframe-side errors to parent for visibility in the Prisma log.
	function classify(msg) {
		if (!msg) return { level: "warn", drop: false };
		var s = String(msg);
		// Hydration warnings from React/Next/Expo — common w/ SSR'd builds, app still works
		if (/Minified React error #(418|419|420|421|422|423)|Hydration failed|Text content does not match|did not match.*server/i.test(s)) {
			return { level: "warn", drop: false, prefix: "hydration mismatch (non-fatal)" };
		}
		return { level: "error", drop: false };
	}
	window.addEventListener("error", function (e) {
		var msg = e.message || String(e.error);
		var c = classify(msg);
		if (c.drop) return;
		post({ kind: "iframe-error", level: c.level, message: (c.prefix ? "[" + c.prefix + "] " : "") + msg + (e.filename ? " @ " + e.filename + ":" + e.lineno : "") });
	}, true);
	window.addEventListener("unhandledrejection", function (e) {
		var msg = e.reason && e.reason.message ? e.reason.message : String(e.reason);
		var c = classify(msg);
		if (c.drop) return;
		post({ kind: "iframe-error", level: c.level, message: (c.prefix ? "[" + c.prefix + "] " : "") + "unhandledrejection: " + msg });
	});
	// Resource load failures (img/script/link)
	document.addEventListener("error", function (e) {
		var t = e.target;
		if (t && (t.tagName === "IMG" || t.tagName === "SCRIPT" || t.tagName === "LINK")) {
			post({ kind: "iframe-error", level: "warn", message: "resource failed: " + (t.src || t.href || "?") });
		}
	}, true);

	post({ kind: "ready", url: location.href });
})();
`;
