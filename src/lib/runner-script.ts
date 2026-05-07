// Injected into the previewed page to replay recorded steps.
// Receives commands via postMessage from parent.

export const RUNNER_SCRIPT = `
(function () {
	if (window.__scenrun_runner) return;
	window.__scenrun_runner = true;

	function post(msg) {
		try { parent.postMessage(Object.assign({ __scenrun_runner: true }, msg), "*"); } catch (e) {}
	}

	function find(selector, timeout) {
		return new Promise(function (resolve, reject) {
			const start = Date.now();
			(function tick() {
				try {
					const el = document.querySelector(selector);
					if (el) return resolve(el);
				} catch (e) { return reject(e); }
				if (Date.now() - start >= timeout) return reject(new Error("not found: " + selector));
				setTimeout(tick, 50);
			})();
		});
	}

	function visible(el) {
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	}

	function dispatch(el, type, init) {
		const ev = new (type === "input" || type === "change" ? Event : MouseEvent)(type, Object.assign({ bubbles: true, cancelable: true }, init || {}));
		el.dispatchEvent(ev);
	}

	async function run(step) {
		const to = step.timeout || 5000;
		switch (step.action) {
			case "navigate": {
				location.href = step.url;
				return { ok: true };
			}
			case "click": {
				if (typeof step.x === "number" && typeof step.y === "number") {
					const el = document.elementFromPoint(step.x, step.y);
					if (el) el.click(); else throw new Error("no element @ " + step.x + "," + step.y);
				} else {
					const el = await find(step.selector, to);
					el.click();
				}
				return { ok: true };
			}
			case "type": {
				const el = await find(step.selector, to);
				el.focus();
				el.value = step.value || "";
				dispatch(el, "input");
				dispatch(el, "change");
				if (step.delay) await new Promise((r) => setTimeout(r, step.delay));
				return { ok: true };
			}
			case "select": {
				const el = await find(step.selector, to);
				el.value = step.value;
				dispatch(el, "change");
				return { ok: true };
			}
			case "wait": {
				if (typeof step.ms === "number") {
					await new Promise((r) => setTimeout(r, step.ms));
				} else if (step.selector) {
					await find(step.selector, step.timeout || 10000);
				}
				return { ok: true };
			}
			case "assert": {
				const el = document.querySelector(step.selector);
				if (!el) throw new Error("assert failed: " + step.selector);
				return { ok: true };
			}
			case "scroll": {
				if (step.selector) {
					const el = await find(step.selector, to);
					el.scrollIntoView({ behavior: "instant", block: "center" });
				} else {
					window.scrollTo(step.x || 0, step.y || 0);
				}
				return { ok: true };
			}
			case "hover": {
				const el = await find(step.selector, to);
				dispatch(el, "mouseover");
				dispatch(el, "mouseenter");
				return { ok: true };
			}
			case "evaluate": {
				const fn = new Function(step.script);
				fn();
				return { ok: true };
			}
			case "screenshot": {
				return { ok: true, screenshot: true };
			}
			default:
				throw new Error("unknown action: " + step.action);
		}
	}

	window.addEventListener("message", async function (e) {
		const d = e.data;
		if (!d || !d.__scenrun_run) return;
		try {
			const r = await run(d.step);
			post({ kind: "step-done", id: d.id, result: r });
		} catch (err) {
			post({ kind: "step-done", id: d.id, result: { ok: false, error: String((err && err.message) || err) } });
		}
	});

	post({ kind: "runner-ready", url: location.href });
})();
`;
