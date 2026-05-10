# Unicorn Studio Capture

Desktop snap tool for vibe-coded React Native apps. Designer opens
the app, picks a customer project, presses **Snap** — Capture reads
the running RN app's nav state via WebSocket, captures the iOS
Simulator, organises shots into user-journey flows, and pushes to the
gallery for PM review.

Built on **Electrobun** (Bun + native WKWebView, no Chromium).

![runtime](https://img.shields.io/badge/runtime-Bun-000000?style=flat-square)
![ui](https://img.shields.io/badge/UI-WebKit-blue?style=flat-square)

## What it does

- **Onboard a customer repo** via a 4-phase wizard (Detect → Plan → Install → Verify). Capture installs `@unicorn-studio/snap-bridge`, wires `installSnapBridge` into `_layout.tsx`, generates `snap-flows.ts` from the route tree.
- **Snap a screen** with `⌘⇧S` — Capture pulls route + state from the bridge, takes the screenshot via `xcrun simctl`, places it in the right flow.
- **Iterate** — re-snap to update (replace + version history), or `⌘⇧V` to capture as a new variant (long pages, filter states).
- **Improve flow grouping** with the built-in `✨ Improve` button — copies a Claude-Code-ready prompt to the clipboard with project meta + screen JSDoc / imports / strings. Paste it into Claude, get back a user-journey-grouped `snap-flows.ts`.
- **Long-page capture** for individual screens via `snap-bridge wrap-screen <route>` (or the lightbox's "Enable" button) — one screen at a time, reversible, marker-bracketed.
- **Push to web** — uploads to the gallery platform with full version history per frame so reviewers can scrub through redesign iterations.
- **Doctor mode** — per-project health audit (bridge connected, version pin, layout wiring, view-shot install) with auto-fix buttons.
- **Archive** projects with a 90-day grace period; restorable from the gallery's Archived view.

## Quickstart for designers

1. **Install** — drag `Prisma.app` from the DMG into `/Applications`. First run: `System Settings → Privacy & Security → "Open Anyway"` (pending notarization).
2. **Onboard a project** — click `+ Add` → Mobile → drop your customer repo folder. Wizard handles the rest.
3. **Snap** — start the iOS sim (`pnpm exec expo start --ios`), use the app, press **Snap** (or `⌘⇧S`) when you want a screenshot.
4. **Push** — when the flow is in good shape, click **Push to web**. PM reviews at `gallery.unicorn-studio.com/app/<your-slug>`.

## Quickstart for capture devs

```sh
bun install
bun run start         # production-style launch (no watch)
bun run dev           # watch mode (kills + respawns on save)
bun run build         # build/dev-macos-arm64/Prisma-dev.app
bun run build:canary  # canary channel (test artifacts in artifacts/)
bun run build:signed  # loads .env.build; codesigns + notarizes
bun run lint          # biome check
bun run typecheck     # strict tsc
```

The `.app` lands at `build/dev-macos-arm64/Prisma-dev.app`. Launching the
binary directly (`./build/.../Prisma-dev.app/Contents/MacOS/launcher`)
gives the same UI but with verbose logs in `/tmp/prisma-debug.log`.

## Architecture

```
src/
  bun/                          # Electrobun bun runtime (main process)
    index.ts                    # entry: window, RPC handlers, snap-server boot
    snap-server.ts              # WebSocket server (port 9876) — bridge clients
    snap-orchestrator.ts        # manifest of sessions/snaps/flows; re-snap replace + versions[]
    repo-fingerprint.ts         # pure detection — RN layout, snap-bridge state, …
    installer.ts                # 10-step atomic install with reverse-walk rollback
    installer-steps.ts          # the steps (platformRegister → patchLayout → verify)
    snap-flows-improver.ts      # builds the LLM-ready clipboard prompt
    doctor.ts                   # per-project health audit
    init.ts                     # CaptureProjectEntry registry, layoutSnippet, etc.
    upload.ts                   # multipart push to gallery, batched + replace=true
  lib/
    rpc.ts                      # ScenarioRunnerRPC contract (single source of truth)
    schemas.ts                  # zod (devices.yaml, scenario shapes)
    icon.ts                     # vanilla `lucide` wrapper, shared with gallery
  view/                         # WKWebView (browser) UI
    index.html                  # topbar + #app + #rn-root + #dash-root
    index.ts                    # the bulk: dashboard, project view, lightbox, modals
    wizard-v2.ts                # 4-phase onboarding stepper
    styles/
      tokens.css                # OKLCH design tokens, light+dark
      components.css            # component CSS

snap-bridge/                    # sibling repo: customer-side dev dep
  src/index.ts                  # WebSocket client, installSnapBridge(), setSnapState()
  src/expo-router.ts            # useSnapAutoSync hook
  bin/                          # CLIs: snap-flows-scan, snap-bridge-wrap-screen, …

gallery/apps/platform/          # sibling repo: Next.js review platform
```

## Build pipeline

| Command | Output | Notes |
|---|---|---|
| `bun run build:canary` | `artifacts/canary-macos-arm64-Unicorn Studio-canary.dmg` | Unsigned. Open via right-click → Open. |
| `bun run build:signed` | Same path, but signed + notarized | Reads `.env.build`. See `.env.build.example`. |
| `bun run release:publish` | Uploads `artifacts/` to your CDN | rsync or S3 — picks based on `.env.build`. |
| `bun run release` | Build + sign + notarize + publish | The one-shot. Run from a clean tree. |

For signed builds you need a `.env.build` file with:

```
ELECTROBUN_DEVELOPER_ID="Developer ID Application: <Team> (XXXXXXXXXX)"
ELECTROBUN_APPLEID="..."
ELECTROBUN_APPLEIDPASS="abcd-efgh-ijkl-mnop"   # app-specific, NOT account password
ELECTROBUN_TEAMID="XXXXXXXXXX"
```

For auto-update, add the publish target + the public-facing URL:

```
ELECTROBUN_RELEASE_BASE_URL="https://capture-releases.unicornstudio.com"
PUBLISH_RSYNC_DEST="user@host:/var/www/capture-releases"   # OR
PUBLISH_S3_BUCKET="unicorn-capture-releases"
```

The running app polls `${ELECTROBUN_RELEASE_BASE_URL}/<env>-macos-<arch>-update.json` for fresh `update.json` files. If the hash differs from what's installed, it pulls the matching `.app.tar.zst`, applies the patch, and prompts the user to restart on next launch.

## Companion repos

- **`@unicorn-studio/snap-bridge`** ([github](https://github.com/hulusi-tunc/snap-bridge)) — the dev-dep customer projects install. Three CLIs: `snap-flows-scan`, `snap-bridge-init`, `snap-bridge-wrap-screen`.
- **`@unicorn-studio/gallery-platform`** ([github](https://github.com/hulusi-tunc/unicorn-gallery)) — the Next.js review site. Frame view, comments, version history, archived projects, public share links.

## Hot tips

- **Capture restart**: `pkill -f "Prisma-dev"; cd ~/Unicorn\ Studio/capture && bun run start`
- **Debug log tail**: `tail -f /tmp/prisma-debug.log | grep -i <slug>`
- **snap-bridge bump in customer repo**: `cd ~/<repo> && npm install --save-dev "github:hulusi-tunc/snap-bridge#v0.7.x"`
- **Gallery `.next` cache corrupts**: `cd gallery/apps/platform && pnpm dev:clean`
