# Fork attribution

This project is a fork of **Prisma** (`git@git.volcanly.me:du-v2/prisma.git`) by Hulusi's friend, with their permission.

- **Fork point:** commit `6f8fdea8fc186bd1042740f0a488f1d681311ee1`
- **Forked at:** 2026-05-07
- **Forked into:** `@unicorn-studio/capture` (Unicorn Capture)
- **Why:** extending Prisma's web-only macro recorder into an RN/iOS-Simulator-aware snap tool that uploads to the Unicorn Studio gallery platform.

## What we keep from Prisma (lift-as-is or near-as-is)

- `src/lib/store.ts` — pub-sub state container
- `src/lib/ui.ts` theme + UI tokens (re-skinned to Unicorn Studio brand)
- `src/bun/screencapture.ts` — macOS native rect capture
- `samples/devices.yaml` — 60+ device viewport presets
- `electrobun.config.ts` build setup
- `view/` shell (resizable panes, Cmd+C/V/X/Z/A, etc.)
- `lib/schemas.ts` `ACTION_SPEC` + zod superRefine validation pattern (adapted to our snap protocol — fields differ, the *pattern* is lifted)

## What we keep for the web mode

The entire web mode pipeline survives — sources / static-server / recorder-script / runner-script / entry-detector. Web customers will eventually use Unicorn Capture exactly like Prisma users do.

## What we replace / add for the RN mode

- New: Metro WebSocket connector (subscribes to navigation state via the RN dev server).
- New: `@unicorn-studio/snap-bridge` — tiny RN dev-dep installed in customer apps. ~50 LoC, exposes nav state + runtime state hash via Metro.
- New: iOS Simulator window detector (osascript) so `screencapture -R` knows the simulator's screen rect.
- New: cloud upload to the Unicorn Studio gallery platform's `POST /api/snap` intake endpoint.
- New: session manager — auto-grouping snaps into "flow runs" by session id + sequence.
- Replaced: data model. Prisma's `Scenario → Flow → Step` becomes our `Session → Snap`. Different domain.

## What we deliberately do NOT inherit

- Prisma's record-then-replay paradigm. Our model is **manual snap, automatic categorization**. Replay is a possible future feature, not a v0 requirement.
- Prisma's per-project-localStorage-only persistence. Sessions sync to the cloud platform.
