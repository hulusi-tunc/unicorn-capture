# `<SnapTourHandler/>` — reference implementation

This is the RN-side contract for the tour feature documented in
[`docs/tour.md`](./tour.md). It lives in `@unicorn-studio/snap-bridge` (a
separate repo), not in Unicorn Capture — this file is the spec the bridge
maintainer needs to ship a new release.

## What it does

Listens for `cmd: "goto"` messages on the existing snap-bridge WebSocket and:

1. Navigates the router to the requested route, expanding any path params.
2. Waits for the screen to mount (first commit after navigation).
3. Optionally waits for a `<SnapReady/>` boundary inside the screen to signal
   "I'm done loading async content" — see "Settle signal" below.
4. Posts `{ kind: "ready", id, route, projectId, stateHash, settleMs }` back
   over the same socket.

If the bridge is already exporting `connect()` (the existing flows hello),
`<SnapTourHandler/>` reuses that connection — no new socket.

## Wire protocol (from `snap-server`)

Incoming (server → bridge):

```json
{ "cmd": "goto", "id": "uuid-v4", "route": "/thread/conv1", "params": { "conv": "conv1" } }
```

Outgoing (bridge → server):

```json
{
  "kind": "ready",
  "id": "uuid-v4",
  "projectId": "ovria",
  "route": "/thread/conv1",
  "stateHash": "optional-hash-of-store-state",
  "settleMs": 137
}
```

On navigation error (unknown route, etc.):

```json
{ "kind": "ready", "id": "uuid-v4", "ok": false, "error": "no-match" }
```

`id` must round-trip — `snap-server` uses it to match the response to the
in-flight `requestNavigate()` promise. Without it the goto times out.

## Reference implementation (expo-router)

```tsx
// In @unicorn-studio/snap-bridge: src/SnapTourHandler.tsx
import { useEffect, useRef } from "react";
import { router } from "expo-router";
import { useSnapBridgeSocket } from "./useSnapBridgeSocket";

interface GotoMsg {
  cmd: "goto";
  id: string;
  route: string;
  params?: Record<string, string | number>;
}

let readySignal: (() => void) | null = null;

/** Lets a screen opt-in to async settle. See <SnapReady/>. */
export function useSnapReadyHandle() {
  const ref = useRef(false);
  useEffect(() => {
    if (ref.current) return;
    ref.current = true;
    readySignal?.();
  });
}

export function SnapReady() {
  useSnapReadyHandle();
  return null;
}

export function SnapTourHandler() {
  const socket = useSnapBridgeSocket();

  useEffect(() => {
    if (!socket) return;
    const handler = async (raw: string) => {
      let msg: GotoMsg | null = null;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || msg.cmd !== "goto") return;
      const started = Date.now();
      try {
        await navigateTo(msg.route, msg.params);
        // Default settle: one frame after the next commit. <SnapReady/>
        // inside the screen overrides this with an explicit signal.
        await new Promise<void>((resolve) => {
          let settled = false;
          readySignal = () => {
            if (settled) return;
            settled = true;
            readySignal = null;
            resolve();
          };
          // Fallback if no <SnapReady/> is present.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => readySignal?.()),
          );
        });
        socket.send(
          JSON.stringify({
            kind: "ready",
            id: msg.id,
            projectId: socket.projectId,
            route: msg.route,
            settleMs: Date.now() - started,
          }),
        );
      } catch (err) {
        socket.send(
          JSON.stringify({
            kind: "ready",
            id: msg.id,
            ok: false,
            error: (err as Error).message,
          }),
        );
      }
    };
    socket.addEventListener("message", (e) => handler(e.data));
  }, [socket]);

  return null;
}

async function navigateTo(
  route: string,
  params?: Record<string, string | number>,
) {
  // expand `:foo` placeholders for expo-router's pathname-based API
  let pathname = route;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      pathname = pathname.replace(`:${k}`, encodeURIComponent(String(v)));
    }
  }
  router.replace(pathname);
}
```

For `@react-navigation/native`, swap `expo-router`'s `router.replace` for
`navigationRef.current?.navigate(name, params)` and look up `name` from a
route-to-name map.

## Mount in customer app

```tsx
// ovria/app/_layout.tsx
import { Stack } from "expo-router";
import { SnapTourHandler } from "@unicorn-studio/snap-bridge";

export default function RootLayout() {
  return (
    <>
      <Stack />
      {__DEV__ && <SnapTourHandler />}
    </>
  );
}
```

`__DEV__` guard: tour-handler should NEVER ship to production — it's a debug
surface that takes navigation commands from localhost.

## Redirect-after-navigate (v0.8.2 follow-up — required for auth-gated apps)

> **Footgun observed in the wild:** ovria's first real tour run (2026-05-20)
> snapped 44/44 steps, but steps 16–32 came back as the splash screen because
> `_layout.tsx`'s `AuthGate` redirected `/home` → `/(onboarding)/splash` on a
> signed-out simulator. `<SnapTourHandler/>` v0.8.1 acks `ready` the moment
> `router.replace()` succeeds — it can't know about the follow-up redirect, so
> Capture snaps splash thinking it's `/home`.

There are two ways to handle this — both backward-compatible.

### Operational workaround (works with v0.8.1 today)

Pre-auth the simulator before the tour. The tour script's first steps should
log the test user in (or rely on a pre-seeded persisted session) so AuthGate
never fires. This is the only fix that works with the v0.8.1 handler — see the
[`tour-auth-seed` memory note](../README.md#memory) for the rule.

### Spec for v0.8.2 — re-ack the final route

After `router.replace(requestedRoute)`, the handler polls `usePathname()` for
up to **N ticks** (suggested: 6 × 16ms = ~96ms). If the final pathname differs
from the requested one, the handler acks with the **final** route plus a
`redirected: true` flag:

```json
{
  "kind": "ready",
  "id": "uuid",
  "projectId": "ovria",
  "route": "/(onboarding)/splash",
  "requestedRoute": "/home",
  "redirected": true,
  "settleMs": 142
}
```

Capture's snap-server already accepts these fields (`requestedRoute`,
`redirected`, `finalRoute` are optional on `NavigateResponse`) — no Capture
release needed, just bump snap-bridge.

### Reference impl (delta from v0.8.1)

```tsx
// inside SnapTourHandler's goto handler, after navigateTo:
await waitForCommit();   // existing 2-rAF settle

// NEW: poll for redirect
let finalRoute = msg.route;
let redirected = false;
for (let i = 0; i < 6; i++) {
  await new Promise(r => requestAnimationFrame(r));
  const current = currentPathname();  // usePathname() captured via a hook+ref
  if (current && current !== msg.route) {
    finalRoute = current;
    redirected = true;
    // small extra settle for the redirected screen
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));
    break;
  }
}

socket.send(JSON.stringify({
  kind: "ready",
  id: msg.id,
  projectId,
  route: finalRoute,
  requestedRoute: redirected ? msg.route : undefined,
  redirected: redirected || undefined,
  settleMs: Date.now() - started,
}));
```

### What the tour driver does with this

`tour-client.ts` surfaces `redirected` on the `NavigateResult`. The default
`tour.run([...])` logs a warning when divergence happens and **still snaps**
(the snap will show the redirected screen, which is at least truthful — vs.
v0.8.1's silent splash-corruption). Strict tours can opt-in:

```ts
await tour.run(routes, { failOnRedirect: true });
```

## Settle signal (opt-in per screen)

By default, `SnapTourHandler` waits two requestAnimationFrame ticks after the
navigation commits and then acks ready. That's correct for fast static
screens. For screens that fetch + render (e.g. a thread, a company page),
mark "done" explicitly:

```tsx
function CompanyScreen() {
  const { data, isLoading } = useCompany(id);
  return (
    <>
      <Header company={data} />
      <Body company={data} />
      {!isLoading && <SnapReady />}
    </>
  );
}
```

`<SnapReady/>` flips an internal signal the handler awaits. If a screen never
renders `<SnapReady/>`, the handler falls back to the rAF default — so this
is fully backward-compatible.

## Auth

Out of scope for the handler — the tour script handles auth before the route
loop (see [docs/tour.md § Authentication](./tour.md#authentication)). The
handler only navigates; it doesn't know what's logged in.

## What's NOT in scope

- **Tapping buttons / typing in fields**: the handler navigates but doesn't
  drive inputs. If you need to test gated flows (e.g. "open settings then
  click delete"), seed the simulator state before the tour, or extend the
  protocol with a `cmd: "act"` in a future revision.
- **Awaiting async by URL**: the handler can't know that `/dashboard` is
  fully loaded until the screen tells it via `<SnapReady/>`. Don't expect a
  tour to capture the loaded state of a screen that fetches on mount unless
  you wrap the loaded path in `<SnapReady/>`.
