# Designer onboarding — first day with Unicorn Capture

You just got the DMG. Here's the 10-minute path from zero to your
first PM-reviewable flow.

## 1. Install Capture (1 min)

1. Double-click `Prisma-X.X.X.dmg` → Applications drawer opens.
2. Drag the **Prisma** icon to **Applications**.
3. Open the app from `/Applications`. First run: macOS asks "developer
   cannot be verified" — go to **System Settings → Privacy & Security**
   → click **"Open Anyway"** at the bottom. Confirm again on the next
   launch and that prompt goes away forever.

(Once we notarize, the prompt disappears for everyone.)

## 2. Make sure your customer repo is ready (30 sec)

Capture needs:

- A React Native repo with **Expo Router** at `app/` (auto-detected at
  `app/`, `mobile/app/`, `apps/mobile/app/`, or `src/app/`)
- An iOS Simulator that you can boot (Xcode + a sim runtime)

If you cloned the repo fresh, run `pnpm install` (or `bun install` /
`npm install` — Capture detects from the lockfile).

## 3. Onboard the project in Capture (3 min)

1. In Capture's dashboard, click **`+ Add`**.
2. Pick **Mobile**.
3. **Browse for repo…** → select your customer repo's root folder.
4. **Detect phase**: Capture scans the repo and shows what it found
   (RN layout, package manager, snap-bridge state, etc.). Click
   **Continue** unless you want to override the picked RN dir.
5. **Plan phase**: edit the slug if you want (defaults to your repo's
   folder name, e.g. `ovria`). Paste the platform URL +
   setup token (one-time agency-internal credentials — ask the team).
   Click **Set up**.
6. **Install phase**: 10 steps run with live progress. ~2-3 minutes
   if `pnpm install` is cold. If something fails, the wizard rolls back
   so your repo stays clean.
7. **Verify phase**: Capture auto-spawns Expo (`pnpm exec expo start
   --ios`), waits for the iOS app to handshake, and confirms the
   bridge is connected. The success card has a **"✨ Improve flow
   grouping"** button — copies a Claude-Code-ready prompt to your
   clipboard so you can refine the auto-grouping before snapping.

## 4. Improve the flow grouping (2 min, optional but recommended)

Default groupings are path-based ("Auth", "Profile", …). The improver
turns them into user-journey shapes ("Sign-up & verify", "Booking →
pick → pay → confirm").

1. Click **"Copy improver prompt"** in the Verify card.
2. Open Claude Code in your customer repo (`claude code` from the repo
   root).
3. Paste the prompt → wait for the response → save the suggested
   `snap-flows.ts` over the existing one.
4. **Cmd+R** in the iOS Simulator → snap-bridge re-emits the new
   declaration → Capture sidebar updates within ~1 second.

You only do this once per project (or when you've added a lot of new
routes). The grouping survives across pushes.

## 5. Take your first snap (1 min)

1. With the iOS Simulator open and your app running, click on a screen
   you want to capture.
2. Press **`⌘⇧S`** (or click the **Snap** button in Capture's topbar).
3. The snap appears in the right flow within ~1s.
4. Repeat for as many screens as you want to share.

**Re-snap** the same screen later (after a redesign) — `⌘⇧S` again.
Capture treats it as an update: the new image becomes the latest, the
old one drops into version history (visible in the lightbox).

**Need multiple frames of the same screen?** (long pages, filter
states.) Press **`⌘⇧V`** instead — that creates a new card with the
same route, so you don't lose the original.

**Long page that you want as one image?** Open the snap in the
lightbox → right panel → **Long-page → Enable**. Cmd+R the iOS sim,
re-snap. Now Capture wraps the screen with a `useSnapTarget` ref so
`react-native-view-shot` can capture the full scroll height.

## 6. Push to web (30 sec)

1. Click **Push to web** (or `⌘P`).
2. Optional commit message: "First pass" / "Booking flow done" / etc.
3. Capture uploads everything and gives you a confirmation toast.
4. Share the gallery link with your PM:
   `gallery.unicorn-studio.com/app/<your-slug>`.

The gallery is **replace-mode** — every push is a complete snapshot.
PMs see version history (per build + per frame), comments, and an
"Updated" badge on cards that changed since their last visit.

## Day-N workflow

- **You added new routes**: dashboard card → 🔄 **Refresh** → "Add
  missing routes (recommended)". Capture scans `app/`, adds the new
  routes to a "Recently added" bucket without touching your curated
  groupings. Re-run the improver to fold them into the right flows.
- **You restructured flows by hand**: edit `snap-flows.ts` directly.
  Cmd+R the sim. Capture re-ingests within seconds.
- **You re-designed a screen**: just snap it again. The card flips to
  "Updated" on the gallery for everyone who hasn't seen the new
  version yet.
- **You want to delete a project**: dashboard card → 🗑 **Remove**.
  This archives the project on the gallery (90-day grace) AND drops
  it from your local Capture registry. You can restore from the
  gallery's **Archived projects** view within those 90 days.

## When something goes wrong

- **"Bridge didn't connect"** — Open Doctor mode (🩺 icon on the
  dashboard card). It'll tell you exactly what's missing (version pin,
  layout wiring, etc.) and offer one-click fixes.
- **"My flows look weird after pulling latest"** — improver-refined
  grouping was probably overwritten by `snap-flows-scan`. Run the
  improver button again, paste fresh, save.
- **Capture says "Project archived"** when you push — go to the
  gallery → **Archived projects** → **Restore**. Or in Capture, click
  `+ Add` and pick the same repo: re-onboarding auto-restores.

## Keyboard reference

| Shortcut | Action |
|---|---|
| ⌘⇧S | Snap (replace mode) |
| ⌘⇧V | Snap as variant (new card) |
| ⌘P | Push to web |
| ⌘R | New session |
| ←/→ | Navigate frames in lightbox |
| ↑/↓ | Scrub versions in lightbox |
| Esc | Close lightbox / dialog |
