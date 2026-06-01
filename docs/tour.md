# Tour — programmatic gallery capture

Tour lets you describe "snap every screen of my app" as a small script written
inside the customer project. The script is the *driver* — it knows credentials,
sample IDs, and which routes need pre-state. Unicorn Capture is the *visualizer*
— it receives snaps as they happen via its existing pipeline.

```
ovria/scripts/tour.ts                                (driver, knows the project)
        │  fetch POST http://localhost:9876/tour/goto?route=/login
        │  fetch POST http://localhost:9876/tour/snap
        ▼
Unicorn Capture (running in the background, snap-server + orchestrator)
        │  WS  {cmd:"goto", route} →
        ▼
RN app with <SnapTourHandler/> mounted (acks  {kind:"ready", route})
```

No bundle / zip format. Snaps land in the running Capture app's current session
as they're produced — the gallery view fills up live.

## HTTP API exposed by snap-server (localhost:9876)

| Method  | Path             | Body / Query                          | Returns                                                       |
| ------- | ---------------- | ------------------------------------- | ------------------------------------------------------------- |
| `GET`   | `/tour/flows`    | `?projectId=ovria`                    | declared flows for the project's connected bridge             |
| `POST`  | `/tour/goto`     | `{ projectId, route, params? }`       | `{ok:true, route, stateHash}` once bridge acks ready, else 504 |
| `POST`  | `/tour/snap`     | `{ projectId, flowId?, label? }`      | the `SnapRecord` written to manifest                          |
| `GET`   | `/tour/status`   | —                                     | `{ bridges: [{projectId, declaredFlows}] }`                   |

All endpoints are localhost-only — same security posture as the existing `/img`
endpoint (any process on the box already has filesystem access).

## WebSocket protocol additions

Server → bridge:

```json
{ "cmd": "goto", "id": "uuid", "route": "/thread/conv1", "params": {"conv": "conv1"} }
```

Bridge → server:

```json
{ "kind": "ready", "id": "uuid", "projectId": "ovria", "route": "/thread/conv1", "stateHash": "abc123" }
```

The `id` round-trips so multiple in-flight `goto`s don't collide.

## Customer-project SDK — `@unicorn/tour-client`

```ts
import { Tour } from "@unicorn/tour-client";

const tour = new Tour({ projectId: "ovria" });

await tour.goto("/");                 await tour.snap();
await tour.goto("/login");            await tour.snap();
await tour.goto("/thread/:conv", { conv: "conv1" }); await tour.snap();

// Or batch:
await tour.run([
  "/", "/splash", "/email-entry", "/login",
  ["/thread/:conv", { conv: "conv1" }],
]);
```

`Tour.goto(route, params?)` resolves once `<SnapTourHandler/>` acks ready.
`Tour.snap(opts?)` calls `/tour/snap` which fires the existing orchestrator path
(simctl screenshot → manifest.json).

## RN-side — `<SnapTourHandler/>`

Mount once at app root, alongside the existing snap-bridge:

```tsx
// app/_layout.tsx (expo-router) or App.tsx (rn-navigation)
import { SnapTourHandler } from "@unicorn-studio/snap-bridge/tour";

export default function RootLayout() {
  return (
    <>
      <Stack /* …existing… */ />
      {__DEV__ && <SnapTourHandler />}
    </>
  );
}
```

The handler subscribes to the snap-bridge socket, listens for `cmd:"goto"`, and:

1. Calls the router's `navigate(route, params)`.
2. Waits for the screen to mount (effect after first commit).
3. Optionally waits for a user-supplied `<SnapReady/>` boundary inside the
   screen (e.g. after fonts/images load) — see "settle signal" below.
4. Posts `{ kind: "ready", id, route, stateHash }` back over the socket.

If the route is unknown, it posts `{ kind: "ready", id, route, error: "no-match" }`.

### Settle signal (opt-in per screen)

Default: `<SnapTourHandler/>` waits 1 frame after `useEffect` fires. For screens
with async work (image grids, server-rendered lists), wrap the loaded content:

```tsx
import { SnapReady } from "@unicorn-studio/snap-bridge/tour";

function CompanyScreen() {
  const { data, isLoading } = useCompany();
  return (
    <>
      {/* …rendering… */}
      {!isLoading && <SnapReady />}
    </>
  );
}
```

`<SnapReady/>` flips an internal signal the handler awaits before acking ready.

### Authentication

The tour script handles auth itself before the route loop:

```ts
await tour.goto("/login");
await tour.act("type", { selector: "[data-testid=email]", text: "tour@ovria.app" });
await tour.act("type", { selector: "[data-testid=password]", text: "..." });
await tour.act("press", { selector: "[data-testid=login-submit]" });
await tour.goto("/");   // now authenticated, continue normally
```

`tour.act()` is **out of scope for the MVP** — auth is a one-off you script
once and reuse. Until then, seed the simulator with a logged-in test user
(snapshot it, restore at tour start), or run the tour with `EXPO_PUBLIC_AUTO_LOGIN=tour@ovria.app` if your app supports it.

## Known caveats

**Auth-gate redirects (snap-bridge v0.8.1):** If the customer app has an
auth-gate `<Layout>` that redirects unauthenticated users elsewhere (e.g.
`/home` → `/(onboarding)/splash`), the v0.8.1 `<SnapTourHandler/>` acks
`ready` on the `router.replace()` *call* — it doesn't follow the redirect.
The snap then captures the redirected screen with the requested route's
filename. **Sign the simulator into the test user before running the tour**,
or upgrade to snap-bridge v0.8.2 (re-acks the final route, sets
`redirected:true` — see [docs/snap-tour-handler.md § Redirect-after-navigate](./snap-tour-handler.md#redirect-after-navigate-v082-follow-up--required-for-auth-gated-apps)).
The `tour-client` SDK's `run()` logs a `⚠ redirected` line per divergence
when the bridge reports it; pass `{ failOnRedirect: true }` to throw instead.

## MVP scope (what's shipping in this pass)

- [x] HTTP endpoints on snap-server (`/tour/flows`, `/tour/goto`, `/tour/snap`, `/tour/status`)
- [x] WS protocol: `goto` + `ready`
- [x] `src/sdk/tour-client.ts` — a single file customer projects can copy or `npm i`
- [ ] `<SnapTourHandler/>` — lives in `@unicorn-studio/snap-bridge`, not in this repo
- [ ] `tour.act()` for keyboard/tap interactions — future

## Sample ovria tour script

```ts
// ovria/scripts/tour.ts
import { Tour } from "@unicorn/tour-client";

const tour = new Tour({ projectId: "ovria" });

await tour.run([
  "/",
  "/splash",
  "/email-entry",
  "/login",
  "/forgot-password",
  "/role",
  "/signup",
  "/verify",
  // post-auth — assumes seeded session
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

console.log("✓ tour complete — check Unicorn Capture");
```

Run with:

```bash
# 1) Boot the simulator with the app installed
# 2) Start Unicorn Capture (it serves snap-server on :9876)
# 3) Run the tour
bun ovria/scripts/tour.ts
```
