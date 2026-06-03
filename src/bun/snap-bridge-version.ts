/**
 * Single source of truth for the snap-bridge version every new project
 * gets pinned to during onboarding.
 *
 * Bumped per Capture release. Hardcoded — not a remote lookup — so a
 * brand-new project always installs against a known-good tag instead of
 * floating on whatever was at HEAD when the wizard last ran (the
 * "every fresh install gets v0.0.1 forever" bug folleli + ovria both hit).
 *
 * The dev case (point at a local checkout, an unreleased branch, etc.)
 * is supported via the `SNAP_BRIDGE_REF` env var.
 */
const DEFAULT_REF = "github:hulusi-tunc/snap-bridge#v0.10.0";

export function getSnapBridgeRef(): string {
	const override = process.env.SNAP_BRIDGE_REF?.trim();
	return override && override.length > 0 ? override : DEFAULT_REF;
}

/**
 * The semver-ish piece of the ref ("v0.4.2") so the UI / fingerprint can
 * compare it against a project's installed version. Falls back to
 * "unknown" when the user has overridden with something exotic.
 */
export function getSnapBridgeVersion(): string {
	const ref = getSnapBridgeRef();
	const m = ref.match(/#(.+)$/);
	if (!m) return "unknown";
	const tail = m[1]!;
	return tail.startsWith("v") ? tail : `#${tail}`;
}
