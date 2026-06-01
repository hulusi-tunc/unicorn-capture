/**
 * Stitch sticky chrome (status bar, tab bar, etc.) onto a long-page
 * view-shot output. Without this, react-native-view-shot captures only
 * the wrapped scroll target — anything outside that target's rect
 * (navigator-level chrome, status bar overlay) is missing from the
 * final long-page snap.
 *
 * Inputs:
 *   - viewportPng: raw PNG bytes from `xcrun simctl io booted screenshot`,
 *     a single-frame capture of the visible viewport WITH chrome.
 *   - longPagePng: raw PNG bytes from the bridge's `capture-full-page`,
 *     the wrapped target's full content (no chrome).
 *   - measurements: where the snap-target sits inside the viewport, in
 *     points + device pixel ratio. The strips of the viewport ABOVE the
 *     target's y and BELOW (target.y + target.height) are the chrome we
 *     want to stitch.
 *
 * Output: a new PNG where layout is:
 *     [top chrome strip from viewport]
 *     [long-page content from view-shot]
 *     [bottom chrome strip from viewport]
 *
 * Width is taken from the long-page image so content stays unscaled. If
 * the viewport screenshot has a different width (rare — happens when
 * snap-target doesn't span the full viewport width), strips get
 * proportionally cropped to match. Pure-JS PNG decode/encode via pngjs
 * — no native deps, packages cleanly into Electrobun's Bun runtime.
 */

import { PNG } from "pngjs";

export interface ChromeMeasurements {
	/** Target's left edge in window points. */
	x: number;
	/** Target's top edge in window points. */
	y: number;
	/** Target's width in window points. */
	width: number;
	/** Target's height in window points. */
	height: number;
	/** Viewport width in window points. */
	viewportWidth: number;
	/** Viewport height in window points. */
	viewportHeight: number;
	/** Device pixel ratio (3 on iPhone 17, 2 on older devices, etc.). */
	pixelRatio: number;
}

export async function stitchLongPageWithChrome(
	viewportPng: Buffer,
	longPagePng: Buffer,
	measurements: ChromeMeasurements,
): Promise<Buffer> {
	const [viewport, longPage] = await Promise.all([
		decode(viewportPng),
		decode(longPagePng),
	]);

	// Convert measurement points to viewport-pixel coordinates. Clamp into
	// the viewport bounds so a slight measurement overshoot (sub-pixel
	// rounding, status-bar overlay) doesn't index past the buffer.
	const ratio = measurements.pixelRatio;
	const topStripHeightPx = clamp(
		Math.round(measurements.y * ratio),
		0,
		viewport.height,
	);
	const bottomChromeStartPx = clamp(
		Math.round((measurements.y + measurements.height) * ratio),
		0,
		viewport.height,
	);
	const bottomStripHeightPx = Math.max(0, viewport.height - bottomChromeStartPx);

	// If there's no chrome to stitch (target fills viewport vertically),
	// just re-encode the long-page as-is. Caller treats this as a no-op
	// and uses the long-page PNG directly.
	if (topStripHeightPx === 0 && bottomStripHeightPx === 0) {
		return longPagePng;
	}

	// Output width = long-page width. If viewport width differs, we
	// horizontally crop or center-pad the chrome strips to match. Most
	// apps have snap-targets that span full viewport width — this just
	// handles edge cases without crashing.
	const outWidth = longPage.width;
	const topStrip = cropRows(viewport, 0, topStripHeightPx, outWidth);
	const bottomStrip = cropRows(
		viewport,
		bottomChromeStartPx,
		bottomStripHeightPx,
		outWidth,
	);

	const outHeight = topStripHeightPx + longPage.height + bottomStripHeightPx;
	const out = new PNG({ width: outWidth, height: outHeight });
	out.data.fill(0);

	pasteRows(out, topStrip, 0);
	pasteRows(out, longPage, topStripHeightPx);
	pasteRows(out, bottomStrip, topStripHeightPx + longPage.height);

	return PNG.sync.write(out);
}

function decode(buf: Buffer): Promise<PNG> {
	return new Promise((resolve, reject) => {
		const png = new PNG();
		png.parse(buf, (err) => {
			if (err) reject(err);
			else resolve(png);
		});
	});
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

/**
 * Cut a horizontal slice of a decoded PNG and rescale (crop or pad) its
 * width to match `outWidth`. Wider source → center-crop; narrower
 * source → center-pad with transparent rows (alpha=0).
 */
function cropRows(src: PNG, srcStartY: number, height: number, outWidth: number): PNG {
	const out = new PNG({ width: outWidth, height });
	out.data.fill(0);
	if (height === 0) return out;
	const srcWidth = src.width;
	if (srcWidth === outWidth) {
		// Fast path: same width, just memcpy the row range.
		const srcByteStart = srcStartY * srcWidth * 4;
		const srcByteEnd = srcByteStart + height * srcWidth * 4;
		out.data.set(src.data.subarray(srcByteStart, srcByteEnd), 0);
		return out;
	}
	const copyWidth = Math.min(srcWidth, outWidth);
	const srcLeft = Math.floor((srcWidth - copyWidth) / 2);
	const dstLeft = Math.floor((outWidth - copyWidth) / 2);
	for (let row = 0; row < height; row++) {
		const srcRowStart = ((srcStartY + row) * srcWidth + srcLeft) * 4;
		const dstRowStart = (row * outWidth + dstLeft) * 4;
		out.data.set(
			src.data.subarray(srcRowStart, srcRowStart + copyWidth * 4),
			dstRowStart,
		);
	}
	return out;
}

/**
 * Copy a smaller PNG into a destination PNG at the given y offset.
 * Assumes equal widths (caller's responsibility) — we already normalize
 * widths during cropRows.
 */
function pasteRows(dst: PNG, src: PNG, dstStartY: number): void {
	if (src.width !== dst.width) {
		// Center-paste a narrower source — only used for the long-page
		// image when it's narrower than the chrome strips (rare).
		const copyWidth = Math.min(src.width, dst.width);
		const dstLeft = Math.floor((dst.width - copyWidth) / 2);
		for (let row = 0; row < src.height; row++) {
			const srcRowStart = row * src.width * 4;
			const dstRowStart = ((dstStartY + row) * dst.width + dstLeft) * 4;
			dst.data.set(
				src.data.subarray(srcRowStart, srcRowStart + copyWidth * 4),
				dstRowStart,
			);
		}
		return;
	}
	const srcLen = src.width * src.height * 4;
	const dstStart = dstStartY * dst.width * 4;
	dst.data.set(src.data.subarray(0, srcLen), dstStart);
}
