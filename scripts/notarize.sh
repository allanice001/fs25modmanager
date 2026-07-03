#!/usr/bin/env bash
#
# Notarize the already-built, signed .app/.dmg with Apple, then staple the
# ticket so it opens cleanly on any Mac (no right-click → Open dance).
#
# Reads credentials from a local .env (gitignored):
#   APP_EMAIL=your@appleid.com
#   APP_PASSWORD=xxxx-xxxx-xxxx-xxxx      # app-specific pw from appleid.apple.com
# (falls back to APPLE_ID / APPLE_PASSWORD, or prompts if neither is set).
#
# Usage:  ./scripts/notarize.sh
set -euo pipefail

TEAM_ID="N5K9A8X87V"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/src-tauri/target/release/bundle/macos/fs25modmanager.app"
DMG="$(ls -t "$ROOT"/src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1)"

[ -d "$APP" ] || { echo "No built .app found — run 'pnpm tauri build' first."; exit 1; }
[ -n "${DMG:-}" ] || { echo "No .dmg found — run 'pnpm tauri build' first."; exit 1; }

# Load credentials from .env if present.
if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi
APPLE_ID="${APP_EMAIL:-${APPLE_ID:-}}"
APP_PW="${APP_PASSWORD:-${APPLE_PASSWORD:-}}"
[ -n "$APPLE_ID" ] || read -rp "Apple ID email: " APPLE_ID
[ -n "$APP_PW" ] || { read -rsp "App-specific password: " APP_PW; echo; }

echo "Submitting $(basename "$DMG") to Apple as $APPLE_ID (a few minutes)…"
xcrun notarytool submit "$DMG" \
  --apple-id "$APPLE_ID" --team-id "$TEAM_ID" --password "$APP_PW" --wait

echo "Stapling the notarization ticket…"
xcrun stapler staple "$APP"
xcrun stapler staple "$DMG"

echo "Verifying…"
spctl -a -vvv --type install "$DMG" 2>&1 | grep -iE "accepted|source|origin" || true
xcrun stapler validate "$APP" && echo "✅ Notarized + stapled — opens cleanly on any Mac."
