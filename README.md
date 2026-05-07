# Prisma

Visual flow testing & macro recorder for static sites and bundled web apps. Built on Electrobun (native WebKit on macOS) — no Playwright, no Chromium download.

![accent](https://img.shields.io/badge/accent-%230066FF-0066FF?style=flat-square)
![runtime](https://img.shields.io/badge/runtime-Bun-000000?style=flat-square)
![ui](https://img.shields.io/badge/UI-WebKit-blue?style=flat-square)

## Features

- **Sources**: drag/drop a folder, a `.zip` / `.tar.gz` archive, or paste a URL — auto-detected
- **Macro recorder** — click in the previewed app, every interaction (click / type / select / nav) becomes an editable step
- **Replay** the recorded flow in the in-app preview, screenshots captured via `screencapture` (macOS native, pixel-perfect)
- **60+ device presets** — mobile (iPhone 17 / Galaxy S26 / Pixel 10 / …), foldable (Z Fold / Flip), tablet, laptop, desktop, ultrawide. Iframe auto-resizes & scales-to-fit
- **Editable steps** — selector / value / delay / timeout / per-step screenshot toggle 📸
- **Two result layouts** — Grid (flow rows × step columns) and Timeline (vertical chain w/ collapse)
- **Dual theme** — dark / light, electric blue (`#0066FF`) accent
- **Per-project persistence** — scenarios + device choice saved per source URL/path
- **Resizable panes** — drag splitters between sidebar / preview / inspector / log; double-click to reset; sizes persisted
- **Cmd+C/V/X/Z/A** working in inputs (proper macOS Edit menu)
- **Bebas Neue** display font for titles + brand wordmark

## Quickstart

```sh
bun install
bun run start      # production-style dev launch (no watch)
bun run dev        # dev with file-watch
bun run build      # bundle the .app
bun run lint       # biome check
bun run test       # tests/test-flow.ts (set PRISMA_TEST_ZIP=/path/to.zip to include archive test)
```

The .app appears at `build/dev-macos-arm64/Prisma-dev.app`. First run will prompt for **Screen Recording** permission — needed for `screencapture` during replay.

## Architecture

```
src/
  bun/                       # Main process (Electrobun bun runtime)
    index.ts                 # entry: window, RPC handlers, ApplicationMenu
    sources.ts               # URL passthrough · folder serve · archive extract
    static-server.ts         # Bun.serve, injects recorder + runner into served HTML
    entry-detector.ts        # picks index.html, reports framework hints (Vite / Next / Astro / …)
    screencapture.ts         # macOS /usr/sbin/screencapture wrapper
  lib/                       # Shared types / SoT (used both by bun and view)
    schemas.ts               # zod for Scenario / Device / Step + ACTION_SPEC
    rpc.ts                   # RPC contract types
    ui.ts                    # UI strings / defaults / theme helper — no magic numbers in components
    store.ts                 # tiny pub-sub state container
    recorder-script.ts       # injected into iframe, captures user actions
    runner-script.ts         # injected into iframe, replays scenarios
  view/
    index.html               # shell
    index.ts                 # tri-pane render, atomic templates, replay loop, recorder dispatch
    styles/
      tokens.css             # design tokens, light + dark themes, layout primitives
      components.css         # component styles
samples/
  devices.yaml               # 60+ device presets (mobile-small/mobile/large/foldable/tablet/laptop/desktop/ultrawide)
assets/
  icons/                     # source SVG, generated PNGs
  Prisma.iconset/            # macOS iconset
tests/
  test-flow.ts               # 14-test bun-side pipeline suite
electrobun.config.ts         # Electrobun build config
```

### Source flow

1. User picks a Source (URL / Local folder / Local archive)
2. `bun/sources.ts:resolveSource` → for archive: extract w/ `unzip` or `tar` → for folder: identity → for URL: passthrough
3. `bun/static-server.ts` spins up a `Bun.serve` on a free port, serves files, **injects** `recorder-script` + `runner-script` into HTML responses
4. View's iframe loads the served URL — preview is live + scriptable
5. **Record** posts `{cmd:"start"}` to iframe; recorder script captures click/type/select/nav events with smart selectors (id → data-test* → CSS path) and posts steps back
6. **Run** (replay) iterates flow steps, postMessages `{__scenrun_run, step}` to iframe, runner script executes, posts result back. On screenshot steps the view computes the iframe rect in screen coordinates and asks bun to `screencapture -R` it

### Why no Playwright

Playwright bundles ~600MB of browser binaries per OS. Prisma uses the Electrobun WebKit that already powers the app's UI — same engine, zero extra install. macOS-native `screencapture -R x,y,w,h -t png` gives pixel-perfect captures of any screen rect (you must grant Screen Recording permission once).

### Cross-platform

Currently macOS-only:

- `screencapture` is `/usr/sbin/screencapture` (mac-built-in)
- iconset is `.icns`

Adapt for Win/Linux: replace `screencapture` w/ `import` (ImageMagick) or `gnome-screenshot --area`, swap iconset for `.ico` / `.png`.

## Configuration

### Devices (`samples/devices.yaml`)

```yaml
devices:
  - name: "iPhone 17 Pro"
    category: mobile
    viewport: { width: 402, height: 874 }
    isMobile: true
    hasTouch: true
    deviceScaleFactor: 3
```

Categories: `mobile-small | mobile | mobile-large | foldable-folded | foldable-open | tablet-small | tablet | laptop | desktop | ultrawide | custom`.

The select dropdown auto-groups by category.

### Action types (`src/lib/schemas.ts:ACTION_SPEC`)

`navigate | click | type | select | wait | assert | screenshot | scroll | hover | evaluate`

Single source of truth — drives zod validation, view-side step editor field rendering, and runner-script dispatch.

### Theme

Auto-follows `prefers-color-scheme` on first launch, override stored in `localStorage["prisma:theme"]`. Toggle via `◐` button in header.

## Per-project persistence

When you load a source, Prisma keys it as:

- URL: `url:<the URL>`
- Folder/archive: `path:<absolute path>`

Scenarios + selected device are auto-saved to `localStorage["prisma:project:<key>"]` whenever they change. Loading a previously-seen project restores everything.

## Known limitations

- Cross-origin URL sources whose `X-Frame-Options: DENY` / `frame-ancestors` block iframing won't preview
- Recorder/runner scripts are injected via the local static-server only — for arbitrary URL sources you can navigate but not record/replay (need a same-origin proxy)
- Source-only project archives (Next.js / Vite source) need to be **built first** — the entry detector returns a build-command hint when it sees a `package.json` w/ no built HTML

## License

Proprietary — internal use.
