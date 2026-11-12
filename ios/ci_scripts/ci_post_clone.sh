#!/bin/sh
set -eu

: "${CI_PRIMARY_REPOSITORY_PATH:?Xcode Cloud did not provide the checkout path}"
: "${CI_TEAM_ID:?Xcode Cloud did not provide the Apple Developer team ID}"
: "${CI_BUNDLE_ID:?Xcode Cloud did not provide the app bundle ID}"

case "$CI_BUNDLE_ID" in
    ?*.Snip) org_identifier=${CI_BUNDLE_ID%.Snip} ;;
    *) printf '%s\n' 'Select the Snip app as the Xcode Cloud product.' >&2; exit 1 ;;
esac

# Local.xcconfig is ignored by Git. Recreate its signing settings for this checkout.
printf 'DEVELOPMENT_TEAM = %s\nORG_IDENTIFIER = %s\n' "$CI_TEAM_ID" "$org_identifier" \
    > "$CI_PRIMARY_REPOSITORY_PATH/ios/Config/Local.xcconfig"
