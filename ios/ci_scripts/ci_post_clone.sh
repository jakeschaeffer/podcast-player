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

# xcconfig treats // as a comment. Insert an empty expansion between the slashes.
# Keep the Debug server from Signing.xcconfig for simulator builds.
if [ -n "${PODCAST_SERVER_URL:-}" ]; then
    case "$PODCAST_SERVER_URL" in
        https://*) server_address=${PODCAST_SERVER_URL#https://} ;;
        *) printf '%s\n' 'PODCAST_SERVER_URL must be an HTTPS origin.' >&2; exit 1 ;;
    esac
    case "$server_address" in
        ''|*[!A-Za-z0-9.:-]*) printf '%s\n' 'PODCAST_SERVER_URL must contain only a host and optional port after https://.' >&2; exit 1 ;;
    esac
    printf 'PODCAST_SERVER_URL[config=Release] = https:/$()/%s\n' "$server_address" \
        >> "$CI_PRIMARY_REPOSITORY_PATH/ios/Config/Local.xcconfig"
fi
