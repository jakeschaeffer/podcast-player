#!/bin/bash
# Archive Snip, sign it for the App Store and upload it to TestFlight, headless: manual signing with the account's
# Apple Distribution certificate and App Store profiles minted through the API (scripts/asc.mjs): one each for the
# app, its Live Activity and its share extension. Then altool.
#   ios/scripts/testflight.sh
# A second app beside the first, with its own icon name and its own data (the build with no server, to try without
# touching the one in daily use):
#   APP_SUFFIX=SnipSolo APP_DISPLAY_NAME="Snip Solo" NO_SERVER=1 ios/scripts/testflight.sh
# APP_SUFFIX is the last part of the bundle id (default Snip); NO_SERVER=1 names no server, so a fresh install
# opens on Start and keeps everything on the phone. The first run registers the bundle ids, then stops and says how
# to make the app's record in App Store Connect, which only a person can do.
# Your team, org id and App Store Connect key come from scripts/local.env (gitignored; copy local.env.example).
# TestFlight builds expire after 90 days; rerun this to replace one.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f scripts/local.env ] || { echo "error: ios/scripts/local.env is missing; copy scripts/local.env.example and fill it in (docs/SELF-HOSTING.md)" >&2; exit 1; }
set -a; . scripts/local.env; set +a
for v in TEAM_ID ORG_IDENTIFIER ASC_KEY_ID ASC_ISSUER; do
  [ -n "${!v:-}" ] || { echo "error: $v is not set in ios/scripts/local.env" >&2; exit 1; }
done
APP_SUFFIX="${APP_SUFFIX:-Snip}"
APP_DISPLAY_NAME="${APP_DISPLAY_NAME:-Snip}"
APP_BUNDLE_ID="$ORG_IDENTIFIER.$APP_SUFFIX"
EXTENSION_BUNDLE_ID="$APP_BUNDLE_ID.LiveActivity"
SHARE_BUNDLE_ID="$APP_BUNDLE_ID.Share"
export SNIP_BUNDLE_ID="$APP_BUNDLE_ID" SNIP_ASC_KEY_ID="$ASC_KEY_ID" SNIP_ASC_ISSUER="$ASC_ISSUER"

# The bundle ids are registered first: a new app's record can only be made for an id the account already has.
PROFILE=$(node scripts/asc.mjs ensure-profile)
EXTENSION_PROFILE=$(node scripts/asc.mjs ensure-profile "$EXTENSION_BUNDLE_ID")  # the Live Activity widget
SHARE_PROFILE=$(node scripts/asc.mjs ensure-profile "$SHARE_BUNDLE_ID")  # the share sheet extension
node scripts/asc.mjs app >/dev/null  # fails early with instructions when the app record is missing
node scripts/asc.mjs ensure-beta-group >/dev/null  # internal group "Owner": every build reaches your phone
BUILD=$(date -u +%y%m%d%H%M)  # always increasing, which App Store Connect requires
# NO_SERVER=1: the build names no server whatever Local.xcconfig says (a command-line setting wins).
SERVER_SETTING=()
if [ "${NO_SERVER:-}" = 1 ]; then SERVER_SETTING=("PODCAST_SERVER_URL="); fi
OUT="${TMPDIR:-/tmp}/snip-testflight-$BUILD"
mkdir -p "$OUT"

echo "==> Archiving build $BUILD"
xcodebuild archive \
  -project Snip.xcodeproj -scheme Snip -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/Snip.xcarchive" \
  CURRENT_PROJECT_VERSION="$BUILD" DEVELOPMENT_TEAM="$TEAM_ID" ORG_IDENTIFIER="$ORG_IDENTIFIER" \
  APP_SUFFIX="$APP_SUFFIX" APP_DISPLAY_NAME="$APP_DISPLAY_NAME" ${SERVER_SETTING[@]+"${SERVER_SETTING[@]}"} \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Apple Distribution" \
  SNIP_APP_PROFILE="$PROFILE" SNIP_EXTENSION_PROFILE="$EXTENSION_PROFILE" SNIP_SHARE_PROFILE="$SHARE_PROFILE" \
  -quiet

cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict>
    <key>$APP_BUNDLE_ID</key><string>$PROFILE</string>
    <key>$EXTENSION_BUNDLE_ID</key><string>$EXTENSION_PROFILE</string>
    <key>$SHARE_BUNDLE_ID</key><string>$SHARE_PROFILE</string>
  </dict>
  <key>uploadSymbols</key><true/>
</dict></plist>
PLIST

echo "==> Exporting"
xcodebuild -exportArchive -archivePath "$OUT/Snip.xcarchive" -exportPath "$OUT" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" -quiet

echo "==> Uploading"
xcrun altool --upload-app -f "$OUT/Snip.ipa" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER"
echo "OK: build $BUILD uploaded; it shows in TestFlight once App Store Connect finishes processing"
