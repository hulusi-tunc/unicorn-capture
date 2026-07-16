#!/bin/bash
# Publish a freshly-built release to the static host.
#
# Reads `.env.build` for credentials + the publish target. Two flavors:
#
#   1. PUBLISH_RSYNC_DEST  — anything `rsync` can write to, e.g.
#      "user@host:/var/www/capture-releases/" or a local path that's
#      synced separately.
#
#   2. PUBLISH_S3_BUCKET   — S3-compatible bucket (Cloudflare R2, AWS S3,
#      Vercel Blob via s3 endpoint). Requires `aws` CLI + standard
#      AWS_* env vars (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
#      optional AWS_ENDPOINT_URL_S3 for non-AWS).
#
#   3. PUBLISH_VERCEL=1    — static deploy to a Vercel project via the
#      `vercel` CLI. One-time `cd release-host && vercel link` first.
#
# Pick one and uncomment the matching block below. The script copies
# everything in artifacts/ — DMG + .app.tar.zst + update.json — to
# the same path layout the running app expects from `release.baseUrl`.

set -euo pipefail

cd "$(dirname "$0")/.."

# Load .env.build if present (codesign + publish creds).
if [ -f .env.build ]; then
  set -a
  source .env.build
  set +a
fi

CHANNEL="${1:-canary}"
ARTIFACTS_DIR="artifacts"

if [ ! -d "$ARTIFACTS_DIR" ] || [ -z "$(ls -A "$ARTIFACTS_DIR")" ]; then
  echo "✗ No artifacts to publish. Run: bun run build:${CHANNEL}"
  exit 1
fi

echo "→ Publishing artifacts/ to ${CHANNEL} channel"
ls -lah "$ARTIFACTS_DIR" | tail -n +2

# ── Option 1: rsync (works for any SSH-reachable host or shared folder) ──
if [ -n "${PUBLISH_RSYNC_DEST:-}" ]; then
  echo "  → rsync to $PUBLISH_RSYNC_DEST"
  rsync -avz --progress "$ARTIFACTS_DIR/" "$PUBLISH_RSYNC_DEST/"
  echo "✓ Published via rsync"
  exit 0
fi

# ── Option 2: S3 (AWS / R2 / Backblaze) ──
if [ -n "${PUBLISH_S3_BUCKET:-}" ]; then
  if ! command -v aws &> /dev/null; then
    echo "✗ aws CLI not found — install it or use rsync mode."
    exit 1
  fi
  echo "  → aws s3 sync to s3://$PUBLISH_S3_BUCKET/"
  aws s3 sync "$ARTIFACTS_DIR/" "s3://$PUBLISH_S3_BUCKET/" \
    --acl public-read \
    --cache-control "max-age=300, public"
  echo "✓ Published via S3"
  exit 0
fi

# ── Option 3: Vercel static deploy (uses the `vercel` CLI) ──
# One-time setup: `cd release-host && vercel link` to create/link the project,
# then copy its production URL into ELECTROBUN_RELEASE_BASE_URL in .env.build.
# After that this block redeploys the artifacts on every release.
if [ "${PUBLISH_VERCEL:-}" = "1" ]; then
  if ! command -v vercel &> /dev/null; then
    echo "✗ vercel CLI not found — run: bun add -g vercel"
    exit 1
  fi
  HOST_DIR="release-host"
  mkdir -p "$HOST_DIR"
  # Cache policy: the *-update.json manifests must always be re-fetched so the
  # app notices new versions immediately; the heavy binaries can cache briefly.
  cat > "$HOST_DIR/vercel.json" <<'JSON'
{
  "headers": [
    { "source": "/(.*)-update.json", "headers": [{ "key": "Cache-Control", "value": "public, max-age=0, must-revalidate" }] },
    { "source": "/(.*).(dmg|zst)",   "headers": [{ "key": "Cache-Control", "value": "public, max-age=300" }] }
  ]
}
JSON
  cp "$ARTIFACTS_DIR"/* "$HOST_DIR/"
  echo "  → vercel deploy --prod (from $HOST_DIR/)"
  ( cd "$HOST_DIR" && vercel deploy --prod --yes ${VERCEL_TOKEN:+--token "$VERCEL_TOKEN"} )
  echo "✓ Published via Vercel"
  exit 0
fi

echo "✗ No publish target configured."
echo ""
echo "Set ONE of these in .env.build:"
echo "  PUBLISH_RSYNC_DEST=\"user@host:/var/www/capture-releases\""
echo "  PUBLISH_S3_BUCKET=\"unicorn-capture-releases\""
echo ""
echo "Then point ELECTROBUN_RELEASE_BASE_URL at the public-facing URL"
echo "in .env.build so future builds get auto-update enabled."
exit 1
