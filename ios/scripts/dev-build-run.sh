#!/bin/bash
# Build Snip (iOS) and run it in the simulator. Adapted from audiobooth-fork's script of the same name.
#   ios/scripts/dev-build-run.sh            # build + install + launch
#   ios/scripts/dev-build-run.sh --shot     # ...then write a screenshot
#   SNIP_SIM="iPhone 17" ios/scripts/dev-build-run.sh
set -euo pipefail

cd "$(dirname "$0")/.."

DEVICE="${SNIP_SIM:-iPhone 17 Pro}"
DERIVED="${TMPDIR:-/tmp}/snip-derived"

echo "==> Building Snip for the iOS simulator"
xcodebuild build \
  -project Snip.xcodeproj \
  -scheme Snip \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$DERIVED" \
  -quiet

APP="$DERIVED/Build/Products/Debug-iphonesimulator/Snip.app"
[ -d "$APP" ] || { echo "error: could not locate built Snip.app"; exit 1; }
BUNDLE=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Info.plist")

UDID=$(xcrun simctl list devices available \
  | grep -F "$DEVICE (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
[ -n "$UDID" ] || { echo "error: no available simulator named '$DEVICE'"; exit 1; }

echo "==> Booting $DEVICE ($UDID)"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
open -a Simulator 2>/dev/null || true

echo "==> Installing and launching $BUNDLE"
xcrun simctl install "$UDID" "$APP"
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl launch "$UDID" "$BUNDLE" -muteAudio 1

if [ "${1:-}" = "--shot" ]; then
  OUT="${TMPDIR:-/tmp}/snip-$(date +%H%M%S).png"
  xcrun simctl io "$UDID" screenshot "$OUT"
  echo "screenshot: $OUT"
fi

echo "OK: $BUNDLE running on $DEVICE"
