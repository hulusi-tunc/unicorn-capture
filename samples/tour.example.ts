/**
 * Sample tour script — copy this into your customer project (e.g. ovria/scripts/tour.ts)
 * and adapt the route list to match your app's flows.
 *
 * To run:
 *   1. Start Unicorn Capture (serves snap-server on :9876)
 *   2. Boot the customer app in the iOS simulator (must include
 *      <SnapTourHandler/> + snap-bridge v0.8+)
 *   3. bun ovria/scripts/tour.ts
 *
 * See docs/tour.md for the full architecture.
 */

import { Tour } from "../src/sdk/tour-client";

// In a customer project, prefer the package import once it's published:
//   import { Tour } from "@unicorn-studio/tour-client";

const tour = new Tour({ projectId: "ovria" });

// ── Sanity check ─────────────────────────────────────────────────────────
const status = await tour.status();
if (status.bridges.length === 0) {
	throw new Error(
		"No snap-bridge connected. Boot the app in the simulator and confirm Unicorn Capture shows ● bridge connected.",
	);
}
const bridge = status.bridges.find((b) => b.projectId === "ovria");
if (!bridge) {
	throw new Error(
		`No bridge for projectId="ovria". Connected: ${status.bridges.map((b) => b.projectId).join(", ")}`,
	);
}

// ── Tour ─────────────────────────────────────────────────────────────────
// Option A — hand-list every route (most explicit):
await tour.run([
	"/",
	"/splash",
	"/email-entry",
	"/login",
	"/forgot-password",
	"/role",
	"/signup",
	"/verify",
	// post-auth — assumes the simulator is seeded with a test user.
	"/trade",
	"/availability",
	"/profile-basics",
	"/profile-details",
	"/profile-docs",
	"/finalizing",
	"/search",
	["/company/:id", { id: "c1" }],
	"/interest-sent",
	"/messages",
	["/thread/:conv", { conv: "conv1" }],
	["/thread/:conv", { conv: "conv3" }],
	"/profile",
	"/edit-profile",
	"/documents",
	"/company-info",
	"/paywall",
	"/payment-success",
	["/worker/:id", { id: "w1" }],
	"/subscription",
	"/notifications",
	"/settings",
	"/help",
	"/edit-email",
	"/payment-methods",
	"/privacy",
	"/terms",
]);

// Option B — drive from the bridge's declared flows (when the app's
// @SnapFlows() decorators already list every route, this is zero-config):
//
//   const routes = await tour.routesFromFlows();
//   await tour.run(routes);

console.log("✓ tour complete — check Unicorn Capture for the gallery view.");
