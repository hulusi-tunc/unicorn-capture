// Open Chrome's side panel when the user clicks the extension icon.
// Two layers of safety:
//   1) setPanelBehavior tells Chrome to auto-open the side panel on the
//      action click — when this works, no listener fires.
//   2) If the panel never opens (older Chrome, race during load, etc),
//      the explicit onClicked listener calls sidePanel.open() in the
//      user-gesture window of the click. open() requires that gesture
//      context, so it MUST run inside this listener — not async-later.

void chrome.sidePanel
	.setPanelBehavior({ openPanelOnActionClick: true })
	.catch((err: unknown) =>
		console.warn("setPanelBehavior failed:", (err as Error)?.message),
	);

chrome.action.onClicked.addListener((tab) => {
	if (!tab?.windowId) return;
	// Fire-and-forget — Chrome handles the open within the user gesture.
	void chrome.sidePanel
		.open({ windowId: tab.windowId })
		.catch((err: unknown) =>
			console.warn("sidePanel.open failed:", (err as Error)?.message),
		);
});

// Make sure the side panel uses popup.html for every tab (Chrome
// occasionally caches a stale path when the extension is reloaded with a
// changed manifest).
chrome.runtime.onInstalled.addListener(() => {
	void chrome.sidePanel
		.setOptions({ path: "popup.html", enabled: true })
		.catch((err: unknown) =>
			console.warn("setOptions failed:", (err as Error)?.message),
		);
});


// The side panel document doesn't get the chrome.tabCapture API (Chrome
// exposes it to the service worker / foreground pages only), so the panel
// asks us for a media stream id and consumes it with getUserMedia on its
// side. getMediaStreamId here runs with the extension's tabCapture
// permission + the activeTab grant from the user's interaction.
chrome.runtime.onMessage.addListener(
	(
		msg: { cmd?: string; targetTabId?: number },
		_sender,
		sendResponse: (r: { ok: boolean; streamId?: string; error?: string }) => void,
	) => {
		if (msg?.cmd !== "uc-get-tab-stream-id" || !msg.targetTabId) return;
		try {
			chrome.tabCapture.getMediaStreamId(
				{ targetTabId: msg.targetTabId },
				(streamId) => {
					const err = chrome.runtime.lastError;
					if (err || !streamId) {
						sendResponse({
							ok: false,
							error: err?.message ?? "tabCapture returned no stream id",
						});
					} else {
						sendResponse({ ok: true, streamId });
					}
				},
			);
		} catch (err) {
			sendResponse({ ok: false, error: (err as Error).message });
		}
		return true; // keep the message channel open for the async response
	},
);
